import type { Interface as ReadlineInterface } from 'node:readline';

/**
 * Decision returned by a PermissionPrompter.
 *
 *   'allow'        — run this one tool call; future calls of the same tool
 *                    re-prompt.
 *   'allow-always' — run this tool call AND remember the decision for the
 *                    rest of this session.
 *   'deny'         — skip the call; QueryEngine synthesizes an isError
 *                    ToolResult so the LLM sees a structured refusal.
 */
export type PermissionDecision = 'allow' | 'allow-always' | 'deny';

/**
 * Contract the QueryEngine uses to ask the user for permission. The engine
 * passes a short `prompt` string (constructed by the tool's checkPermissions
 * hook) and a stable `descriptor` (the engine uses `tool.name` today — the
 * prompter itself doesn't interpret it, just displays/logs as helpful).
 *
 * Returning `'deny'` must NOT throw — the engine relies on a clean Promise
 * resolution to synthesize the deny ToolResult.
 */
export type PermissionPrompter = (
  prompt: string,
  descriptor: string,
) => Promise<PermissionDecision>;

/**
 * Build a PermissionPrompter backed by an existing readline.Interface.
 *
 * Why readline.question() instead of raw stdin: the REPL's main loop also
 * owns this readline instance (via `for await (const line of rl)`). Using
 * `rl.question()` integrates with readline's internal state machine so the
 * user's y/A/n answer isn't misrouted into the next prompt and the main
 * loop resumes cleanly once we resolve.
 *
 * Keypress map (first character only, case-insensitive):
 *   y / ⏎        → 'allow'
 *   A            → 'allow-always'
 *   n / anything → 'deny'
 *
 * Rationale for "anything else = deny": the safe default. If the user is
 * confused or mashed a key, refuse the tool rather than run it.
 */
export function createReadlinePermissionPrompter(
  rl: ReadlineInterface,
): PermissionPrompter {
  return (prompt, descriptor) =>
    new Promise<PermissionDecision>((resolve) => {
      const question = `\n${prompt}\n  [y] allow once   [A] allow always for ${descriptor}   [n] deny : `;
      rl.question(question, (raw) => {
        const ans = raw.trim();
        if (ans === '' || /^y/i.test(ans)) {
          resolve('allow');
        } else if (/^A/.test(ans)) {
          resolve('allow-always');
        } else {
          resolve('deny');
        }
      });
    });
}
