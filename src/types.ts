/**
 * Neutral message / stream types — the wire shape that every provider adapter
 * translates to and from. The core (QueryEngine, Tool, dispatcher) sees ONLY
 * these types. Anthropic and OpenAI specifics never cross this boundary.
 *
 * Canonical transcript invariant (messages[] inside QueryEngine obeys):
 *
 *   1. First element: role='user' (initial prompt). No role='system' in the
 *      array — the system prompt lives outside messages[], passed as argument
 *      to LLMProvider.sampleStream().
 *   2. Strict alternation after the first user message:
 *        user → assistant → (tool → assistant → )* → user → ...
 *   3. An ASSISTANT message contains TextBlock and/or ToolUse blocks — at
 *      least one of the two (no empty assistant messages).
 *   4. A TOOL message contains ONLY ToolResult blocks.
 *   5. 1:1 correspondence: for each ToolUse in an assistant message with
 *      stopReason='tool_use', the immediately-following tool message MUST
 *      contain exactly one ToolResult per ToolUse, matched by toolUseId.
 *      No extras. No gaps.
 *   6. Synthetic injections (Tier 3 skills) are appended as role='user'
 *      TextBlock AFTER the matching tool message — never inline with
 *      tool_result blocks.
 *
 * ATOMICITY: a turn (assistant message + its tool message, if any) lands in
 * messages[] as a unit — or not at all. Mid-stream abort drops the buffered
 * turn rather than saving a partial assistant message. Partial turns in
 * history would break rule 3 (empty assistant messages) or rule 5 (orphan
 * tool_use without matching tool_result).
 */

export type Role = 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUse | ToolResult;

export interface UserMessage {
  role: 'user';
  content: TextBlock[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: Array<TextBlock | ToolUse>;
}

export interface ToolMessage {
  role: 'tool';
  content: ToolResult[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

/**
 * Normalized stop reason. Collapses provider-specific enums:
 *   Anthropic: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
 *   OpenAI:    'stop' | 'tool_calls' | 'length' | 'content_filter'
 *
 * Neutral:
 *   'stop'       — model finished; no further action needed
 *   'tool_use'   — model requested tool calls; dispatcher must run them
 *   'max_tokens' — model hit output token limit
 *   'error'      — provider-side terminal error (adapter may synthesize)
 */
export type StopReason = 'stop' | 'tool_use' | 'max_tokens' | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Events yielded by LLMProvider.sampleStream() to QueryEngine.
 *
 * Adapters assemble tool calls INTERNALLY. The core never sees provider
 * transport details (Anthropic input_json_delta chunks, OpenAI stringified
 * arguments fragments, etc.). When the turn ends the adapter emits one
 * `message_complete` with a fully-assembled AssistantMessage.
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'message_complete';
      assistantMessage: AssistantMessage;
      stopReason: StopReason;
      usage: Usage;
    };

/**
 * Thrown by adapters when the provider returns malformed data we cannot
 * losslessly normalize — e.g. OpenAI `tool_calls[].function.arguments` fails
 * JSON.parse. Distinct from tool errors: the loop drops the entire turn
 * rather than inventing a synthetic ToolResult for a tool call the model
 * never coherently produced.
 */
export class ProviderProtocolError extends Error {
  public override readonly name = 'ProviderProtocolError';
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
