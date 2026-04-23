import { z } from 'zod';

import { buildTool } from '../Tool';
import type { ToolCallResult } from '../Tool';
import { render, type Skill } from '../skills/loader';

const SkillInput = z.object({
  skill: z.string().describe('The name of a skill from the available-skills list. Do not guess names.'),
  args: z
    .string()
    .optional()
    .describe(
      'Optional arguments passed to the skill. Substituted into the skill body wherever $ARGUMENTS appears.',
    ),
});

/**
 * The `Skill` tool. Ported from real Claude Code's single-tool pattern in
 * `src/tools/SkillTool/SkillTool.ts:291–298`. The model invokes
 * `Skill(skill="write-hello", args="world")`; this tool resolves the skill,
 * substitutes `$ARGUMENTS`, and returns:
 *
 *   1. A short ToolResult string ("Launching skill: {name}") — mirrors real
 *      CC's `toolExecution.ts:1566` pattern and keeps Anthropic's 1:1
 *      tool_use/tool_result correspondence intact.
 *
 *   2. A `newMessages`-style injection (our `ToolInjection[]`) carrying the
 *      skill's rendered body. The engine appends it as a `role='user'`
 *      message AFTER the ToolMessage so the next model turn reads the
 *      skill instructions inline. System prompt is NEVER mutated — same
 *      reason real CC documents (`SkillTool.ts:735` comments): the `system`
 *      field is a single string, immutable per-conversation, and required
 *      for prompt caching.
 *
 * Deliberately simpler than real CC:
 *   - One tool exposing all skills (not per-skill registration)
 *   - No `context: 'fork'` (subagent execution) — skills run inline only
 *   - No hooks / allowed-tools enforcement / permission prompts
 *   - No shell substitution in the body (security surface — not in scope)
 */
export function buildSkillTool(skills: Skill[]) {
  const skillsByName = new Map(skills.map((s) => [s.name, s]));

  return buildTool({
    name: 'Skill',
    description: buildSkillToolDescription(skills),
    inputSchema: SkillInput,
    isReadOnly: true,
    isConcurrencySafe: false,
    async call(input): Promise<ToolCallResult> {
      const skill = skillsByName.get(input.skill);
      if (!skill) {
        const available = [...skillsByName.keys()].join(', ') || '(none)';
        throw new Error(
          `Unknown skill: ${input.skill}. Available skills: ${available}`,
        );
      }
      const body = render(skill, input.args ?? '');
      return {
        content: `Launching skill: ${skill.name}`,
        injections: [{ role: 'user', text: body }],
      };
    },
  });
}

/**
 * Static part of the Skill tool's description — the listing of available
 * skills itself lives in the system prompt (see src/prompt.ts). We keep
 * this copy short and focused on HOW to invoke; skill names appear in the
 * system prompt so the model discovers them there.
 *
 * Wording echoes real CC's `prompt.ts:173–195` — the key invariant:
 * "Available skills are listed in system-reminder messages."
 */
function buildSkillToolDescription(skills: Skill[]): string {
  const count = skills.length;
  const base = `Execute a skill within the current conversation.

Skills are packaged instructions (Markdown) that tell you how to perform a specific task. When a user's request matches an available skill, invoke this tool with the skill's name — do NOT try to do the task without the skill's guidance when one exists.

How to invoke:
- skill: the name of the skill (see the "Available skills" section in the system prompt)
- args: optional string. Wherever the skill body contains $ARGUMENTS, it will be replaced by this value.

After you call Skill, the skill's instructions arrive as a new user message right after the tool_result. Read them and follow them on your next turn.`;
  return count === 0
    ? `${base}\n\n(No skills are currently installed.)`
    : base;
}
