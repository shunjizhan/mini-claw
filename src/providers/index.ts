import type { Message, StreamEvent } from '../types';
import type { Tool } from '../Tool';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

/**
 * Resolve MINI_CC_BASE_URL. Returns `undefined` when no override is set so
 * each SDK falls back to its own official default (api.anthropic.com for
 * Anthropic, api.openai.com/v1 for OpenAI). Set MINI_CC_BASE_URL to point
 * at a local proxy (e.g. http://localhost:8317) when you want to intercept
 * requests.
 */
export function resolveBaseURL(override?: string): string | undefined {
  return override ?? process.env['MINI_CC_BASE_URL'] ?? undefined;
}

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
  /** The resolved model ID in use (after env + default fallback). */
  readonly model: string;

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
 *   MINI_CC_BASE_URL=... (optional; defaults to each SDK's official URL.
 *     Set to http://localhost:8317 or similar to route through a local proxy.)
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
