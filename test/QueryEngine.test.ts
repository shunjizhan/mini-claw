import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../src/QueryEngine';
import { readTool, writeTool } from '../src/tools/index';
import type { StreamEvent, ToolMessage } from '../src/types';
import {
  AbortingProvider,
  FakeProvider,
  textOnly,
  withToolUse,
} from './fixtures/fake-provider';

async function drain(
  gen: AsyncGenerator<StreamEvent, void, unknown>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'mini-cc-qe-'));
}

describe('QueryEngine', () => {
  test('text-only response: user + assistant land in messages[]', async () => {
    const provider = new FakeProvider([textOnly('Hello!')]);
    const engine = new QueryEngine({
      provider,
      tools: [],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    const events = await drain(engine.submitMessage('hi'));

    expect(events[0]?.type).toBe('text_delta');
    expect(events.at(-1)?.type).toBe('message_complete');
    expect(engine.messages).toHaveLength(2);
    expect(engine.messages[0]?.role).toBe('user');
    expect(engine.messages[1]?.role).toBe('assistant');
  });

  test('single tool call: dispatch + loop + final text', async () => {
    const cwd = makeTmp();
    try {
      const target = join(cwd, 'hello.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          {
            id: 'tu_1',
            name: 'Write',
            input: { file_path: target, content: 'hi' },
          },
        ]),
        textOnly('Done.'),
      ]);
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
      });
      await drain(engine.submitMessage('create file'));

      expect(engine.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      const toolMsg = engine.messages[2] as ToolMessage;
      expect(toolMsg.content).toHaveLength(1);
      expect(toolMsg.content[0]?.isError).toBeUndefined();
      expect(await Bun.file(target).text()).toBe('hi');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('multi-tool turn: all dispatched sequentially, results in same ToolMessage', async () => {
    const cwd = makeTmp();
    try {
      const a = join(cwd, 'a.txt');
      const b = join(cwd, 'b.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          { id: 'tu_1', name: 'Write', input: { file_path: a, content: 'A' } },
          { id: 'tu_2', name: 'Write', input: { file_path: b, content: 'B' } },
        ]),
        textOnly('Both done.'),
      ]);
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
      });
      await drain(engine.submitMessage('write both'));

      const toolMsg = engine.messages[2] as ToolMessage;
      expect(toolMsg.content).toHaveLength(2);
      expect(toolMsg.content[0]?.toolUseId).toBe('tu_1');
      expect(toolMsg.content[1]?.toolUseId).toBe('tu_2');
      expect(await Bun.file(a).text()).toBe('A');
      expect(await Bun.file(b).text()).toBe('B');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown tool → ToolResult{isError:true}, loop continues', async () => {
    const provider = new FakeProvider([
      withToolUse('', [{ id: 'tu_x', name: 'DoesNotExist', input: {} }]),
      textOnly('ok'),
    ]);
    const engine = new QueryEngine({
      provider,
      tools: [],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    await drain(engine.submitMessage('x'));

    const toolMsg = engine.messages[2] as ToolMessage;
    expect(toolMsg.content[0]?.isError).toBe(true);
    expect(toolMsg.content[0]?.content).toContain('Unknown tool');
    expect(engine.messages).toHaveLength(4);
  });

  test('Zod validation failure → ToolResult{isError:true}', async () => {
    const provider = new FakeProvider([
      withToolUse('', [
        { id: 'tu_1', name: 'Write', input: { wrong: 'field' } },
      ]),
      textOnly('ok'),
    ]);
    const engine = new QueryEngine({
      provider,
      tools: [writeTool],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    await drain(engine.submitMessage('x'));

    const toolMsg = engine.messages[2] as ToolMessage;
    expect(toolMsg.content[0]?.isError).toBe(true);
    expect(toolMsg.content[0]?.content).toMatch(/Invalid input/);
  });

  test('tool throws → ToolResult{isError:true}, loop survives', async () => {
    const provider = new FakeProvider([
      withToolUse('', [
        {
          id: 'tu_1',
          name: 'Read',
          input: { file_path: '/definitely/does/not/exist.txt' },
        },
      ]),
      textOnly('ok'),
    ]);
    const engine = new QueryEngine({
      provider,
      tools: [readTool],
      systemPrompt: 'sys',
      cwd: '/',
    });
    await drain(engine.submitMessage('read'));

    const toolMsg = engine.messages[2] as ToolMessage;
    expect(toolMsg.content[0]?.isError).toBe(true);
    expect(engine.messages).toHaveLength(4);
  });

  test('usage accumulates across turns', async () => {
    const provider = new FakeProvider([
      textOnly('one', { inputTokens: 10, outputTokens: 5 }),
      textOnly('two', { inputTokens: 20, outputTokens: 8 }),
    ]);
    const engine = new QueryEngine({
      provider,
      tools: [],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    await drain(engine.submitMessage('a'));
    await drain(engine.submitMessage('b'));
    expect(engine.usage.inputTokens).toBe(30);
    expect(engine.usage.outputTokens).toBe(13);
    expect(engine.messages).toHaveLength(4);
  });

  test('abort mid-stream: messages[] rolled back to pre-turn snapshot', async () => {
    const engine = new QueryEngine({
      provider: new AbortingProvider(),
      tools: [],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    await expect(drain(engine.submitMessage('x'))).rejects.toThrow();
    expect(engine.messages).toHaveLength(0);
  });

  test('second submitMessage after previous succeeds preserves history', async () => {
    const provider = new FakeProvider([textOnly('one'), textOnly('two')]);
    const engine = new QueryEngine({
      provider,
      tools: [],
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    await drain(engine.submitMessage('a'));
    await drain(engine.submitMessage('b'));
    expect(engine.messages).toHaveLength(4);
    expect(engine.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});
