import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { grepTool, __resetRgCacheForTests } from '../../src/tools/grep';
import type { ToolContext } from '../../src/Tool';
import { asText } from '../fixtures/tool-helpers';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

async function rgInstalled(): Promise<boolean> {
  try {
    const p = Bun.spawn({
      cmd: ['rg', '--version'],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

async function setupTree(cwd: string): Promise<void> {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  await Bun.write(
    join(cwd, 'src', 'alpha.ts'),
    'export const alpha = 1;\nconst Beta = 2;\n',
  );
  await Bun.write(
    join(cwd, 'src', 'beta.ts'),
    'export const beta = 2;\nalpha();\n',
  );
  await Bun.write(join(cwd, 'test', 'alpha.test.ts'), 'describe("alpha");\n');
}

const HAVE_RG = await rgInstalled();

describe.skipIf(!HAVE_RG)('grepTool', () => {
  beforeAll(() => {
    __resetRgCacheForTests();
  });

  test('pattern match returns file:line:content entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await setupTree(cwd);
      const out = await grepTool.call({ pattern: 'alpha' }, ctx(cwd));
      expect(out).toContain('alpha.ts');
      expect(out).toContain('beta.ts');
      expect(out).toContain(':1:');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('case_insensitive flag matches across casings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await setupTree(cwd);
      const out = await grepTool.call(
        { pattern: 'beta', case_insensitive: true },
        ctx(cwd),
      );
      // Matches 'beta' and 'Beta'
      expect(asText(out).match(/beta/gi)?.length ?? 0).toBeGreaterThan(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('glob filter scopes which files are searched', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await setupTree(cwd);
      const out = await grepTool.call(
        { pattern: 'alpha', glob: '!*.test.ts' },
        ctx(cwd),
      );
      expect(out).toContain('alpha.ts');
      expect(out).not.toContain('alpha.test.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no matches returns "(no matches)"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await setupTree(cwd);
      const out = await grepTool.call(
        { pattern: 'DefinitelyNotHere_xyz' },
        ctx(cwd),
      );
      expect(out).toBe('(no matches)');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('scoped path: search confined to subdir', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await setupTree(cwd);
      const out = await grepTool.call(
        { pattern: 'alpha', path: 'src' },
        ctx(cwd),
      );
      expect(out).toContain('alpha.ts');
      expect(out).not.toContain('alpha.test.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects path outside cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await expect(
        grepTool.call({ pattern: 'x', path: '/etc' }, ctx(cwd)),
      ).rejects.toThrow(/outside working directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HAVE_RG)('grepTool (rg missing)', () => {
  beforeAll(() => {
    __resetRgCacheForTests();
  });

  test('errors with a clear install message', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-grep-'));
    try {
      await expect(
        grepTool.call({ pattern: 'x' }, ctx(cwd)),
      ).rejects.toThrow(/ripgrep/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
