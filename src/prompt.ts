import type { Tool } from './Tool';

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
}

/**
 * Assemble the system prompt sent to the provider.
 *
 * Layout:
 *   1. Base instruction (agent persona + rules)
 *   2. Tool reference (name + description per tool)
 *   3. Environment (cwd)
 *   4. Optional memory block (CLAUDE.md content, if present)
 *
 * Providers translate this differently: Anthropic puts it in the top-level
 * `system` field; OpenAI prepends a role='system' message. The assembly
 * itself is provider-agnostic — pure text.
 */
export function assembleSystemPrompt(
  opts: AssembleSystemPromptOptions,
): string {
  const parts: string[] = [BASE_INSTRUCTION];

  parts.push('', '# Tools', formatTools(opts.tools));
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
 * Read an optional CLAUDE.md from the given directory. Returns undefined if
 * no file exists (silent miss is fine — memory is optional).
 */
export async function loadMemory(cwd: string): Promise<string | undefined> {
  const file = Bun.file(`${cwd}/CLAUDE.md`);
  if (!(await file.exists())) return undefined;
  return await file.text();
}
