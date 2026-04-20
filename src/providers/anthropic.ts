import Anthropic from '@anthropic-ai/sdk';
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

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 8192;
/** Used when no ANTHROPIC_API_KEY is set — lets the client instantiate so the
 *  request can still reach a local proxy that doesn't require auth. The real
 *  Anthropic API will reject this and surface a clean error. */
const PLACEHOLDER_API_KEY = 'mini-cc-placeholder';

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseURL?: string;
}

/**
 * @anthropic-ai/sdk adapter. ALL Anthropic-specific types live in this file;
 * outside of here the rest of the codebase sees only neutral types.
 *
 * Streaming assembly: Anthropic emits text and tool_use content blocks with
 * per-block `index`; text arrives as `text_delta`, tool input arrives as
 * `input_json_delta` chunks of a JSON string. We accumulate per-index state,
 * then emit one atomic `message_complete` with the assembled AssistantMessage
 * at `message_stop`.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  public readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    const apiKey =
      opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? PLACEHOLDER_API_KEY;
    const baseURL = resolveBaseURL(opts.baseURL);
    this.client = new Anthropic({ apiKey, baseURL });
    this.model =
      opts.model ?? process.env['MINI_CC_MODEL'] ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async *sampleStream(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = tools.map(toolToAnthropic);

    const stream = this.client.messages.stream(
      {
        model: this.model,
        system: systemPrompt,
        max_tokens: this.maxTokens,
        messages: anthropicMessages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      },
      { signal },
    );

    type BlockState =
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; partialJson: string };
    const blocks = new Map<number, BlockState>();
    let stopReason: StopReason = 'stop';
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          const u = event.message.usage;
          usage.inputTokens = u.input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const cb = event.content_block;
          if (cb.type === 'text') {
            blocks.set(event.index, { type: 'text', text: '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(event.index, {
              type: 'tool_use',
              id: cb.id,
              name: cb.name,
              partialJson: '',
            });
          }
          break;
        }
        case 'content_block_delta': {
          const state = blocks.get(event.index);
          if (!state) break;
          const delta = event.delta;
          if (delta.type === 'text_delta' && state.type === 'text') {
            state.text += delta.text;
            yield { type: 'text_delta', text: delta.text };
          } else if (
            delta.type === 'input_json_delta' &&
            state.type === 'tool_use'
          ) {
            state.partialJson += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop':
          break;
        case 'message_delta': {
          if (event.delta.stop_reason) {
            stopReason = normalizeAnthropicStopReason(
              event.delta.stop_reason,
            );
          }
          if (event.usage?.output_tokens !== undefined) {
            usage.outputTokens = event.usage.output_tokens;
          }
          break;
        }
        case 'message_stop':
          break;
      }
    }

    const content: Array<TextBlock | ToolUse> = [];
    const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const state = blocks.get(idx);
      if (!state) continue;
      if (state.type === 'text') {
        if (state.text.length > 0) {
          content.push({ type: 'text', text: state.text });
        }
      } else {
        let input: Record<string, unknown>;
        try {
          input =
            state.partialJson.length > 0
              ? (JSON.parse(state.partialJson) as Record<string, unknown>)
              : {};
        } catch (err) {
          throw new ProviderProtocolError(
            `Anthropic returned tool_use with malformed JSON input (tool=${state.name}, id=${state.id}): ${state.partialJson}`,
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
    }

    const assistantMessage: AssistantMessage = { role: 'assistant', content };
    yield { type: 'message_complete', assistantMessage, stopReason, usage };
  }
}

// ========== Translation helpers (pure functions) ==========

function normalizeAnthropicStopReason(sr: string): StopReason {
  switch (sr) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'stop';
  }
}

function toolToAnthropic(tool: Tool): Anthropic.Messages.Tool {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  delete schema['$schema'];
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Messages.Tool['input_schema'],
  };
}

/**
 * Neutral messages[] → Anthropic MessageParam[]. Our role='tool' messages
 * become role='user' messages containing tool_result blocks. Adjacent
 * role='tool' entries collapse into the same user message (rare but valid
 * when Anthropic requires one user message per tool-result batch).
 */
function toAnthropicMessages(
  messages: Message[],
): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: msg.content.map((b) => ({
          type: 'text' as const,
          text: b.text,
        })),
      });
    } else if (msg.role === 'assistant') {
      const content: Anthropic.Messages.ContentBlockParam[] = msg.content.map(
        (b) => {
          if (b.type === 'text') {
            return { type: 'text' as const, text: b.text };
          }
          return {
            type: 'tool_use' as const,
            id: b.id,
            name: b.name,
            input: b.input,
          };
        },
      );
      out.push({ role: 'assistant', content });
    } else {
      const content: Anthropic.Messages.ToolResultBlockParam[] = msg.content.map(
        (r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolUseId,
          content: r.content,
          ...(r.isError ? { is_error: true as const } : {}),
        }),
      );
      out.push({ role: 'user', content });
    }
  }
  return out;
}
