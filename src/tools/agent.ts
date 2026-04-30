import { z } from 'zod';

import { buildTool } from '../Tool';
import type { Tool, ToolCallResult, ToolContext } from '../Tool';
import type { AgentDefinition } from '../agents/loader';
import { formatTools } from '../prompt';
import type { LLMProvider } from '../providers/index';
import { QueryEngine } from '../QueryEngine';
import type { AssistantMessage, TextBlock } from '../types';

const AGENT_TOOL_NAME = 'Agent';

const AgentInput = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z
    .string()
    .optional()
    .describe('The type of specialized agent to use for this task'),
});

/**
 * The `Agent` tool. Ported from real Claude Code's
 * `src/tools/AgentTool/AgentTool.tsx` — single-tool dispatcher that spawns a
 * fresh agent with isolated context. The model invokes
 * `Agent({ description, prompt, subagent_type })`; this tool resolves the
 * agent definition, filters the parent's tool pool per the agent's
 * allowlist, builds a child `QueryEngine` with its own `messages[]` and a
 * persona-specific system prompt, drains the child to completion, and
 * returns the child's final assistant text as the parent's tool_result
 * content. Mirrors `agentToolUtils.ts:276-356` (finalizeAgentTool).
 *
 * Public name: `'Agent'` — matches `AGENT_TOOL_NAME` in
 * `../claude-code/src/tools/AgentTool/constants.ts:1`.
 *
 * Input schema: `{ description, prompt, subagent_type? }` — matches
 * `AgentTool.tsx:82-87`.
 *
 * Tool filtering for the child: parent's tool pool MINUS the Agent tool
 * itself (no recursion) MINUS anything not in the agent's `tools` allowlist.
 * Mirrors `ALL_AGENT_DISALLOWED_TOOLS` in
 * `../claude-code/src/constants/tools.ts:36-46` (Agent tool excluded for
 * non-ant users) + `resolveAgentTools` in `agentToolUtils.ts:122-216`.
 *
 * Deliberately simpler than real CC — this initial subagent slice skips:
 *   - Built-in agents (general-purpose, Explore, Plan)
 *   - Fork subagents (omit subagent_type to share parent context)
 *   - Worktree / remote isolation
 *   - run_in_background / async lifecycle / SendMessage / TaskOutput
 *   - Per-agent model overrides (child uses parent's provider+model)
 *   - Per-agent permissionMode / effort / maxTurns
 *   - Recursion (sub-subagents) — deliberately blocked, matches default
 *   - Abort propagation from parent context (parent abort doesn't currently
 *     cancel a running child mid-call; documented divergence)
 */
export interface AgentToolDeps {
  /** The provider used for the parent session — child uses the same one. */
  provider: LLMProvider;
  /** Optional CLAUDE.md memory passed through to the child. */
  memory?: string | undefined;
}

export function buildAgentTool(
  agents: AgentDefinition[],
  deps: AgentToolDeps,
): Tool {
  const agentsByType = new Map(agents.map((a) => [a.agentType, a]));

  return buildTool({
    name: AGENT_TOOL_NAME,
    description: buildAgentToolDescription(agents),
    inputSchema: AgentInput,
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(input, ctx): Promise<ToolCallResult> {
      const agent = resolveAgent(input.subagent_type, agents, agentsByType);

      // Read the parent's full tool pool from ctx — mirrors real CC's
      // `toolUseContext.options.tools` access at AgentTool.tsx:627. This is
      // populated fresh per turn by QueryEngine, so by call-time the pool
      // already includes the Agent tool itself; resolveChildTools strips it.
      const childTools = resolveChildTools(ctx.tools, agent);

      const childSystemPrompt = assembleChildSystemPrompt({
        agent,
        tools: childTools,
        cwd: ctx.cwd,
        memory: deps.memory,
      });

      const child = new QueryEngine({
        provider: deps.provider,
        tools: childTools,
        systemPrompt: childSystemPrompt,
        cwd: ctx.cwd,
        // No permissionPrompter: child runs autonomously — destructive tools
        // that ask interactively would deadlock. Real CC uses
        // shouldAvoidPermissionPrompts for this (runAgent.ts:440-451).
      });

      // Wire the parent's per-turn AbortSignal into the child so a
      // dispatch-level abort cascades. Sync agents in real CC share the
      // parent's AbortController (runAgent.ts:520-528). Best-effort: when
      // the parent ctx aborts mid-child, we abort the child engine; any
      // currently-running tool inside the child still completes.
      const onAbort = (): void => child.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const finalText = await drainAgent(child, input.prompt);
        return { content: finalText };
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  });
}

/**
 * Resolve the requested agent type. Real CC defaults a missing
 * `subagent_type` to the built-in `general-purpose` agent
 * (`AgentTool.tsx:322`). Mini-claw has no built-ins, so:
 *   - 1 agent installed → that one is the implicit default
 *   - >1 agents and no subagent_type → throw with the available list
 *   - subagent_type given but unknown → throw with the available list
 */
function resolveAgent(
  requested: string | undefined,
  agents: AgentDefinition[],
  byType: Map<string, AgentDefinition>,
): AgentDefinition {
  if (requested === undefined) {
    if (agents.length === 1 && agents[0]) return agents[0];
    const list = agents.map((a) => a.agentType).join(', ') || '(none)';
    throw new Error(
      `Agent tool requires \`subagent_type\` when more than one agent is installed. Available: ${list}`,
    );
  }
  const agent = byType.get(requested);
  if (!agent) {
    const list = [...byType.keys()].join(', ') || '(none)';
    throw new Error(
      `Unknown agent type: ${requested}. Available agent types: ${list}`,
    );
  }
  return agent;
}

/**
 * Filter the parent's tool pool down to what the child should see.
 *
 * 1. Drop the Agent tool itself — recursion is disabled for parity with
 *    `ALL_AGENT_DISALLOWED_TOOLS` (`../claude-code/src/constants/tools.ts:41`,
 *    non-ant default).
 * 2. If the agent declares no `tools` (= all-tools wildcard), keep
 *    everything else. Otherwise restrict to the named tools (any name in
 *    the allowlist that doesn't match a parent tool is silently skipped —
 *    matches real CC's `resolveAgentTools` at `agentToolUtils.ts:206-215`,
 *    which splits valid/invalid but proceeds with the valid set).
 */
export function resolveChildTools(
  parentTools: readonly Tool[],
  agent: AgentDefinition,
): Tool[] {
  const noRecursion = parentTools.filter((t) => t.name !== AGENT_TOOL_NAME);
  if (agent.tools === undefined) return noRecursion;
  const allowed = new Set(agent.tools);
  return noRecursion.filter((t) => allowed.has(t.name));
}

/**
 * Build the system prompt for the spawned child. The child does NOT inherit
 * the parent's persona (`BASE_INSTRUCTION` in src/prompt.ts) — that's the
 * mini-claw REPL agent's persona. The child gets its OWN persona from the
 * agent definition body, plus a tool reference and environment block.
 *
 * Mirrors real CC's `getAgentSystemPrompt` (called from
 * `runAgent.ts:511-518`) which returns
 * `agentDefinition.getSystemPrompt() + envDetails` — agent body first, env
 * appended, no parent persona.
 */
export function assembleChildSystemPrompt(opts: {
  agent: AgentDefinition;
  tools: Tool[];
  cwd: string;
  memory?: string | undefined;
}): string {
  const parts: string[] = [opts.agent.prompt.trim()];
  // Reuse the parent's formatTools so the child sees the same read-only /
  // destructive flags the parent does — matches real CC's "same tool
  // reference machinery for parent and child" pattern via getSystemPrompt
  // (runAgent.ts:511-518).
  parts.push('', '# Tools', formatTools(opts.tools));
  parts.push('', '# Environment', `- cwd: ${opts.cwd}`);
  if (opts.memory && opts.memory.trim().length > 0) {
    parts.push('', '# Project memory (CLAUDE.md)', opts.memory.trim());
  }
  return parts.join('\n');
}

/**
 * Drive the child engine to completion and extract the final assistant text.
 *
 * Mirrors `finalizeAgentTool` in `agentToolUtils.ts:297-317`: take the last
 * assistant message's text blocks; if it has no text (e.g. the loop exited
 * mid-tool-use), walk back to the most recent assistant message that DOES
 * have text. We accumulate per turn since `submitMessage()` may run several
 * sample/dispatch iterations.
 */
async function drainAgent(child: QueryEngine, prompt: string): Promise<string> {
  let lastText = '';
  for await (const event of child.submitMessage(prompt)) {
    if (event.type !== 'message_complete') continue;
    const text = extractText(event.assistantMessage);
    if (text.length > 0) lastText = text;
  }
  if (lastText.length === 0) {
    throw new Error('Agent produced no text output');
  }
  return lastText;
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Description for the Agent tool. Intentionally static — the per-agent
 * listing lives in the parent system prompt under `# Available agents`
 * (`src/prompt.ts:64-66`, formatted by `formatAgents`), NOT bundled into
 * the tool description.
 *
 * Documented divergence from real CC: `tools/AgentTool/prompt.ts` does
 * embed the per-agent listing into the tool description via `formatAgentLine`.
 * Mini-claw splits parent-system-prompt and tool-description so the two
 * cache surfaces are independent — the tool-description string only changes
 * when the prose below changes, not when an agent is added or removed.
 */
function buildAgentToolDescription(agents: AgentDefinition[]): string {
  const base = `Spawn a specialized agent to perform a delegated task.
Each agent has its own persona, tool set, and isolated message history — the
agent runs to completion and returns a single text report. Useful for:
  - Investigations that would otherwise pollute your own context with tool
    output you don't need to remember.
  - Tasks that benefit from a different persona or restricted tool set.

How to invoke:
  - description: 3-5 words summarizing the task (shown in UI).
  - prompt: the full directive for the agent. The agent has zero context
    other than its system prompt and this string — so include everything
    relevant: file paths, what was already tried, what the goal is.
  - subagent_type: the agent slug (see "Available agents" in the system
    prompt). Optional only when exactly one agent is installed.

The agent's final text response becomes the tool_result content.`;
  return agents.length === 0
    ? `${base}\n\n(No agents are currently installed.)`
    : base;
}
