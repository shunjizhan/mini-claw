import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { globTool } from '../../src/tools/glob';
import type { ToolContext } from '../../src/Tool';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

async function setupTree(cwd: string): Promise<void> {
  mkdirSync(join(cwd, 'src', 'tools'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  await Bun.write(join(cwd, 'src', 'tools', 'a.ts'), 'x');
  await Bun.write(join(cwd, 'src', 'tools', 'b.ts'), 'x');
  await Bun.write(join(cwd, 'src', 'index.ts'), 'x');
  await Bun.write(join(cwd, 'test', 'a.test.ts'), 'x');
  await Bun.write(join(cwd, '.hidden'), 'x');
}

describe('globTool', () => {
  test('simple pattern returns sorted relative paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await setupTree(cwd);
      const out = await globTool.call({ pattern: '**/*.ts' }, ctx(cwd));
      const lines = out.split('\n');
      expect(lines).toContain('src/index.ts');
      expect(lines).toContain('src/tools/a.ts');
      expect(lines).toContain('src/tools/b.ts');
      expect(lines).toContain('test/a.test.ts');
      // sorted alphabetically
      const sorted = [...lines].sort();
      expect(lines).toEqual(sorted);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('narrow pattern returns only matching files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await setupTree(cwd);
      const out = await globTool.call(
        { pattern: 'src/tools/*.ts' },
        ctx(cwd),
      );
      const lines = out.split('\n');
      expect(lines).toEqual(['src/tools/a.ts', 'src/tools/b.ts']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('dotfiles excluded by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await setupTree(cwd);
      const out = await globTool.call({ pattern: '*' }, ctx(cwd));
      expect(out).not.toContain('.hidden');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no matches → "(no matches)"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await setupTree(cwd);
      const out = await globTool.call(
        { pattern: '**/*.rs' },
        ctx(cwd),
      );
      expect(out).toBe('(no matches)');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('scoped path: scan runs relative to resolved subdir', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await setupTree(cwd);
      const out = await globTool.call(
        { pattern: '*.ts', path: 'src/tools' },
        ctx(cwd),
      );
      const lines = out.split('\n');
      // Relative to the scanned root (src/tools), so entries are just a.ts, b.ts
      expect(lines).toEqual(['a.ts', 'b.ts']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects path outside cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-glob-'));
    try {
      await expect(
        globTool.call({ pattern: '*', path: '/etc' }, ctx(cwd)),
      ).rejects.toThrow(/outside working directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
