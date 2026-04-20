import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTool } from '../../src/tools/read';
import type { ToolContext } from '../../src/Tool';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

describe('readTool', () => {
  test('returns numbered lines in addLineNumbers format', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'alpha\nbeta\ngamma');
      const out = await readTool.call({ file_path: f }, ctx(cwd));
      expect(out).toBe('1\talpha\n2\tbeta\n3\tgamma');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('offset + limit reads a window and announces truncation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, '1\n2\n3\n4\n5');
      const out = await readTool.call(
        { file_path: f, offset: 2, limit: 2 },
        ctx(cwd),
      );
      expect(out).toContain('2\t2');
      expect(out).toContain('3\t3');
      expect(out).toContain('truncated');
      expect(out).toContain('offset=4');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects paths outside cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      await expect(
        readTool.call({ file_path: '/etc/passwd' }, ctx(cwd)),
      ).rejects.toThrow(/outside working directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing file errors', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      await expect(
        readTool.call({ file_path: join(cwd, 'missing.txt') }, ctx(cwd)),
      ).rejects.toThrow(/not found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('empty file → empty string', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      const f = join(cwd, 'e.txt');
      await Bun.write(f, '');
      expect(await readTool.call({ file_path: f }, ctx(cwd))).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('offset past end reports clearly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-read-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'only one');
      const out = await readTool.call(
        { file_path: f, offset: 10 },
        ctx(cwd),
      );
      expect(out).toContain('past end');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
