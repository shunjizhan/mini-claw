import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../../src/QueryEngine';
import { DEFAULT_TOOLS } from '../../src/tools/index';
import { selectProvider } from '../../src/providers/index';
import { assembleSystemPrompt } from '../../src/prompt';
import type { StreamEvent } from '../../src/types';

/**
 * Real-API smoke tests. Opt-in via MINI_CC_REAL_API=1 + the right API keys.
 * Skipped by default so `bun test` stays hermetic.
 *
 * Canonical test per the design doc's stopping criteria:
 *   "create hello.txt with content X and print it back to me"
 *
 * We run it against whichever provider is configured via MINI_CC_PROVIDER.
 * To cover BOTH providers, run twice — once per provider.
 */
const SKIP = process.env['MINI_CC_REAL_API'] !== '1';

async function drain(
  gen: AsyncGenerator<StreamEvent, void, unknown>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe.skipIf(SKIP)('e2e: create-and-verify loop', () => {
  test(
    'agent creates hello.txt with expected content via the configured provider',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-e2e-'));
      try {
        const provider = selectProvider();
        const tools = DEFAULT_TOOLS;
        const systemPrompt = assembleSystemPrompt({ tools, cwd });
        const engine = new QueryEngine({ provider, tools, systemPrompt, cwd });

        const prompt = `Create a file named hello.txt in the current working directory (${cwd}) containing exactly the text "hi from mini-claw", then cat it back to confirm.`;

        await drain(engine.submitMessage(prompt));

        const target = join(cwd, 'hello.txt');
        const content = await Bun.file(target).text();
        expect(content).toContain('hi from mini-claw');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
