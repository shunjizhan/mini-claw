import { describe, test, expect } from 'bun:test';
import type OpenAI from 'openai';
import { z } from 'zod';

import {
  ensureVersionPrefix,
  normalizeOpenAIStopReason,
  toOpenAIMessages,
  toolToOpenAI,
  translateOpenAIStream,
} from '../../src/providers/openai';
import { buildTool } from '../../src/Tool';
import type { Message, StreamEvent } from '../../src/types';
import { ProviderProtocolError } from '../../src/types';
import { drain, fromArray } from '../fixtures/async-iter';

function mkChunk(ch: Record<string, unknown>): OpenAI.ChatCompletionChunk {
  return ch as unknown as OpenAI.ChatCompletionChunk;
}

describe('translateOpenAIStream', () => {
  test('text-only: delta.content chunks yield text_deltas + message_complete', async () => {
    const chunks = [
      mkChunk({ choices: [{ index: 0, delta: { content: 'Hi' } }] }),
      mkChunk({ choices: [{ index: 0, delta: { content: ' there' } }] }),
      mkChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    ];
    const out = await drain(translateOpenAIStream(fromArray(chunks)));

    const deltas = out.filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta');
    const completes = out.filter((e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete');

    expect(deltas.map((d) => d.text)).toEqual(['Hi', ' there']);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.stopReason).toBe('stop');
    expect(completes[0]?.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(completes[0]?.assistantMessage.content).toEqual([
      { type: 'text', text: 'Hi there' },
    ]);
  });

  test('single tool call: arguments chunks reassemble into ToolUse.input', async () => {
    const chunks = [
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Write', arguments: '' },
            }],
          },
        }],
      }),
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"file_path":' },
            }],
          },
        }],
      }),
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '"/tmp/a.txt","content":"hi"}' },
            }],
          },
        }],
      }),
      mkChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      }),
    ];
    const out = await drain(translateOpenAIStream(fromArray(chunks)));

    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.stopReason).toBe('tool_use');
    expect(complete?.assistantMessage.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Write',
        input: { file_path: '/tmp/a.txt', content: 'hi' },
      },
    ]);
  });

  test('multi-tool turn: indexes 0 and 1 both assembled, ordered', async () => {
    const chunks = [
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'c_A', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' } },
              { index: 1, id: 'c_B', type: 'function', function: { name: 'Read', arguments: '{"file_path":"b"}' } },
            ],
          },
        }],
      }),
      mkChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ];
    const out = await drain(translateOpenAIStream(fromArray(chunks)));
    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.assistantMessage.content).toEqual([
      { type: 'tool_use', id: 'c_A', name: 'Read', input: { file_path: 'a' } },
      { type: 'tool_use', id: 'c_B', name: 'Read', input: { file_path: 'b' } },
    ]);
  });

  test('malformed arguments JSON → ProviderProtocolError', async () => {
    const chunks = [
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'c_bad',
              type: 'function',
              function: { name: 'X', arguments: '{broken' },
            }],
          },
        }],
      }),
      mkChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ];
    await expect(
      drain(translateOpenAIStream(fromArray(chunks))),
    ).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test('empty arguments → ToolUse.input = {}', async () => {
    const chunks = [
      mkChunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'c_empty',
              type: 'function',
              function: { name: 'Noop', arguments: '' },
            }],
          },
        }],
      }),
      mkChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ];
    const out = await drain(translateOpenAIStream(fromArray(chunks)));
    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.assistantMessage.content[0]).toEqual({
      type: 'tool_use',
      id: 'c_empty',
      name: 'Noop',
      input: {},
    });
  });

  test('usage (last chunk) populates final usage', async () => {
    const chunks = [
      mkChunk({ choices: [{ index: 0, delta: { content: 'x' } }] }),
      mkChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 99, completion_tokens: 1 },
      }),
    ];
    const out = await drain(translateOpenAIStream(fromArray(chunks)));
    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.usage).toEqual({ inputTokens: 99, outputTokens: 1 });
  });
});

describe('normalizeOpenAIStopReason', () => {
  test('stop → stop', () => {
    expect(normalizeOpenAIStopReason('stop')).toBe('stop');
  });
  test('tool_calls → tool_use', () => {
    expect(normalizeOpenAIStopReason('tool_calls')).toBe('tool_use');
  });
  test('function_call → tool_use', () => {
    expect(normalizeOpenAIStopReason('function_call')).toBe('tool_use');
  });
  test('length → max_tokens', () => {
    expect(normalizeOpenAIStopReason('length')).toBe('max_tokens');
  });
  test('content_filter → error', () => {
    expect(normalizeOpenAIStopReason('content_filter')).toBe('error');
  });
  test('unknown → stop (defensive)', () => {
    expect(normalizeOpenAIStopReason('whatever')).toBe('stop');
  });
});

describe('ensureVersionPrefix', () => {
  test('undefined → undefined (pass-through; SDK picks its own default)', () => {
    expect(ensureVersionPrefix(undefined)).toBeUndefined();
  });
  test('bare host → appends /v1', () => {
    expect(ensureVersionPrefix('http://localhost:8317')).toBe(
      'http://localhost:8317/v1',
    );
  });
  test('trailing slash is trimmed before append', () => {
    expect(ensureVersionPrefix('http://localhost:8317/')).toBe(
      'http://localhost:8317/v1',
    );
  });
  test('already has /v1 → unchanged', () => {
    expect(ensureVersionPrefix('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    );
  });
  test('/v2 is preserved (any /vN segment)', () => {
    expect(ensureVersionPrefix('https://custom.proxy/v2')).toBe(
      'https://custom.proxy/v2',
    );
  });
  test('/v1/ trailing slash → trimmed + recognized', () => {
    expect(ensureVersionPrefix('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1',
    );
  });
});

describe('toOpenAIMessages', () => {
  test('system prompt prepended', () => {
    const out = toOpenAIMessages([], 'sys-text');
    expect(out[0]).toEqual({ role: 'system', content: 'sys-text' });
  });

  test('user message: text blocks joined', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: 'there' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs, 'sys');
    expect(out[1]).toEqual({ role: 'user', content: 'hi\n\nthere' });
  });

  test('assistant with tool_calls and no text → content: null', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'c_1',
            name: 'X',
            input: { q: 1 },
          },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs, 'sys');
    expect(out[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c_1',
          type: 'function',
          function: { name: 'X', arguments: '{"q":1}' },
        },
      ],
    });
  });

  test('assistant with text + tool_calls → content carries text', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'c_1', name: 'X', input: {} },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs, 'sys');
    expect(out[1]).toMatchObject({
      role: 'assistant',
      content: 'working',
      tool_calls: [{ id: 'c_1', function: { name: 'X', arguments: '{}' } }],
    });
  });

  test('role=tool expands to one role=tool message per ToolResult', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'c_1', content: 'A' },
          { type: 'tool_result', toolUseId: 'c_2', content: 'B' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs, 'sys');
    // out[0]=system, out[1..2]=two tool messages
    expect(out.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'c_1', content: 'A' },
      { role: 'tool', tool_call_id: 'c_2', content: 'B' },
    ]);
  });
});

describe('toolToOpenAI', () => {
  test('wraps as function with parameters; $schema stripped', () => {
    const tool = buildTool({
      name: 'Echo',
      description: 'echoes back',
      inputSchema: z.object({ msg: z.string() }),
      async call({ msg }) {
        return msg;
      },
    });
    const out = toolToOpenAI(tool);
    // ChatCompletionTool is a discriminated union — narrow to the function variant.
    if (out.type !== 'function') throw new Error('expected a function tool');
    expect(out.function.name).toBe('Echo');
    expect(out.function.description).toBe('echoes back');
    const params = out.function.parameters as Record<string, unknown>;
    expect(params['$schema']).toBeUndefined();
    expect(params['type']).toBe('object');
    expect(params['properties']).toEqual({ msg: { type: 'string' } });
  });
});
