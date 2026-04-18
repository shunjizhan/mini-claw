import type { Message, StreamEvent } from '../types';
import type { Tool } from '../Tool';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

/**
 * The sole provider contract seen by QueryEngine. Adapters translate the
 * neutral message/tool types into provider-native shapes, open a streaming
 * request, and yield StreamEvent — assembling tool_use blocks internally so
 * the core never sees provider transport details.
 *
 * Contract:
 *   - Yields zero or more `text_delta` as tokens arrive
 *   - Yields exactly one `message_complete` at the end of the turn
 *   - Throws on abort (the AbortSignal is wired into the underlying SDK)
 *   - Throws `ProviderProtocolError` for malformed tool-call JSON — the loop
 *     drops the turn rather than inventing a synthetic ToolResult
 *   - Network / rate-limit / auth errors bubble as whatever the SDK raises
 */
export interface LLMProvider {
  sampleStream(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

/**
 * Resolve the active provider from env.
 *   MINI_CC_PROVIDER=anthropic (default) | openai
 *   MINI_CC_MODEL=... (optional override; provider-specific default otherwise)
 */
export function selectProvider(): LLMProvider {
  const name = (process.env['MINI_CC_PROVIDER'] ?? 'anthropic').toLowerCase();
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider();
    default:
      throw new Error(
        `Unknown MINI_CC_PROVIDER="${name}". Use 'anthropic' or 'openai'.`,
      );
  }
}

export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';
