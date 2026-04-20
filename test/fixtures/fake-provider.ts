import type { LLMProvider } from '../../src/providers/index';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Usage,
} from '../../src/types';
import type { Tool } from '../../src/Tool';

/**
 * Scripted fake LLMProvider for unit tests. Each entry in `scripts` is one
 * sample call's worth of events — the provider pops the next script on each
 * sampleStream() invocation. Captures inputs so tests can assert what the
 * engine sent.
 */
export class FakeProvider implements LLMProvider {
  private callCount = 0;
  public readonly capturedMessages: Message[][] = [];
  public readonly capturedTools: Tool[][] = [];
  public readonly capturedSystemPrompts: string[] = [];

  constructor(private readonly scripts: StreamEvent[][]) {}

  async *sampleStream(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const script = this.scripts[this.callCount++];
    this.capturedMessages.push(messages.map((m) => structuredClone(m)));
    this.capturedTools.push([...tools]);
    this.capturedSystemPrompts.push(systemPrompt);
    if (!script) {
      throw new Error(
        `FakeProvider: no script for call #${this.callCount} (only ${this.scripts.length} scripted)`,
      );
    }
    for (const event of script) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      yield event;
    }
  }
}

/**
 * A provider that emits one text_delta then throws AbortError — useful for
 * testing the QueryEngine's abort atomicity.
 */
export class AbortingProvider implements LLMProvider {
  async *sampleStream(
    _messages: Message[],
    _tools: Tool[],
    _systemPrompt: string,
    _signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    yield { type: 'text_delta', text: 'partial' };
    throw new DOMException('Aborted', 'AbortError');
  }
}

const DEFAULT_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Script helper: a text-only assistant response. */
export function textOnly(text: string, usage: Usage = DEFAULT_USAGE): StreamEvent[] {
  const assistantMessage: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
  return [
    { type: 'text_delta', text },
    { type: 'message_complete', assistantMessage, stopReason: 'stop', usage },
  ];
}

/** Script helper: an assistant response that includes one or more tool_use blocks. */
export function withToolUse(
  text: string,
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  usage: Usage = DEFAULT_USAGE,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const content: AssistantMessage['content'] = [];
  if (text) {
    events.push({ type: 'text_delta', text });
    content.push({ type: 'text', text });
  }
  for (const tu of toolUses) {
    content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
  }
  events.push({
    type: 'message_complete',
    assistantMessage: { role: 'assistant', content },
    stopReason: 'tool_use',
    usage,
  });
  return events;
}
