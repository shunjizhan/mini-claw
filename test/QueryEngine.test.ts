import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../src/QueryEngine';
import type { PermissionDecision, PermissionPrompter } from '../src/permissions';
import { readTool, writeTool } from '../src/tools/index';
import type { StreamEvent, ToolMessage } from '../src/types';
import { assertCanonicalTranscript } from './fixtures/canonical-transcript';
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
    assertCanonicalTranscript(engine.messages);
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
      assertCanonicalTranscript(engine.messages);
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
      assertCanonicalTranscript(engine.messages);
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
    assertCanonicalTranscript(engine.messages);
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
    assertCanonicalTranscript(engine.messages);
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
    assertCanonicalTranscript(engine.messages);
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
    assertCanonicalTranscript(engine.messages);
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
    // Post-rollback state is still canonical (empty array trivially valid).
    assertCanonicalTranscript(engine.messages);
  });

  test('permissionPrompter: "allow" lets the tool run', async () => {
    const cwd = makeTmp();
    try {
      const target = join(cwd, 'a.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          {
            id: 'tu_1',
            name: 'Write',
            input: { file_path: target, content: 'ok' },
          },
        ]),
        textOnly('done'),
      ]);
      const calls: string[] = [];
      const prompter: PermissionPrompter = async (prompt, descriptor) => {
        calls.push(`${descriptor}:${prompt}`);
        return 'allow';
      };
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
        permissionPrompter: prompter,
      });
      await drain(engine.submitMessage('write please'));

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^Write:Write 2 bytes/);
      expect(await Bun.file(target).text()).toBe('ok');
      const toolMsg = engine.messages[2] as ToolMessage;
      expect(toolMsg.content[0]?.isError).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('permissionPrompter: "deny" synthesizes isError ToolResult and loop continues', async () => {
    const cwd = makeTmp();
    try {
      const target = join(cwd, 'a.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          {
            id: 'tu_1',
            name: 'Write',
            input: { file_path: target, content: 'nope' },
          },
        ]),
        textOnly('understood'),
      ]);
      const prompter: PermissionPrompter = async () => 'deny';
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
        permissionPrompter: prompter,
      });
      await drain(engine.submitMessage('write please'));

      const toolMsg = engine.messages[2] as ToolMessage;
      expect(toolMsg.content[0]?.isError).toBe(true);
      expect(toolMsg.content[0]?.content).toContain('Permission denied');
      // File should NOT have been created.
      expect(await Bun.file(target).exists()).toBe(false);
      // Loop survived — final assistant message landed.
      expect(engine.messages).toHaveLength(4);
      assertCanonicalTranscript(engine.messages);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('permissionPrompter: "allow-always" caches the decision for subsequent calls', async () => {
    const cwd = makeTmp();
    try {
      const a = join(cwd, 'a.txt');
      const b = join(cwd, 'b.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          {
            id: 'tu_1',
            name: 'Write',
            input: { file_path: a, content: 'A' },
          },
        ]),
        textOnly('first done'),
        withToolUse('', [
          {
            id: 'tu_2',
            name: 'Write',
            input: { file_path: b, content: 'B' },
          },
        ]),
        textOnly('second done'),
      ]);
      let promptCount = 0;
      const decisions: PermissionDecision[] = ['allow-always'];
      const prompter: PermissionPrompter = async () => {
        promptCount++;
        return decisions.shift() ?? 'deny';
      };
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
        permissionPrompter: prompter,
      });

      await drain(engine.submitMessage('write A'));
      await drain(engine.submitMessage('write B'));

      // Prompter fired exactly once despite two Write invocations.
      expect(promptCount).toBe(1);
      expect(await Bun.file(a).text()).toBe('A');
      expect(await Bun.file(b).text()).toBe('B');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no permissionPrompter wired: "ask" falls through to allow', async () => {
    const cwd = makeTmp();
    try {
      const target = join(cwd, 'a.txt');
      const provider = new FakeProvider([
        withToolUse('', [
          {
            id: 'tu_1',
            name: 'Write',
            input: { file_path: target, content: 'hi' },
          },
        ]),
        textOnly('done'),
      ]);
      const engine = new QueryEngine({
        provider,
        tools: [writeTool],
        systemPrompt: 'sys',
        cwd,
        // no permissionPrompter → legacy allow-through behavior
      });
      await drain(engine.submitMessage('write'));

      expect(await Bun.file(target).text()).toBe('hi');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
    assertCanonicalTranscript(engine.messages);
  });
});
