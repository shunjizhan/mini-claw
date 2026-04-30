import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../../src/QueryEngine';
import { DEFAULT_TOOLS } from '../../src/tools/index';
import { buildAgentTool } from '../../src/tools/agent';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { assembleSystemPrompt } from '../../src/prompt';
import { loadAgents } from '../../src/agents/loader';
import { assertCanonicalTranscript } from '../fixtures/canonical-transcript';
import type { Tool } from '../../src/Tool';
import type {
  AssistantMessage,
  StreamEvent,
  ToolMessage,
} from '../../src/types';

/**
 * Real-API E2E for the Agent (subagent) tool. Opt-in via MINI_CC_REAL_API=1.
 * Pinned to Anthropic + Haiku 4.5 (matches the other E2Es).
 *
 * What this verifies that the unit tests can't (because they use FakeProvider):
 *   1. The model actually picks the Agent dispatcher when prompted to delegate.
 *   2. The child engine spawns, runs to completion against the real API, and
 *      its final assistant text bubbles back as the parent's tool_result.
 *   3. Parent transcript shape is the *vanilla* tool-call form
 *      `[user, asst(ToolUse Agent), tool, asst]` — NOT the skill-injection
 *      form (no follow-up UserMessage carrying the agent body). This is the
 *      load-bearing contrast called out in the README.
 *   4. The child's intermediate tool_uses do NOT leak into the parent — the
 *      parent's tool_result content is just the child's final text.
 *
 * Test design: a planted sentinel string in a known file, plus a read-only
 * "finder" agent whose persona instructs it to return only the sentinel
 * verbatim. The sentinel hits the parent's final response only if the full
 * spawn → child loop → drainAgent → tool_result chain works end-to-end.
 */
const SKIP = process.env['MINI_CC_REAL_API'] !== '1';
const TEST_MODEL = 'claude-haiku-4-5';
const SENTINEL = 'AGENT_E2E_SENTINEL_42';

async function drain(
  gen: AsyncGenerator<StreamEvent, void, unknown>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

async function setupCwdWithAgent(): Promise<{
  cwd: string;
  targetFile: string;
}> {
  const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-agent-e2e-'));
  const agentDir = join(cwd, '.mini-cc', 'agents');
  mkdirSync(agentDir, { recursive: true });

  // Plant the sentinel in a small file. The agent's job is to read this file
  // and return just the sentinel — proves the child ran and the result chain
  // worked.
  const targetFile = join(cwd, 'data.txt');
  await Bun.write(
    targetFile,
    `noise line one\nmarker: ${SENTINEL}\nnoise line two\n`,
  );

  // Read-only "finder" agent. `tools: [Read]` exercises the filtering path —
  // the child won't have Write/Edit/Bash even though the parent does.
  const AGENT_MD = `---
description: Use to find a sentinel string in a file. Read-only.
tools: [Read]
---

You are a read-only sentinel finder. Your only job is to read the file
mentioned in your task and return the sentinel string it contains.

A sentinel string has the form \`AGENT_E2E_SENTINEL_<N>\` where <N> is digits.

Process:
1. Use the Read tool on the file path in your task.
2. Find the line containing the sentinel.
3. Reply with ONLY the bare sentinel string — no quotes, no commentary,
   no surrounding text. Just the sentinel.

Your single reply IS your final report. The parent agent will read it
verbatim.
`;
  await Bun.write(join(agentDir, 'finder.md'), AGENT_MD);
  return { cwd, targetFile };
}

describe.skipIf(SKIP)(
  `e2e: Agent (subagent) invocation (Anthropic + ${TEST_MODEL})`,
  () => {
    test(
      'parent delegates to subagent, child finds sentinel, parent reports it back; transcript shape is vanilla-tool-call (no skill-style injection)',
      async () => {
        const { cwd, targetFile } = await setupCwdWithAgent();
        try {
          const provider = new AnthropicProvider({ model: TEST_MODEL });
          const agents = await loadAgents({ cwd });
          expect(agents.map((a) => a.agentType)).toEqual(['finder']);

          // Wire the same way main.ts does: DEFAULT_TOOLS + Agent dispatcher.
          // No Skill tool — keeps the surface clean and the assertion that
          // there's no injection unambiguous.
          const tools: Tool[] = [
            ...DEFAULT_TOOLS,
            buildAgentTool(agents, { provider }),
          ];
          const systemPrompt = assembleSystemPrompt({ tools, cwd, agents });
          const engine = new QueryEngine({
            provider,
            tools,
            systemPrompt,
            cwd,
          });

          // Explicit instruction to delegate — Haiku is small and might
          // otherwise just call Read itself. The prompt names the tool, the
          // subagent type, and the file path the child should investigate.
          const prompt = `Use the Agent tool to delegate this work — do NOT call Read yourself. Spawn subagent_type="finder" with this prompt: "find the sentinel in ${targetFile}". After the subagent returns, tell me what the sentinel was.`;
          await drain(engine.submitMessage(prompt));

          // (1) Parent invoked the Agent dispatcher at least once.
          const parentToolUses = engine.messages
            .filter((m): m is AssistantMessage => m.role === 'assistant')
            .flatMap((m) => m.content)
            .filter((b) => b.type === 'tool_use');
          const agentInvocations = parentToolUses.filter(
            (b) => b.name === 'Agent',
          );
          expect(agentInvocations.length).toBeGreaterThan(0);

          // (2) Some Agent tool_result carries the sentinel — proves the
          // child ran, drainAgent extracted its final text, and that text
          // came back as the parent's tool_result content.
          const allToolResults = engine.messages
            .filter((m): m is ToolMessage => m.role === 'tool')
            .flatMap((m) => m.content);
          const sentinelInResult = allToolResults.some((r) =>
            r.content.includes(SENTINEL),
          );
          expect(sentinelInResult).toBe(true);

          // (3) Parent transcript is the *vanilla* tool-call shape, NOT the
          // skill-injection shape. After every Agent tool_result, the next
          // message must be an AssistantMessage (the parent's reply), never a
          // UserMessage (which would indicate skill-style newMessages
          // injection — wrong mechanism for subagents).
          for (let i = 0; i < engine.messages.length; i++) {
            const m = engine.messages[i];
            if (m?.role !== 'tool') continue;
            const carriesAgentResult = m.content.some((r) =>
              r.content.includes(SENTINEL),
            );
            if (!carriesAgentResult) continue;
            const next = engine.messages[i + 1];
            expect(next?.role).toBe('assistant');
          }

          // (4) The child's intermediate work didn't leak. The parent's
          // assistant messages should not contain a tool_use for Read against
          // the planted file — that happened inside the child and was
          // discarded. (Loose: we only check this specific path; the parent
          // could legitimately call Read on an unrelated file as part of its
          // reasoning, though the prompt tells it not to.)
          const parentReadOfTarget = parentToolUses.some(
            (b) =>
              b.name === 'Read' &&
              typeof (b.input as { file_path?: unknown }).file_path ===
                'string' &&
              ((b.input as { file_path: string }).file_path === targetFile ||
                (b.input as { file_path: string }).file_path.endsWith(
                  '/data.txt',
                )),
          );
          expect(parentReadOfTarget).toBe(false);

          // (5) Final assistant text contains the sentinel — proves the
          // parent actually used the tool_result content rather than
          // hallucinating a reply.
          const finalAssistant = engine.messages
            .filter((m): m is AssistantMessage => m.role === 'assistant')
            .at(-1);
          const finalText =
            finalAssistant?.content
              .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text',
              )
              .map((b) => b.text)
              .join('') ?? '';
          expect(finalText).toContain(SENTINEL);

          // (6) Canonical transcript invariant holds — same alternation +
          // 1:1 tool_use/tool_result pairing rules as for any other tool.
          assertCanonicalTranscript(engine.messages);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      180_000,
    );
  },
);
