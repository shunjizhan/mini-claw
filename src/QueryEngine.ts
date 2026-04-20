import type {
  AssistantMessage,
  Message,
  StopReason,
  StreamEvent,
  ToolResult,
  ToolUse,
  Usage,
} from './types';
import { ProviderProtocolError } from './types';
import type { Tool, ToolContext } from './Tool';
import type { LLMProvider } from './providers/index';

export interface QueryEngineOptions {
  provider: LLMProvider;
  tools: Tool[];
  systemPrompt: string;
  cwd?: string;
}

/**
 * Per-conversation state + agent loop. Mirrors real Claude Code's
 * `src/QueryEngine.ts`: one engine instance per session, `submitMessage()`
 * runs one user turn (possibly many sample/dispatch iterations until the
 * model stops). State (messages, usage) persists across turns.
 *
 * Turn loop (per design doc, "Agent loop" section):
 *   1. Append UserMessage to messages[]
 *   2. provider.sampleStream(...) → yield StreamEvents
 *   3. On message_complete: append AssistantMessage
 *   4. If any ToolUse blocks: dispatch sequentially (buffer-then-dispatch),
 *      append ToolMessage with results, loop
 *   5. Otherwise: return
 *
 * Atomicity (design doc "Abort handling"):
 *   - Abort / ProviderProtocolError / any error → restore messages[] to the
 *     pre-turn snapshot. Never leave a partial turn in history (would break
 *     the canonical transcript invariant — orphan tool_use, empty assistant).
 */
export class QueryEngine {
  private readonly mutableMessages: Message[] = [];
  private readonly totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private readonly provider: LLMProvider;
  private readonly tools: Tool[];
  private readonly systemPrompt: string;
  private readonly cwd: string;
  private abortController: AbortController = new AbortController();

  constructor(opts: QueryEngineOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** Read-only view of the conversation history. */
  get messages(): readonly Message[] {
    return this.mutableMessages;
  }

  /** Accumulated token usage across all turns in this session. */
  get usage(): Readonly<Usage> {
    return this.totalUsage;
  }

  /** External abort (Ctrl+C handler calls this). */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Submit a user message and drive the agent loop until the model stops
   * or the turn aborts/errors. Yields StreamEvents to the caller (REPL)
   * as they arrive from the provider.
   *
   * Tool-call assembly is performed by the provider adapter before the
   * message_complete event fires — this generator never sees provider chunks.
   * Tool dispatch happens *between* sample iterations, silently (no
   * StreamEvent is emitted during dispatch; the REPL infers from
   * message_complete.assistantMessage.content).
   */
  async *submitMessage(
    text: string,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const snapshot = this.mutableMessages.length;
    this.mutableMessages.push({
      role: 'user',
      content: [{ type: 'text', text }],
    });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const ctx: ToolContext = { cwd: this.cwd, signal };

    try {
      while (true) {
        const stream = this.provider.sampleStream(
          this.mutableMessages,
          this.tools,
          this.systemPrompt,
          signal,
        );

        let assistantMessage: AssistantMessage | null = null;
        let stopReason: StopReason = 'stop';
        let turnUsage: Usage | null = null;

        for await (const event of stream) {
          yield event;
          if (event.type === 'message_complete') {
            assistantMessage = event.assistantMessage;
            stopReason = event.stopReason;
            turnUsage = event.usage;
          }
        }

        if (!assistantMessage) {
          throw new ProviderProtocolError(
            'Provider stream ended without a message_complete event',
          );
        }

        this.mutableMessages.push(assistantMessage);
        if (turnUsage) {
          this.totalUsage.inputTokens += turnUsage.inputTokens;
          this.totalUsage.outputTokens += turnUsage.outputTokens;
        }

        const toolUses = assistantMessage.content.filter(
          (b): b is ToolUse => b.type === 'tool_use',
        );

        // Invariant: if tool_use blocks exist, tool_results MUST follow —
        // otherwise next turn violates 1:1 correspondence. Dispatch even if
        // stopReason disagrees (defensive: some models emit tool_use without
        // the matching stop reason).
        if (toolUses.length === 0) {
          if (stopReason === 'tool_use') {
            // Degenerate: claimed tool_use but emitted none. Treat as stop.
          }
          return;
        }

        const toolResults: ToolResult[] = [];
        for (const tu of toolUses) {
          toolResults.push(await this.dispatchTool(tu, ctx));
          if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        }

        this.mutableMessages.push({ role: 'tool', content: toolResults });
      }
    } catch (err) {
      this.mutableMessages.length = snapshot;
      throw err;
    }
  }

  private async dispatchTool(
    tu: ToolUse,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === tu.name);
    if (!tool) {
      const available = this.tools.map((t) => t.name).join(', ');
      return {
        type: 'tool_result',
        toolUseId: tu.id,
        content: `Unknown tool: ${tu.name}. Available tools: ${available}`,
        isError: true,
      };
    }

    const parsed = tool.inputSchema.safeParse(tu.input);
    if (!parsed.success) {
      return {
        type: 'tool_result',
        toolUseId: tu.id,
        content: `Invalid input for ${tu.name}: ${parsed.error.message}`,
        isError: true,
      };
    }

    try {
      const perm = await tool.checkPermissions(parsed.data, ctx);
      if (perm.behavior === 'deny') {
        return {
          type: 'tool_result',
          toolUseId: tu.id,
          content: `Permission denied: ${perm.reason}`,
          isError: true,
        };
      }
      // 'ask' falls through to allow in Tier 1 — Tier 2 will prompt the user
      // on stdin before proceeding.
    } catch (err) {
      return {
        type: 'tool_result',
        toolUseId: tu.id,
        content: `Permission check failed for ${tu.name}: ${errMsg(err)}`,
        isError: true,
      };
    }

    try {
      const output = await tool.call(parsed.data, ctx);
      return { type: 'tool_result', toolUseId: tu.id, content: output };
    } catch (err) {
      if (ctx.signal.aborted || isAbortError(err)) {
        throw err;
      }
      return {
        type: 'tool_result',
        toolUseId: tu.id,
        content: `Tool ${tu.name} failed: ${errMsg(err)}`,
        isError: true,
      };
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message === 'Aborted')
  );
}
