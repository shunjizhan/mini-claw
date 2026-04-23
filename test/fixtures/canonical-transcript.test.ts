import { describe, test, expect } from 'bun:test';
import type { Message } from '../../src/types';
import { assertCanonicalTranscript } from './canonical-transcript';

describe('assertCanonicalTranscript', () => {
  test('empty array is valid', () => {
    expect(() => assertCanonicalTranscript([])).not.toThrow();
  });

  test('valid: user → assistant (text only)', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).not.toThrow();
  });

  test('valid: user → assistant(tool_use) → tool → assistant', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'X', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'done' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).not.toThrow();
  });

  test('valid: multi-turn across two user prompts', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: '1' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: '2' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).not.toThrow();
  });

  test('rule 1: first message must be user', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 1/);
  });

  test('rule 2: back-to-back assistants', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 2/);
  });

  test('rule 2: user following tool', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'X', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'bad' }] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 2/);
  });

  test('rule 3: empty assistant', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [] },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 3/);
  });

  test('rule 5: assistant tool_use count mismatch', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'X', input: {} },
          { type: 'tool_use', id: 't2', name: 'Y', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }],
      },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 5/);
  });

  test('rule 5: toolUseId mismatch', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'X', input: {} }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 't_wrong', content: 'r' },
        ],
      },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 5/);
  });

  test('rule 5: tool_use without following tool message', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'X', input: {} }],
      },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 5/);
  });

  test('rule 5: tool message without preceding tool_use', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }],
      },
    ];
    expect(() => assertCanonicalTranscript(msgs)).toThrow(/rule 5/);
  });
});
