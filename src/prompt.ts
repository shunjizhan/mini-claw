import type { Tool } from './Tool';
import type { Skill } from './skills/loader';
import type { AgentDefinition } from './agents/loader';

const BASE_INSTRUCTION = `You are mini-claw, a concise coding assistant running in a terminal REPL.

Guidelines:
- Prefer using tools over guessing. Read files before editing them.
- Keep responses short. The user sees the raw tool output — don't echo it.
- When a task is done, say so briefly; don't narrate what tools ran.
- If a tool errors, explain what went wrong and either retry with adjusted
  input or ask the user for guidance.
- Absolute paths are preferred for file tools.`;

export interface AssembleSystemPromptOptions {
  tools: Tool[];
  cwd: string;
  /** Optional memory content (e.g. loaded CLAUDE.md). */
  memory?: string | undefined;
  /** Available skills (from src/skills/loader). Listed for model discovery. */
  skills?: Skill[] | undefined;
  /**
   * Available subagent types (from src/agents/loader). Listed so the model
   * knows what `subagent_type` values to pass to the Agent tool. Mirrors
   * real CC's per-agent listing pattern (`AgentTool/prompt.ts:43-46`,
   * `formatAgentLine`).
   */
  agents?: AgentDefinition[] | undefined;
}

/**
 * Assemble the system prompt sent to the provider.
 *
 * Layout:
 *   1. Base instruction (agent persona + rules)
 *   2. Tool reference (name + description per tool)
 *   3. Available skills (if any) — name + description listing. Model
 *      discovers skills here, then invokes them via the `Skill` tool.
 *   4. Environment (cwd)
 *   5. Optional memory block (CLAUDE.md content, if present)
 *
 * Providers translate this differently: Anthropic puts it in the top-level
 * `system` field; OpenAI prepends a role='system' message. The assembly
 * itself is provider-agnostic — pure text.
 *
 * The skills section mirrors real Claude Code's `prompt.ts:70–171`
 * methodology: model sees the skill listing once, at turn 1. Skills are
 * NOT re-injected per-turn; this preserves prompt caching and matches
 * Anthropic's single-string `system` field. When the model decides to use
 * a skill, it calls the Skill tool and the body is appended as a user
 * message after the ToolMessage (see src/QueryEngine.ts).
 */
export function assembleSystemPrompt(
  opts: AssembleSystemPromptOptions,
): string {
  const parts: string[] = [BASE_INSTRUCTION];

  parts.push('', '# Tools', formatTools(opts.tools));

  if (opts.skills && opts.skills.length > 0) {
    parts.push('', '# Available skills', formatSkills(opts.skills));
  }

  if (opts.agents && opts.agents.length > 0) {
    parts.push('', '# Available agents', formatAgents(opts.agents));
  }

  parts.push('', '# Environment', `- cwd: ${opts.cwd}`);

  if (opts.memory && opts.memory.trim().length > 0) {
    parts.push('', '# Project memory (CLAUDE.md)', opts.memory.trim());
  }

  return parts.join('\n');
}

/**
 * Render the tool list as a bulleted reference. Schema details are left to
 * the provider layer (Anthropic and OpenAI see JSON Schema directly) — this
 * is just a human-readable summary the model reads alongside.
 */
export function formatTools(tools: Tool[]): string {
  if (tools.length === 0) return '(no tools available)';
  return tools
    .map((t) => {
      const flags: string[] = [];
      if (t.isReadOnly) flags.push('read-only');
      if (t.isDestructive) flags.push('destructive');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `- **${t.name}**${flagStr}: ${t.description}`;
    })
    .join('\n');
}

/**
 * Render the discovered skills as a bulleted `name: description` list —
 * matches real CC's `formatCommandsWithinBudget()` shape (minus the
 * truncation-by-budget logic, which we skip for Tier 3 MVP).
 *
 * When a skill provides `when_to_use`, append it as a second line for extra
 * context — helps the model pick the right skill when names are ambiguous.
 */
export function formatSkills(skills: Skill[]): string {
  return skills
    .map((s) => {
      const first = `- **${s.name}**: ${s.description}`;
      return s.whenToUse ? `${first}\n  (use when: ${s.whenToUse})` : first;
    })
    .join('\n');
}

/**
 * Render the discovered agents as a bulleted listing. One line per agent:
 * `- agentType: whenToUse` (mirrors real CC's `formatAgentLine` shape from
 * `tools/AgentTool/prompt.ts:43-46`, minus the `(Tools: ...)` suffix —
 * mini-claw doesn't surface the per-agent tool listing in the parent's
 * prompt to keep the cache surface small).
 */
export function formatAgents(agents: AgentDefinition[]): string {
  return agents.map((a) => `- **${a.agentType}**: ${a.whenToUse}`).join('\n');
}

/**
 * Read an optional CLAUDE.md from the given directory. Returns undefined if
 * no file exists (silent miss is fine — memory is optional).
 */
export async function loadMemory(cwd: string): Promise<string | undefined> {
  const file = Bun.file(`${cwd}/CLAUDE.md`);
  if (!(await file.exists())) return undefined;
  return await file.text();
}
