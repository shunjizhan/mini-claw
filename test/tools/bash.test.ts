import { describe, test, expect } from 'bun:test';

import { bashTool } from '../../src/tools/bash';
import type { ToolContext } from '../../src/Tool';

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd: '/tmp', signal: signal ?? new AbortController().signal };
}

describe('bashTool', () => {
  test('captures stdout on success', async () => {
    const out = await bashTool.call({ command: 'echo hello' }, ctx());
    expect(out).toContain('--- stdout ---');
    expect(out).toContain('hello');
    expect(out).toContain('exit 0');
  });

  test('non-zero exit is returned, not thrown', async () => {
    const out = await bashTool.call({ command: 'false' }, ctx());
    expect(out).toContain('exit 1');
  });

  test('stdout and stderr captured separately', async () => {
    const out = await bashTool.call(
      { command: 'echo out; echo err 1>&2' },
      ctx(),
    );
    expect(out).toContain('--- stdout ---');
    expect(out).toContain('out');
    expect(out).toContain('--- stderr ---');
    expect(out).toContain('err');
  });

  test('timeout kills and reports', async () => {
    const out = await bashTool.call(
      { command: 'sleep 5', timeout: 1 },
      ctx(),
    );
    expect(out).toContain('killed by timeout');
  });

  test('abort marks as aborted (not timeout)', async () => {
    const ac = new AbortController();
    const p = bashTool.call({ command: 'sleep 5' }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const out = await p;
    expect(out).toContain('aborted by user');
  });
});
