import { describe, test, expect } from 'bun:test';

import {
  buildAgentTool,
  resolveChildTools,
  assembleChildSystemPrompt,
} from '../../src/tools/agent';
import type { AgentDefinition } from '../../src/agents/loader';
import type { Tool, ToolContext } from '../../src/Tool';
import { readTool, writeTool, bashTool } from '../../src/tools/index';
import { FakeProvider, textOnly, withToolUse } from '../fixtures/fake-provider';

function ctx(tools: Tool[] = [], cwd: string = '/tmp'): ToolContext {
  return { cwd, signal: new AbortController().signal, tools };
}

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  agentType: 'explorer',
  whenToUse: 'For research.',
  prompt: 'You are an explorer. Report concisely.',
  source: 'project',
  filePath: '/fake/explorer.md',
  ...over,
});

// A no-op fake "Agent" tool used to verify that the recursion guard strips
// any tool whose name === 'Agent' from the child's tool pool.
const fakeAgentTool: Tool = {
  name: 'Agent',
  description: 'parent agent dispatcher',
  inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
  call: async () => 'unused',
  checkPermissions: async () => ({ behavior: 'allow' as const }),
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
};

describe('resolveChildTools', () => {
  test('strips the Agent tool itself (recursion guard)', () => {
    const a = agent({ tools: undefined });
    const child = resolveChildTools([readTool, writeTool, fakeAgentTool], a);
    expect(child.map((t) => t.name)).toEqual(['Read', 'Write']);
  });

  test('tools=undefined → all parent tools (minus Agent)', () => {
    const a = agent({ tools: undefined });
    const child = resolveChildTools([readTool, writeTool, bashTool], a);
    expect(child.map((t) => t.name)).toEqual(['Read', 'Write', 'Bash']);
  });

  test('tools allowlist restricts the child pool', () => {
    const a = agent({ tools: ['Read', 'Bash'] });
    const child = resolveChildTools([readTool, writeTool, bashTool], a);
    expect(child.map((t) => t.name)).toEqual(['Read', 'Bash']);
  });

  test('tools=[] → empty child pool (allowlist with no entries)', () => {
    const a = agent({ tools: [] });
    const child = resolveChildTools([readTool, writeTool, bashTool], a);
    expect(child).toEqual([]);
  });

  test('unknown tool name in allowlist is silently skipped', () => {
    const a = agent({ tools: ['Read', 'NotARealTool'] });
    const child = resolveChildTools([readTool, writeTool], a);
    expect(child.map((t) => t.name)).toEqual(['Read']);
  });
});

describe('assembleChildSystemPrompt', () => {
  test('starts with agent body, includes tools + cwd', () => {
    const out = assembleChildSystemPrompt({
      agent: agent({ prompt: 'YOU ARE THE EXPLORER.' }),
      tools: [readTool],
      cwd: '/tmp/foo',
    });
    expect(out.startsWith('YOU ARE THE EXPLORER.')).toBe(true);
    expect(out).toContain('# Tools');
    expect(out).toContain('**Read**');
    expect(out).toContain('# Environment');
    expect(out).toContain('/tmp/foo');
    // Crucially: NOT the parent's mini-claw persona — child has its own.
    expect(out).not.toContain('mini-claw');
  });

  test('memory block appended when provided', () => {
    const out = assembleChildSystemPrompt({
      agent: agent(),
      tools: [],
      cwd: '/',
      memory: 'PROJECT MEMORY HERE',
    });
    expect(out).toContain('# Project memory (CLAUDE.md)');
    expect(out).toContain('PROJECT MEMORY HERE');
  });

  test('memory block omitted when memory is empty', () => {
    const out = assembleChildSystemPrompt({
      agent: agent(),
      tools: [],
      cwd: '/',
      memory: '   ',
    });
    expect(out).not.toContain('# Project memory');
  });

  test('handles empty tool pool with placeholder', () => {
    const out = assembleChildSystemPrompt({
      agent: agent(),
      tools: [],
      cwd: '/',
    });
    expect(out).toContain('(no tools available)');
  });
});

describe('Agent tool — buildAgentTool', () => {
  test('description changes when no agents are installed', () => {
    const empty = buildAgentTool([], { provider: new FakeProvider([]) });
    const populated = buildAgentTool([agent()], {
      provider: new FakeProvider([]),
    });
    expect(empty.description).toContain('No agents');
    expect(populated.description).not.toContain('No agents');
  });

  test('spawns child engine and returns last assistant text', async () => {
    // FakeProvider has ONE script — the child's first sample call.
    const provider = new FakeProvider([textOnly('child report here')]);
    const tool = buildAgentTool([agent()], { provider });
    const out = await tool.call(
      { description: 'test', prompt: 'do the thing', subagent_type: 'explorer' },
      ctx([readTool, writeTool]),
    );
    if (typeof out === 'string') throw new Error('expected object output');
    expect(out.content).toBe('child report here');
  });

  test('child sees its OWN system prompt + tools, not the parent set', async () => {
    const provider = new FakeProvider([textOnly('done')]);
    const tool = buildAgentTool(
      [agent({ tools: ['Read'], prompt: 'CHILD PERSONA' })],
      { provider },
    );
    await tool.call(
      { description: 'x', prompt: 'go', subagent_type: 'explorer' },
      ctx([readTool, writeTool, bashTool, fakeAgentTool], '/tmp/child-cwd'),
    );
    // FakeProvider captured what the child engine sent on its first sample call.
    expect(provider.capturedSystemPrompts).toHaveLength(1);
    const sysPrompt = provider.capturedSystemPrompts[0]!;
    expect(sysPrompt).toContain('CHILD PERSONA');
    expect(sysPrompt).toContain('/tmp/child-cwd');
    // Tool pool: filtered to allowlist AND stripped of Agent.
    expect(provider.capturedTools[0]?.map((t) => t.name)).toEqual(['Read']);
  });

  test('child has fresh messages[]: only the prompt as user[0]', async () => {
    const provider = new FakeProvider([textOnly('done')]);
    const tool = buildAgentTool([agent()], { provider });
    await tool.call(
      {
        description: 'x',
        prompt: 'isolated prompt for child',
        subagent_type: 'explorer',
      },
      ctx([readTool]),
    );
    const childMessagesAtSample = provider.capturedMessages[0]!;
    expect(childMessagesAtSample).toHaveLength(1);
    expect(childMessagesAtSample[0]?.role).toBe('user');
    expect(JSON.stringify(childMessagesAtSample[0]?.content)).toContain(
      'isolated prompt for child',
    );
  });

  test('child can run multi-turn (tool_use → result → final text)', async () => {
    const provider = new FakeProvider([
      withToolUse('', [
        { id: 'tu_1', name: 'Read', input: { file_path: '/etc/hostname' } },
      ]),
      textOnly('I read it: ok'),
    ]);
    const tool = buildAgentTool([agent({ tools: ['Read'] })], { provider });
    const out = await tool.call(
      { description: 'x', prompt: 'read file', subagent_type: 'explorer' },
      ctx([readTool]),
    );
    if (typeof out === 'string') throw new Error('expected object output');
    expect(out.content).toBe('I read it: ok');
    // Two sample calls: one to get tool_use, one for the final text.
    expect(provider.capturedMessages).toHaveLength(2);
  });

  test('unknown subagent_type → throws with available list', async () => {
    const provider = new FakeProvider([]);
    const tool = buildAgentTool(
      [agent({ agentType: 'one' }), agent({ agentType: 'two' })],
      { provider },
    );
    await expect(
      tool.call(
        { description: 'x', prompt: 'p', subagent_type: 'three' },
        ctx([readTool]),
      ),
    ).rejects.toThrow(/Unknown agent type.*one.*two/);
  });

  test('missing subagent_type with multiple agents → throws', async () => {
    const tool = buildAgentTool(
      [agent({ agentType: 'one' }), agent({ agentType: 'two' })],
      { provider: new FakeProvider([]) },
    );
    await expect(
      tool.call({ description: 'x', prompt: 'p' }, ctx()),
    ).rejects.toThrow(/requires `subagent_type`/);
  });

  test('missing subagent_type with single agent → uses it', async () => {
    const provider = new FakeProvider([textOnly('only-agent ran')]);
    const tool = buildAgentTool([agent({ agentType: 'solo' })], { provider });
    const out = await tool.call(
      { description: 'x', prompt: 'go' },
      ctx([readTool]),
    );
    if (typeof out === 'string') throw new Error('expected object output');
    expect(out.content).toBe('only-agent ran');
  });

  test('agent producing no text output → throws', async () => {
    // Final assistant message has no text content (just stop, no text_delta).
    const provider = new FakeProvider([
      [
        {
          type: 'message_complete',
          assistantMessage: { role: 'assistant', content: [] },
          stopReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
    ]);
    const tool = buildAgentTool([agent()], { provider });
    await expect(
      tool.call(
        { description: 'x', prompt: 'p', subagent_type: 'explorer' },
        ctx([readTool]),
      ),
    ).rejects.toThrow(/no text output/);
  });

  test('parent abort propagates to the child engine', async () => {
    // Provider that streams forever until aborted.
    const stallProvider: import('../../src/providers/index').LLMProvider = {
      model: 'stall',
      async *sampleStream(_messages, _tools, _systemPrompt, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    const tool = buildAgentTool([agent()], { provider: stallProvider });
    const ac = new AbortController();
    const callP = tool.call(
      { description: 'x', prompt: 'wait', subagent_type: 'explorer' },
      { cwd: '/tmp', signal: ac.signal, tools: [readTool] },
    );
    // Abort the parent's signal — child should bail.
    queueMicrotask(() => ac.abort());
    await expect(callP).rejects.toThrow();
  });
});
