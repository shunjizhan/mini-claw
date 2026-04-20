import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editTool } from '../../src/tools/edit';
import type { ToolContext } from '../../src/Tool';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

describe('editTool', () => {
  test('single match → replaces in place', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'foo bar baz');
      const out = await editTool.call(
        { file_path: f, old_string: 'bar', new_string: 'BAR' },
        ctx(cwd),
      );
      expect(out).toMatch(/1 replacement/);
      expect(await Bun.file(f).text()).toBe('foo BAR baz');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('zero matches → error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'hello');
      await expect(
        editTool.call(
          { file_path: f, old_string: 'missing', new_string: 'X' },
          ctx(cwd),
        ),
      ).rejects.toThrow(/not found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('multiple matches without replace_all → ambiguous error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'a\na\na');
      await expect(
        editTool.call(
          { file_path: f, old_string: 'a', new_string: 'b' },
          ctx(cwd),
        ),
      ).rejects.toThrow(/3 matches/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('multiple matches with replace_all:true → all replaced', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'a a a');
      const out = await editTool.call(
        {
          file_path: f,
          old_string: 'a',
          new_string: 'z',
          replace_all: true,
        },
        ctx(cwd),
      );
      expect(out).toMatch(/3 replacements/);
      expect(await Bun.file(f).text()).toBe('z z z');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('old_string === new_string → error (no-op)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'a.txt');
      await Bun.write(f, 'x');
      await expect(
        editTool.call(
          { file_path: f, old_string: 'x', new_string: 'x' },
          ctx(cwd),
        ),
      ).rejects.toThrow(/identical/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing file → error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mini-cc-edit-'));
    try {
      const f = join(cwd, 'nope.txt');
      await expect(
        editTool.call(
          { file_path: f, old_string: 'a', new_string: 'b' },
          ctx(cwd),
        ),
      ).rejects.toThrow(/not found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
