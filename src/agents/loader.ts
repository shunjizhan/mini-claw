import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import YAML from 'yaml';

/**
 * Ported methodology from real Claude Code's
 * `src/tools/AgentTool/loadAgentsDir.ts` (755 lines — we mirror the core
 * shape with Tier-3-MVP scope) +
 * `src/utils/markdownConfigLoader.ts:113-126` (parseAgentToolsFromFrontmatter).
 *
 * Agent file format (one markdown file per agent — matches real CC's
 * flat-file convention via `loadMarkdownFilesForSubdir('agents', cwd)`):
 *
 *   ./.mini-cc/agents/{agent-type}.md     (project-level, higher priority)
 *   ~/.mini-cc/agents/{agent-type}.md     (user-level)
 *
 * The filename (stem) is the `agentType` — the same string the parent agent
 * passes via `Agent({ subagent_type: "..." })`. Frontmatter:
 *
 *   ---
 *   description: When the user asks to ...
 *   tools: [Read, Glob, Grep]   # optional; missing or '*' = all parent tools
 *   ---
 *   You are an agent that does X.
 *
 *   <body becomes the child's system prompt>
 *
 * First-wins dedup across priority levels — project beats user (matches real
 * CC's `getActiveAgentsFromList` ordering at `loadAgentsDir.ts:193-227`).
 *
 * We deliberately skip: built-in agents (general-purpose, Explore, Plan),
 * plugins, MCP servers, hooks, color, effort, permissionMode, maxTurns,
 * background/async, isolation/worktree, requiredMcpServers, memory snapshot,
 * skill preloading, fork-subagent, model overrides — all Tier-2/Tier-3+
 * features that don't change the core spawn-child-and-extract-text flow.
 *
 * The methodology we preserve is the directory walk + frontmatter parse +
 * tools allowlist resolution + isolated-child-context spawn pattern.
 */

/** Parsed representation of one discoverable agent. */
export interface AgentDefinition {
  /**
   * Slug used in `Agent({ subagent_type: "..." })`. Comes from the filename
   * (stem) — `explorer.md` → `agentType: 'explorer'`. Mirrors real CC's
   * `loadAgentsDir.ts:106-108` where the parsed key drives the public name.
   */
  agentType: string;
  /**
   * Short "when to use" description. Frontmatter `description` field.
   * Surfaced in the parent's system prompt + Agent-tool description so the
   * model picks the right `subagent_type`.
   */
  whenToUse: string;
  /**
   * Tool allowlist. `undefined` or `['*']` → child gets the parent's full
   * tool pool (minus the Agent tool itself, to prevent recursion). Otherwise
   * the child's tool pool is restricted to the named tools. Mirrors real
   * CC's `parseAgentToolsFromFrontmatter` semantics
   * (`markdownConfigLoader.ts:113-126`).
   */
  tools?: string[];
  /**
   * Markdown body — used verbatim as the child's system prompt persona.
   * Matches real CC's `getSystemPrompt()` closure pattern in
   * `loadAgentsDir.ts:147` (CustomAgentDefinition).
   */
  prompt: string;
  /** Where the agent was loaded from. */
  source: 'project' | 'user';
  /** Absolute path to the agent file. */
  filePath: string;
}

export interface LoadAgentsOptions {
  /** Directory the REPL was started in — project-level agents root. */
  cwd: string;
  /**
   * Override the user-level agents root. Defaults to `~/.mini-cc/agents`.
   * Primarily exists for tests.
   */
  userAgentsDir?: string;
}

// Mirror of real CC's `FRONTMATTER_REGEX` at
// `../claude-code/src/utils/frontmatterParser.ts:123`. Note this differs
// slightly from the regex used in `src/skills/loader.ts:60` (which requires
// a `\n` before the closing `---`, so it fails to detect empty frontmatter
// like `---\n---\n`). The agents loader uses real CC's exact pattern; an
// alignment pass on the skills loader is out of scope for this slice.
const FRONTMATTER_FENCE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * Walk project + user agent dirs and return deduplicated agents in priority
 * order. First-wins: a project agent named `foo` hides a user agent named
 * `foo`. Missing directories are not an error — agent files are opt-in.
 */
export async function loadAgents(
  opts: LoadAgentsOptions,
): Promise<AgentDefinition[]> {
  const projectRoot = path.join(opts.cwd, '.mini-cc', 'agents');
  const userRoot =
    opts.userAgentsDir ?? path.join(os.homedir(), '.mini-cc', 'agents');

  const projectAgents = await readAgentsFromRoot(projectRoot, 'project');
  const userAgents = await readAgentsFromRoot(userRoot, 'user');

  const byType = new Map<string, AgentDefinition>();
  for (const agent of [...projectAgents, ...userAgents]) {
    if (!byType.has(agent.agentType)) {
      byType.set(agent.agentType, agent);
    }
  }
  // Stable alphabetical order — keeps the system-prompt listing deterministic
  // between runs, which matters for prompt caching.
  return [...byType.values()].sort((a, b) =>
    a.agentType.localeCompare(b.agentType),
  );
}

async function readAgentsFromRoot(
  root: string,
  source: 'project' | 'user',
): Promise<AgentDefinition[]> {
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(root, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const raw = await Bun.file(filePath).text();
    const stem = entry.slice(0, -'.md'.length);
    const parsed = parseAgentFile(raw, stem);
    if (!parsed) continue;
    agents.push({ ...parsed, source, filePath });
  }
  return agents;
}

/**
 * Exported for tests. Parses a raw agent markdown file into an
 * `AgentDefinition` (sans `source`/`filePath`). Returns `null` when the file
 * has no usable description AND no usable body — those are silently skipped
 * rather than surfaced as broken agents.
 */
export function parseAgentFile(
  raw: string,
  stem: string,
): Omit<AgentDefinition, 'source' | 'filePath'> | null {
  const match = raw.match(FRONTMATTER_FENCE);
  const fm = match ? parseFrontmatter(match[1] ?? '') : {};
  const body = (match ? raw.slice(match[0].length) : raw).trim();

  const whenToUse =
    typeof fm['description'] === 'string' && fm['description'].length > 0
      ? fm['description']
      : firstNonEmptyMarkdownLine(body);
  if (!whenToUse) return null;
  if (body.length === 0) return null;

  const tools = parseAgentTools(fm['tools']);

  return { agentType: stem, whenToUse, tools, prompt: body };
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
 * Mirrors real CC's `parseAgentToolsFromFrontmatter`
 * (`markdownConfigLoader.ts:113-126`):
 *
 *   - missing field          → undefined (= all parent tools)
 *   - `'*'` or `['*']`       → undefined (= all parent tools)
 *   - `[Read, Write]`        → ['Read', 'Write']
 *   - `'Read, Write'`        → ['Read', 'Write']  (comma-separated string)
 *   - empty array / string   → []                 (no tools)
 */
export function parseAgentTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const list = value
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length === 1 && list[0] === '*') return undefined;
    return list;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '*') return undefined;
    if (trimmed.length === 0) return [];
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

/**
 * Fallback for the `description` field: walk the body top-to-bottom and
 * return the first non-empty line that isn't a Markdown heading. Mirrors
 * real CC's auto-extraction pattern (same one used by skills loader at
 * `src/skills/loader.ts:156-163`).
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
