import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import YAML from 'yaml';

/**
 * Ported methodology from real Claude Code's `src/skills/loadSkillsDir.ts`
 * (1,086 lines — we mirror the core shape with Tier-3-MVP scope).
 *
 * Skill file format (strict, matches real CC's directory-only convention):
 *
 *   ./.mini-cc/skills/{skill-name}/SKILL.md       (project-level, higher priority)
 *   ~/.mini-cc/skills/{skill-name}/SKILL.md       (user-level)
 *
 * SKILL.md is YAML frontmatter followed by a Markdown body. First-wins dedup
 * across priority levels — project beats user (matches real CC's `loadSkillsDir:753–762`).
 *
 * We deliberately skip: plugins, MCP, `context: 'fork'`, hooks, allowed-tools
 * enforcement, conditional paths, sandboxed asset extraction, dynamic
 * discovery, shell command substitution in the body, model/effort overrides,
 * caching.
 *
 * The methodology we preserve is the directory walk + frontmatter parse +
 * `$ARGUMENTS` + `$SKILL_DIR` substitution + injection-as-user-message
 * pattern. Skills can drop helper scripts/data alongside SKILL.md and
 * reference them via `$SKILL_DIR`; execution happens through the normal
 * Bash tool — the loader itself never executes anything.
 */

/** Parsed representation of one discoverable skill. */
export interface Skill {
  /** Unique name (from frontmatter, else the directory name). */
  name: string;
  /** Short description shown in the system-prompt listing. */
  description: string;
  /** Optional longer-form guidance the model can reference. */
  whenToUse?: string;
  /**
   * Raw markdown body (frontmatter stripped). `$ARGUMENTS` remains as a
   * literal placeholder until `render()` substitutes it.
   */
  body: string;
  /** Where the skill was loaded from — useful for debug output. */
  source: 'project' | 'user';
  /** Absolute path to the SKILL.md file. */
  filePath: string;
}

export interface LoadSkillsOptions {
  /** Directory the REPL was started in — project-level skills root. */
  cwd: string;
  /**
   * Override the user-level skills root. Defaults to `~/.mini-cc/skills`.
   * Primarily exists for tests.
   */
  userSkillsDir?: string;
}

const FRONTMATTER_FENCE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/**
 * Walk project + user skill dirs and return deduplicated skills in
 * priority order. First-wins: a project skill named `foo` hides a user
 * skill named `foo`. Missing directories are not an error — Tier 3 skill
 * files are opt-in.
 */
export async function loadSkills(opts: LoadSkillsOptions): Promise<Skill[]> {
  const projectRoot = path.join(opts.cwd, '.mini-cc', 'skills');
  const userRoot =
    opts.userSkillsDir ?? path.join(os.homedir(), '.mini-cc', 'skills');

  const projectSkills = await readSkillsFromRoot(projectRoot, 'project');
  const userSkills = await readSkillsFromRoot(userRoot, 'user');

  const byName = new Map<string, Skill>();
  for (const skill of [...projectSkills, ...userSkills]) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  // Stable alphabetical order — keeps the system-prompt listing deterministic
  // between runs, which matters for prompt caching.
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillsFromRoot(
  root: string,
  source: 'project' | 'user',
): Promise<Skill[]> {
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const filePath = path.join(dir, 'SKILL.md');
    if (!existsSync(filePath)) continue;
    const raw = await Bun.file(filePath).text();
    const parsed = parseSkillFile(raw, entry);
    skills.push({ ...parsed, source, filePath });
  }
  return skills;
}

/** Exported for tests. Parses a raw SKILL.md into `{ name, description, ... }`. */
export function parseSkillFile(
  raw: string,
  dirName: string,
): Omit<Skill, 'source' | 'filePath'> {
  const match = raw.match(FRONTMATTER_FENCE);
  const fm = match ? parseFrontmatter(match[1] ?? '') : {};
  const body = match ? raw.slice(match[0].length) : raw;

  const name = typeof fm['name'] === 'string' && fm['name'].length > 0
    ? fm['name']
    : dirName;
  const whenToUse = typeof fm['when_to_use'] === 'string' ? fm['when_to_use'] : undefined;
  const description =
    typeof fm['description'] === 'string' && fm['description'].length > 0
      ? fm['description']
      : firstNonEmptyMarkdownLine(body) ?? `(no description for ${name})`;

  return { name, description, whenToUse, body };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Fallback for the `description` field: walk the body top-to-bottom and
 * return the first non-empty line that isn't a Markdown heading. Mirrors
 * real CC's auto-extraction (`loadSkillsDir:208–214`).
 */
function firstNonEmptyMarkdownLine(body: string): string | undefined {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    return line;
  }
  return undefined;
}

/**
 * Substitute `$ARGUMENTS` and `$SKILL_DIR` in the skill body.
 *
 * `$ARGUMENTS` is the caller-provided string (mirrors real CC's
 * `loadSkillsDir:349–354` — simple global replace, no escaping). If `args`
 * is empty the placeholder collapses to an empty string.
 *
 * `$SKILL_DIR` resolves to the absolute path of the directory holding
 * SKILL.md. Skills can drop helper scripts/data next to SKILL.md and tell
 * the model to invoke them through Bash, e.g.
 *
 *   bash "$SKILL_DIR/validate.sh" "$ARGUMENTS"
 *
 * The loader never executes anything itself — substitution is text-only,
 * the model decides whether/when to call Bash, and Bash's own permission
 * hook still gates the run.
 */
export function render(skill: Skill, args: string): string {
  const dir = path.dirname(skill.filePath);
  return skill.body
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$SKILL_DIR/g, dir);
}
