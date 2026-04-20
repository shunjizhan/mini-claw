import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTool } from '../../src/tools/write';
import type { ToolContext } from '../../src/Tool';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

describe('writeTool', () => {
  test('creates a new file and reports "Created"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-write-'));
    try {
      const f = join(cwd, 'new.txt');
      const out = await writeTool.call(
        { file_path: f, content: 'hello' },
        ctx(cwd),
      );
      expect(out).toMatch(/^Created /);
      expect(await Bun.file(f).text()).toBe('hello');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('overwrites existing file and reports "Updated"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-write-'));
    try {
      const f = join(cwd, 'ex.txt');
      await Bun.write(f, 'old');
      const out = await writeTool.call(
        { file_path: f, content: 'new' },
        ctx(cwd),
      );
      expect(out).toMatch(/^Updated /);
      expect(await Bun.file(f).text()).toBe('new');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects paths outside cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-write-'));
    try {
      await expect(
        writeTool.call(
          { file_path: '/tmp/outside.txt', content: 'x' },
          ctx(cwd),
        ),
      ).rejects.toThrow(/outside working directory/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing parent directory errors (no implicit mkdir)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-write-'));
    try {
      const f = join(cwd, 'nope', 'nested.txt');
      await expect(
        writeTool.call({ file_path: f, content: 'x' }, ctx(cwd)),
      ).rejects.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
