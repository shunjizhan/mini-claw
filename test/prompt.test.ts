import { describe, test, expect } from 'bun:test';

import {
  assembleSystemPrompt,
  formatSkills,
  formatTools,
} from '../src/prompt';
import { DEFAULT_TOOLS } from '../src/tools/index';
import type { Skill } from '../src/skills/loader';

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

  test('skills block appears when skills provided', () => {
    const skills: Skill[] = [
      {
        name: 'greet',
        description: 'Say hello.',
        whenToUse: 'When the user says hi.',
        body: 'body',
        source: 'project',
        filePath: '/fake',
      },
    ];
    const out = assembleSystemPrompt({ tools: [], cwd: '/', skills });
    expect(out).toContain('# Available skills');
    expect(out).toContain('**greet**: Say hello.');
    expect(out).toContain('use when: When the user says hi.');
  });

  test('skills block omitted when empty list', () => {
    const out = assembleSystemPrompt({ tools: [], cwd: '/', skills: [] });
    expect(out).not.toContain('# Available skills');
  });
});

describe('formatSkills', () => {
  test('renders name + description bullet', () => {
    const out = formatSkills([
      {
        name: 'foo',
        description: 'Does foo.',
        body: '',
        source: 'project',
        filePath: '/x',
      },
    ]);
    expect(out).toBe('- **foo**: Does foo.');
  });

  test('appends when_to_use as a second line when present', () => {
    const out = formatSkills([
      {
        name: 'foo',
        description: 'Does foo.',
        whenToUse: 'When foo is needed.',
        body: '',
        source: 'project',
        filePath: '/x',
      },
    ]);
    expect(out).toContain('- **foo**: Does foo.');
    expect(out).toContain('(use when: When foo is needed.)');
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
