import { describe, test, expect } from 'bun:test';

import { assembleSystemPrompt, formatTools } from '../src/prompt';
import { DEFAULT_TOOLS } from '../src/tools/index';

describe('assembleSystemPrompt', () => {
  test('includes base + tools + cwd', () => {
    const out = assembleSystemPrompt({ tools: DEFAULT_TOOLS, cwd: '/tmp/x' });
    expect(out).toContain('mini-claw');
    expect(out).toContain('# Tools');
    expect(out).toContain('Read');
    expect(out).toContain('Write');
    expect(out).toContain('Edit');
    expect(out).toContain('Bash');
    expect(out).toContain('# Environment');
    expect(out).toContain('/tmp/x');
  });

  test('memory block appears when provided', () => {
    const out = assembleSystemPrompt({
      tools: [],
      cwd: '/',
      memory: 'SECRET MEMORY BLOCK',
    });
    expect(out).toContain('# Project memory');
    expect(out).toContain('SECRET MEMORY BLOCK');
  });

  test('memory block omitted when not provided', () => {
    const out = assembleSystemPrompt({ tools: [], cwd: '/' });
    expect(out).not.toContain('# Project memory');
  });
});

describe('formatTools', () => {
  test('empty tool list', () => {
    expect(formatTools([])).toBe('(no tools available)');
  });

  test('flags surface in bullet output', () => {
    const out = formatTools(DEFAULT_TOOLS);
    expect(out).toContain('**Read** [read-only]');
    expect(out).toContain('**Write** [destructive]');
    expect(out).toContain('**Bash** [destructive]');
  });
});
