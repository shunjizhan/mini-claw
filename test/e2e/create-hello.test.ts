import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../../src/QueryEngine';
import { DEFAULT_TOOLS } from '../../src/tools/index';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { assembleSystemPrompt } from '../../src/prompt';
import type { AssistantMessage, StreamEvent } from '../../src/types';
import { assertCanonicalTranscript } from '../fixtures/canonical-transcript';

/**
 * Real-API E2E smoke test. Opt-in via MINI_CC_REAL_API=1. Skipped by default
 * so `bun test` stays hermetic.
 *
 * Pinned to Anthropic + Haiku 4.5 regardless of MINI_CC_PROVIDER/MINI_CC_MODEL
 * — fast, cheap, consistent. Still honors ANTHROPIC_API_KEY and
 * MINI_CC_BASE_URL from env so you can route through a local proxy or hit
 * the real API.
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

describe.skipIf(SKIP)(
  `e2e: create-and-verify loop (Anthropic + ${TEST_MODEL})`,
  () => {
    test(
      'agent creates hello.txt: streams text, calls a tool, transcript stays canonical, file lands on disk',
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-e2e-'));
        const target = join(cwd, 'hello.txt');
        try {
          // Pre-condition: verified zero state. mkdtempSync gives a fresh dir
          // so this can't hit — but asserting explicitly turns "trust setup"
          // into evidence, and catches any future path-join bug silently
          // passing because a stale file happened to contain the right text.
          expect(await Bun.file(target).exists()).toBe(false);

          const provider = new AnthropicProvider({ model: TEST_MODEL });
          const tools = DEFAULT_TOOLS;
          const systemPrompt = assembleSystemPrompt({ tools, cwd });
          const engine = new QueryEngine({
            provider,
            tools,
            systemPrompt,
            cwd,
          });

          const prompt = `Create a file named hello.txt in the current working directory (${cwd}) containing exactly the text "hi from mini-claw", then cat it back to confirm.`;

          const events = await drain(engine.submitMessage(prompt));

          // Streaming worked — at least one text token flowed through.
          const textDeltas = events.filter((e) => e.type === 'text_delta');
          expect(textDeltas.length).toBeGreaterThan(0);

          // At least one message_complete; the final one must end the turn
          // cleanly (stopReason='stop', not 'tool_use' or 'error').
          const completes = events.filter(
            (e): e is Extract<StreamEvent, { type: 'message_complete' }> =>
              e.type === 'message_complete',
          );
          expect(completes.length).toBeGreaterThanOrEqual(1);
          expect(completes.at(-1)?.stopReason).toBe('stop');

          // The agent actually called at least one tool. We don't assert
          // *which* tool — Haiku may use Write or Bash, both valid for this
          // task. Asserting "must use Write" would test the model, not us.
          const toolUseCount = engine.messages
            .filter((m): m is AssistantMessage => m.role === 'assistant')
            .flatMap((m) => m.content)
            .filter((b) => b.type === 'tool_use').length;
          expect(toolUseCount).toBeGreaterThan(0);

          // Canonical transcript invariant holds — no orphan tool_uses, no
          // empty assistants, correct alternation, 1:1 tool_use/tool_result
          // pairing. Catches a whole class of adapter / dispatcher bugs.
          assertCanonicalTranscript(engine.messages);

          // Deliverable: file exists with expected content.
          expect(await Bun.file(target).exists()).toBe(true);
          expect(await Bun.file(target).text()).toContain('hi from mini-claw');
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      120_000,
    );
  },
);
