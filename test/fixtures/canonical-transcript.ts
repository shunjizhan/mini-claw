import type { Message, ToolUse } from '../../src/types';

/**
 * Assert the canonical transcript invariant from src/types.ts. Throws on
 * violation with a rule-number-prefixed error so the test failure tells
 * you exactly what broke.
 *
 *   1. First message (if any) is role='user'.
 *   2. Alternation: user → assistant → (tool → (user|assistant))* → user → ...
 *      No back-to-back same-role. The `tool → user` continuation is valid
 *      when (and only when) the user message is a synthetic injection
 *      appended by a tool (matches rule 6 in src/types.ts — the Skill tool
 *      injection mechanic, mirroring real CC's newMessages pattern).
 *   3. Assistant messages are non-empty (at least one TextBlock or ToolUse).
 *   4. Tool messages contain only ToolResult blocks.
 *   5. Tool messages correspond 1:1 with their preceding assistant's
 *      tool_use blocks:
 *        - same count
 *        - matching toolUseId in the same order
 *        - assistant with tool_use blocks MUST be followed by a tool message
 *        - tool message MUST be preceded by an assistant with tool_use blocks
 */
export function assertCanonicalTranscript(
  messages: readonly Message[],
): void {
  if (messages.length === 0) return;

  // Rule 1
  const first = messages[0]!;
  if (first.role !== 'user') {
    throw new Error(
      `canonical transcript: rule 1 — first message role is '${first.role}', expected 'user'`,
    );
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const prev = i > 0 ? messages[i - 1]! : null;
    const next = i + 1 < messages.length ? messages[i + 1]! : null;

    // Rule 2 — alternation
    if (prev !== null) {
      if (
        msg.role === 'user' &&
        prev.role !== 'assistant' &&
        prev.role !== 'tool'
      ) {
        throw new Error(
          `canonical transcript: rule 2 — user at index ${i} follows ${prev.role} (must follow assistant or tool)`,
        );
      }
      if (msg.role === 'assistant' && prev.role === 'assistant') {
        throw new Error(
          `canonical transcript: rule 2 — assistant at index ${i} follows assistant`,
        );
      }
      if (msg.role === 'tool' && prev.role !== 'assistant') {
        throw new Error(
          `canonical transcript: rule 2 — tool at index ${i} follows ${prev.role} (must follow assistant)`,
        );
      }
    }

    // Rule 3 — assistant non-empty
    if (msg.role === 'assistant' && msg.content.length === 0) {
      throw new Error(
        `canonical transcript: rule 3 — assistant at index ${i} is empty`,
      );
    }

    // Rule 4 — tool messages contain only tool_result blocks
    if (msg.role === 'tool') {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]!;
        if (block.type !== 'tool_result') {
          throw new Error(
            `canonical transcript: rule 4 — tool at index ${i}.${j} contains block of type '${(block as { type: string }).type}', expected 'tool_result'`,
          );
        }
      }
    }

    // Rule 5 — assistant/tool pairing (checked from the assistant side)
    if (msg.role === 'assistant') {
      const toolUses = msg.content.filter(
        (b): b is ToolUse => b.type === 'tool_use',
      );
      if (toolUses.length > 0) {
        if (next === null || next.role !== 'tool') {
          throw new Error(
            `canonical transcript: rule 5 — assistant at index ${i} has ${toolUses.length} tool_use(s) but is not followed by a tool message`,
          );
        }
        if (next.content.length !== toolUses.length) {
          throw new Error(
            `canonical transcript: rule 5 — assistant at index ${i} has ${toolUses.length} tool_use(s) but following tool message has ${next.content.length} tool_result(s)`,
          );
        }
        for (let j = 0; j < toolUses.length; j++) {
          const expected = toolUses[j]!.id;
          const actual = next.content[j]!.toolUseId;
          if (actual !== expected) {
            throw new Error(
              `canonical transcript: rule 5 — tool_result at index ${i + 1}.${j} has toolUseId '${actual}', expected '${expected}' to match tool_use at index ${i}.${j}`,
            );
          }
        }
      } else if (next !== null && next.role === 'tool') {
        throw new Error(
          `canonical transcript: rule 5 — assistant at index ${i} has no tool_use blocks but is followed by a tool message`,
        );
      }
    }
  }
}
