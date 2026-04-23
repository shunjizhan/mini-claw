import { describe, test, expect } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  normalizeAnthropicStopReason,
  toAnthropicMessages,
  toolToAnthropic,
  translateAnthropicStream,
} from '../../src/providers/anthropic';
import { buildTool } from '../../src/Tool';
import type { Message, StreamEvent } from '../../src/types';
import { ProviderProtocolError } from '../../src/types';
import { drain, fromArray } from '../fixtures/async-iter';

/**
 * Construct an Anthropic raw stream event without filling every SDK-required
 * field. The translation function only branches on known `event.type` values,
 * so minimal fixtures are fine. Cast keeps types honest at the call site.
 */
function mkEvent(ev: Record<string, unknown>): Anthropic.RawMessageStreamEvent {
  return ev as unknown as Anthropic.RawMessageStreamEvent;
}

describe('translateAnthropicStream', () => {
  test('text-only: yields text_deltas + one message_complete with assembled text', async () => {
    const events = [
      mkEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      }),
      mkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      }),
      mkEvent({ type: 'content_block_stop', index: 0 }),
      mkEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      mkEvent({ type: 'message_stop' }),
    ];
    const out = await drain(translateAnthropicStream(fromArray(events)));

    const deltas = out.filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta');
    const completes = out.filter((e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete');

    expect(deltas.map((d) => d.text)).toEqual(['Hello', ' world']);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.stopReason).toBe('stop');
    expect(completes[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(completes[0]?.assistantMessage.content).toEqual([
      { type: 'text', text: 'Hello world' },
    ]);
  });

  test('single tool_use: input_json_delta chunks assemble into ToolUse.input', async () => {
    const events = [
      mkEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
      mkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_A',
          name: 'Write',
          input: {},
        },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"/tmp/a.txt","content":"hi"}' },
      }),
      mkEvent({ type: 'content_block_stop', index: 0 }),
      mkEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
      mkEvent({ type: 'message_stop' }),
    ];
    const out = await drain(translateAnthropicStream(fromArray(events)));

    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.stopReason).toBe('tool_use');
    expect(complete?.assistantMessage.content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_A',
        name: 'Write',
        input: { file_path: '/tmp/a.txt', content: 'hi' },
      },
    ]);
  });

  test('mixed text + tool_use content blocks: both appear, ordered by index', async () => {
    const events = [
      mkEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      mkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Running...' },
      }),
      mkEvent({ type: 'content_block_stop', index: 0 }),
      mkEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_X',
          name: 'Bash',
          input: {},
        },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      }),
      mkEvent({ type: 'content_block_stop', index: 1 }),
      mkEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
      }),
      mkEvent({ type: 'message_stop' }),
    ];
    const out = await drain(translateAnthropicStream(fromArray(events)));
    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );

    expect(complete?.assistantMessage.content).toEqual([
      { type: 'text', text: 'Running...' },
      {
        type: 'tool_use',
        id: 'toolu_X',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ]);
  });

  test('malformed input_json throws ProviderProtocolError', async () => {
    const events = [
      mkEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      mkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_X', name: 'X', input: {} },
      }),
      mkEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{broken' },
      }),
      mkEvent({ type: 'content_block_stop', index: 0 }),
      mkEvent({ type: 'message_stop' }),
    ];
    await expect(
      drain(translateAnthropicStream(fromArray(events))),
    ).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test('empty input_json (no chunks) → ToolUse.input = {}', async () => {
    const events = [
      mkEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      mkEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_E',
          name: 'Empty',
          input: {},
        },
      }),
      mkEvent({ type: 'content_block_stop', index: 0 }),
      mkEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
      }),
      mkEvent({ type: 'message_stop' }),
    ];
    const out = await drain(translateAnthropicStream(fromArray(events)));
    const complete = out.find(
      (e): e is Extract<StreamEvent, { type: 'message_complete' }> => e.type === 'message_complete',
    );
    expect(complete?.assistantMessage.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_E',
      name: 'Empty',
      input: {},
    });
  });
});

describe('normalizeAnthropicStopReason', () => {
  test('end_turn → stop', () => {
    expect(normalizeAnthropicStopReason('end_turn')).toBe('stop');
  });
  test('stop_sequence → stop', () => {
    expect(normalizeAnthropicStopReason('stop_sequence')).toBe('stop');
  });
  test('tool_use → tool_use', () => {
    expect(normalizeAnthropicStopReason('tool_use')).toBe('tool_use');
  });
  test('max_tokens → max_tokens', () => {
    expect(normalizeAnthropicStopReason('max_tokens')).toBe('max_tokens');
  });
  test('unknown → stop (defensive default)', () => {
    expect(normalizeAnthropicStopReason('something_new')).toBe('stop');
  });
});

describe('toAnthropicMessages', () => {
  test('role=user: text blocks preserved', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  test('role=assistant with text + tool_use: both carried as typed blocks', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    ]);
  });

  test('role=tool: becomes Anthropic role=user with tool_result blocks', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: 'total 0',
          },
        ],
      },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'total 0',
          },
        ],
      },
    ]);
  });

  test('role=tool with isError surfaces as is_error: true', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: 'boom',
            isError: true,
          },
        ],
      },
    ];
    const out = toAnthropicMessages(msgs);
    const content = (out[0] as { content: unknown[] }).content[0] as Record<string, unknown>;
    expect(content['is_error']).toBe(true);
  });
});

describe('toolToAnthropic', () => {
  test('Zod schema → input_schema with $schema stripped', () => {
    const tool = buildTool({
      name: 'Echo',
      description: 'echoes back',
      inputSchema: z.object({ msg: z.string() }),
      async call({ msg }) {
        return msg;
      },
    });
    const out = toolToAnthropic(tool);
    expect(out.name).toBe('Echo');
    expect(out.description).toBe('echoes back');
    const schema = out.input_schema as Record<string, unknown>;
    expect(schema['$schema']).toBeUndefined();
    expect(schema['type']).toBe('object');
    expect(schema['properties']).toEqual({ msg: { type: 'string' } });
  });
});
