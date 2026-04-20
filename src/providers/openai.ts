import OpenAI from 'openai';
import { z } from 'zod';

import type {
  AssistantMessage,
  Message,
  StopReason,
  StreamEvent,
  TextBlock,
  ToolUse,
  Usage,
} from '../types';
import { ProviderProtocolError } from '../types';
import type { Tool } from '../Tool';
import { resolveBaseURL, type LLMProvider } from './index';

const DEFAULT_MODEL = 'gpt-5.4';
/** Used when no OPENAI_API_KEY is set — see anthropic.ts for rationale. */
const PLACEHOLDER_API_KEY = 'mini-cc-placeholder';

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * openai SDK adapter. ALL OpenAI-specific types live in this file.
 *
 * Streaming assembly: OpenAI emits `delta.content` (text chunk) and
 * `delta.tool_calls[].function.arguments` (chunks of a stringified JSON).
 * We accumulate per-index tool-call state, parse arguments at stream end,
 * and emit one atomic `message_complete`. If arguments fail JSON.parse
 * we raise ProviderProtocolError so the loop can drop the turn rather
 * than invent a tool result.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  public readonly model: string;

  constructor(opts: OpenAIProviderOptions = {}) {
    const apiKey =
      opts.apiKey ?? process.env['OPENAI_API_KEY'] ?? PLACEHOLDER_API_KEY;
    // OpenAI's baseURL convention includes the API-version prefix (e.g.
    // https://api.openai.com/v1); Anthropic's doesn't. MINI_CC_BASE_URL
    // follows the Anthropic shape (host only), so we append /v1 here when
    // the caller's URL doesn't already carry a /vN segment.
    const baseURL = ensureVersionPrefix(resolveBaseURL(opts.baseURL));
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = opts.model ?? process.env['MINI_CC_MODEL'] ?? DEFAULT_MODEL;
  }

  async *sampleStream(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const oaiMessages = toOpenAIMessages(messages, systemPrompt);
    const oaiTools = tools.map(toolToOpenAI);

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: oaiMessages,
        ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let textBuffer = '';
    const toolAccum = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();
    let stopReason: StopReason = 'stop';
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice) {
        const delta = choice.delta;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          textBuffer += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let state = toolAccum.get(idx);
            if (!state) {
              state = { id: '', name: '', argsJson: '' };
              toolAccum.set(idx, state);
            }
            if (tc.id) state.id = tc.id;
            if (tc.function?.name) state.name = tc.function.name;
            if (tc.function?.arguments) state.argsJson += tc.function.arguments;
          }
        }
        if (choice.finish_reason) {
          stopReason = normalizeOpenAIStopReason(choice.finish_reason);
        }
      }
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    const content: Array<TextBlock | ToolUse> = [];
    if (textBuffer.length > 0) {
      content.push({ type: 'text', text: textBuffer });
    }
    const sortedIndices = [...toolAccum.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const state = toolAccum.get(idx);
      if (!state) continue;
      let input: Record<string, unknown>;
      try {
        input =
          state.argsJson.length > 0
            ? (JSON.parse(state.argsJson) as Record<string, unknown>)
            : {};
      } catch (err) {
        throw new ProviderProtocolError(
          `OpenAI returned tool_call with malformed JSON arguments (tool=${state.name}, id=${state.id}): ${state.argsJson}`,
          err,
        );
      }
      content.push({
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input,
      });
    }

    const assistantMessage: AssistantMessage = { role: 'assistant', content };
    yield { type: 'message_complete', assistantMessage, stopReason, usage };
  }
}

/**
 * Append `/v1` to a URL when its path doesn't already end in a `/vN`
 * version segment. Leaves `https://api.openai.com/v1` and
 * `https://custom.proxy/v2` untouched; turns `http://localhost:8317` into
 * `http://localhost:8317/v1`. Exported for testing.
 */
export function ensureVersionPrefix(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

// ========== Translation helpers (pure functions) ==========

function normalizeOpenAIStopReason(fr: string): StopReason {
  switch (fr) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
}

function toolToOpenAI(tool: Tool): OpenAI.ChatCompletionTool {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  delete schema['$schema'];
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema as OpenAI.FunctionParameters,
    },
  };
}

/**
 * Neutral messages[] → OpenAI ChatCompletionMessageParam[]. System prompt
 * is prepended as a role='system' message (OpenAI's shape). Our role='tool'
 * messages expand into one role='tool' entry per ToolResult (OpenAI requires
 * one per tool_call_id).
 */
function toOpenAIMessages(
  messages: Message[],
  systemPrompt: string,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.content.map((b) => b.text).join('\n\n');
      out.push({ role: 'user', content: text });
    } else if (msg.role === 'assistant') {
      const textBlocks = msg.content.filter(
        (b): b is TextBlock => b.type === 'text',
      );
      const toolUses = msg.content.filter(
        (b): b is ToolUse => b.type === 'tool_use',
      );
      const text = textBlocks.map((b) => b.text).join('\n\n');
      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: 'function' as const,
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: text });
      }
    } else {
      for (const r of msg.content) {
        out.push({
          role: 'tool',
          tool_call_id: r.toolUseId,
          content: r.content,
        });
      }
    }
  }
  return out;
}
