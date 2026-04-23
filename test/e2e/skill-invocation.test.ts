import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../../src/QueryEngine';
import { DEFAULT_TOOLS } from '../../src/tools/index';
import { buildSkillTool } from '../../src/tools/skill';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { assembleSystemPrompt } from '../../src/prompt';
import { loadSkills } from '../../src/skills/loader';
import { assertCanonicalTranscript } from '../fixtures/canonical-transcript';
import type { AssistantMessage, StreamEvent, ToolMessage } from '../../src/types';

/**
 * Real-API E2E for the Skill system. Opt-in via MINI_CC_REAL_API=1. Pinned
 * to Anthropic + Haiku 4.5 (matches the other E2E). The skill under test
 * writes a specific string to a file — that lets us verify that (a) the
 * Skill tool fired, (b) the skill body reached the next model turn via
 * the injection mechanism, and (c) the model followed the injected
 * instructions by calling Write.
 */
const SKIP = process.env['MINI_CC_REAL_API'] !== '1';
const TEST_MODEL = 'claude-haiku-4-5';

async function drain(
  gen: AsyncGenerator<StreamEvent, void, unknown>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

async function setupCwdWithSkill(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-skill-e2e-'));
  const skillDir = join(cwd, '.mini-cc', 'skills', 'write-hello');
  mkdirSync(skillDir, { recursive: true });
  // Intentionally tight instructions — the skill body tells the model
  // exactly what to do, including the magic sentinel string we'll assert
  // on. $ARGUMENTS carries the target path so the skill is reusable.
  const SKILL_MD = `---
name: write-hello
description: Write a fixed greeting to a file path.
when_to_use: The user asks to use the write-hello skill.
---

Use the Write tool to create a file at the absolute path provided in
\`$ARGUMENTS\`. The file must contain exactly this text, nothing more:

SKILL_SENTINEL_OK

Do not call any tool other than Write. After Write succeeds, reply with a
single short confirmation sentence.
`;
  await Bun.write(join(skillDir, 'SKILL.md'), SKILL_MD);
  return cwd;
}

describe.skipIf(SKIP)(
  `e2e: Skill invocation (Anthropic + ${TEST_MODEL})`,
  () => {
    test(
      'model invokes the skill, the body is injected, Write executes, file contains the sentinel',
      async () => {
        const cwd = await setupCwdWithSkill();
        const target = join(cwd, 'hello.txt');
        try {
          expect(await Bun.file(target).exists()).toBe(false);

          const provider = new AnthropicProvider({ model: TEST_MODEL });
          const skills = await loadSkills({ cwd });
          expect(skills.map((s) => s.name)).toEqual(['write-hello']);

          const tools = [...DEFAULT_TOOLS, buildSkillTool(skills)];
          const systemPrompt = assembleSystemPrompt({
            tools,
            cwd,
            skills,
          });
          const engine = new QueryEngine({
            provider,
            tools,
            systemPrompt,
            cwd,
          });

          const prompt = `Use the write-hello skill. Pass "${target}" as the arguments.`;
          await drain(engine.submitMessage(prompt));

          // The model must have invoked the Skill tool at least once.
          const toolUses = engine.messages
            .filter((m): m is AssistantMessage => m.role === 'assistant')
            .flatMap((m) => m.content)
            .filter((b) => b.type === 'tool_use');
          const invokedSkill = toolUses.some((b) => b.name === 'Skill');
          expect(invokedSkill).toBe(true);

          // The ToolMessage right after the Skill tool_use must contain a
          // "Launching skill" marker (sanity — proves our Skill tool's
          // ToolResult shape is intact).
          const skillToolMessages = engine.messages.filter(
            (m): m is ToolMessage =>
              m.role === 'tool' &&
              m.content.some((r) => r.content.includes('Launching skill')),
          );
          expect(skillToolMessages.length).toBeGreaterThan(0);

          // The Write tool must have been called after the injection
          // (otherwise the file wouldn't exist).
          const calledWrite = toolUses.some((b) => b.name === 'Write');
          expect(calledWrite).toBe(true);

          // File landed on disk with exactly the sentinel from SKILL.md.
          expect(await Bun.file(target).exists()).toBe(true);
          const content = await Bun.file(target).text();
          expect(content).toContain('SKILL_SENTINEL_OK');

          // Canonical transcript invariant still holds — including the
          // new `tool → user` continuation from the skill injection.
          assertCanonicalTranscript(engine.messages);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      180_000,
    );
  },
);
