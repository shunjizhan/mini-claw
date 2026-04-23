import type { ToolCallResult } from '../../src/Tool';

/**
 * Narrow a Tool.call() return to the string content. Convenience for tests —
 * production Read/Write/Edit/Bash/Glob/Grep tools return plain strings; only
 * the Skill tool uses the `{ content, injections }` object form.
 */
export function asText(r: ToolCallResult): string {
  return typeof r === 'string' ? r : r.content;
}
