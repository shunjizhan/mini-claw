import { describe, test, expect } from 'bun:test';
import type { Interface as ReadlineInterface } from 'node:readline';

import { createReadlinePermissionPrompter } from '../src/permissions';

/**
 * Minimal readline double — only needs the `.question()` method the
 * prompter uses. We script the answer for each call.
 */
function makeStubRL(answers: string[]): ReadlineInterface {
  let i = 0;
  return {
    question: (_q: string, cb: (answer: string) => void) => {
      const next = answers[i++] ?? '';
      // Async to mirror real readline.question semantics.
      queueMicrotask(() => cb(next));
    },
  } as unknown as ReadlineInterface;
}

describe('createReadlinePermissionPrompter', () => {
  test('y → allow', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['y']));
    expect(await prompter('run?', 'Bash')).toBe('allow');
  });

  test('empty input (bare Enter) → allow', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['']));
    expect(await prompter('run?', 'Bash')).toBe('allow');
  });

  test('A → allow-always', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['A']));
    expect(await prompter('run?', 'Bash')).toBe('allow-always');
  });

  test('n → deny', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['n']));
    expect(await prompter('run?', 'Bash')).toBe('deny');
  });

  test('unrecognized input → deny (safe default)', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['banana']));
    expect(await prompter('run?', 'Bash')).toBe('deny');
  });

  test('case-insensitive y/Y', async () => {
    const prompter = createReadlinePermissionPrompter(makeStubRL(['Y']));
    expect(await prompter('run?', 'Bash')).toBe('allow');
  });
});
