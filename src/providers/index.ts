import type { Message, StreamEvent } from '../types';
import type { Tool } from '../Tool';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

/**
 * Default API base URL for both providers. Points at a local proxy; set
 * MINI_CC_BASE_URL to override (e.g. https://api.anthropic.com for direct
 * access).
 */
export const DEFAULT_BASE_URL = 'http://localhost:8317';

/** Resolve MINI_CC_BASE_URL with the localhost default. */
export function resolveBaseURL(override?: string): string {
  return override ?? process.env['MINI_CC_BASE_URL'] ?? DEFAULT_BASE_URL;
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
 *   MINI_CC_BASE_URL=... (default http://localhost:8317 — point at a local
 *     proxy; set to https://api.anthropic.com or https://api.openai.com/v1
 *     for direct access)
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
