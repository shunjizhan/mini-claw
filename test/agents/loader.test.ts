import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAgents,
  parseAgentFile,
  parseAgentTools,
} from '../../src/agents/loader';

function makeTmpRoots(): { cwd: string; user: string } {
  const root = mkdtempSync(join(tmpdir(), 'mini-cc-agents-'));
  const cwd = join(root, 'project');
  const user = join(root, 'user');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(user, { recursive: true });
  return { cwd, user };
}

async function writeAgent(
  rootAgentsDir: string,
  filename: string,
  body: string,
): Promise<void> {
  mkdirSync(rootAgentsDir, { recursive: true });
  await Bun.write(join(rootAgentsDir, filename), body);
}

describe('parseAgentFile', () => {
  test('extracts frontmatter description + body as prompt', () => {
    const raw = `---
description: Use when researching the codebase.
tools: [Read, Glob, Grep]
---

You are an explorer. Search broadly, narrow down.
Return a punchy report.
`;
    const parsed = parseAgentFile(raw, 'explorer');
    expect(parsed).not.toBeNull();
    expect(parsed!.agentType).toBe('explorer');
    expect(parsed!.whenToUse).toBe('Use when researching the codebase.');
    expect(parsed!.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(parsed!.prompt).toContain('You are an explorer');
    expect(parsed!.prompt).toContain('punchy report');
  });

  test('description falls back to first non-heading body line', () => {
    const raw = `---
tools: ["*"]
---

# Heading
The actual whenToUse sentence.
More body.
`;
    const parsed = parseAgentFile(raw, 'noop');
    expect(parsed).not.toBeNull();
    expect(parsed!.whenToUse).toBe('The actual whenToUse sentence.');
    // ['*'] in frontmatter → undefined (= all parent tools)
    expect(parsed!.tools).toBeUndefined();
  });

  test('missing description AND empty body → null (skipped silently)', () => {
    const parsed = parseAgentFile('---\n---\n', 'empty');
    expect(parsed).toBeNull();
  });

  test('body-only with no usable description line → null', () => {
    // Body has only headings → no whenToUse can be derived
    const parsed = parseAgentFile('# Only Heading\n## Sub\n', 'headings-only');
    expect(parsed).toBeNull();
  });

  test('no frontmatter: falls back to first body line, no tools restriction', () => {
    const parsed = parseAgentFile(
      'This is the description line.\nBody continues.\n',
      'plain',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.whenToUse).toBe('This is the description line.');
    expect(parsed!.tools).toBeUndefined();
    expect(parsed!.prompt).toContain('Body continues.');
  });

  test('agentType comes from filename stem', () => {
    const parsed = parseAgentFile(
      '---\ndescription: x\n---\n\nbody\n',
      'my-helper',
    );
    expect(parsed!.agentType).toBe('my-helper');
  });
});

describe('parseAgentTools', () => {
  test('undefined → undefined (all tools)', () => {
    expect(parseAgentTools(undefined)).toBeUndefined();
    expect(parseAgentTools(null)).toBeUndefined();
  });

  test('"*" string → undefined', () => {
    expect(parseAgentTools('*')).toBeUndefined();
  });

  test('["*"] array → undefined', () => {
    expect(parseAgentTools(['*'])).toBeUndefined();
  });

  test('array of names → trimmed array', () => {
    expect(parseAgentTools(['Read', ' Glob ', 'Grep'])).toEqual([
      'Read',
      'Glob',
      'Grep',
    ]);
  });

  test('comma-separated string → split + trimmed', () => {
    expect(parseAgentTools('Read, Glob,Grep ')).toEqual([
      'Read',
      'Glob',
      'Grep',
    ]);
  });

  test('empty array → [] (no tools)', () => {
    expect(parseAgentTools([])).toEqual([]);
  });

  test('empty string → [] (no tools)', () => {
    expect(parseAgentTools('')).toEqual([]);
  });
});

describe('loadAgents', () => {
  test('discovers project + user agents, sorted-by-agentType', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeAgent(
        join(cwd, '.mini-cc', 'agents'),
        'alpha.md',
        '---\ndescription: A\n---\nbody A\n',
      );
      await writeAgent(
        user,
        'charlie.md',
        '---\ndescription: C\n---\nbody C\n',
      );
      const agents = await loadAgents({ cwd, userAgentsDir: user });
      expect(agents.map((a) => a.agentType)).toEqual(['alpha', 'charlie']);
      expect(agents.find((a) => a.agentType === 'alpha')?.source).toBe(
        'project',
      );
      expect(agents.find((a) => a.agentType === 'charlie')?.source).toBe(
        'user',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('first-wins: project agent hides user agent with the same agentType', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeAgent(
        join(cwd, '.mini-cc', 'agents'),
        'shared.md',
        '---\ndescription: from-project\n---\nproject body\n',
      );
      await writeAgent(
        user,
        'shared.md',
        '---\ndescription: from-user\n---\nuser body\n',
      );
      const agents = await loadAgents({ cwd, userAgentsDir: user });
      expect(agents).toHaveLength(1);
      expect(agents[0]?.source).toBe('project');
      expect(agents[0]?.whenToUse).toBe('from-project');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('missing agent directories → returns empty array (no error)', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      const agents = await loadAgents({ cwd, userAgentsDir: user });
      expect(agents).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('non-.md files in agents dir are ignored', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeAgent(
        join(cwd, '.mini-cc', 'agents'),
        'good.md',
        '---\ndescription: ok\n---\nbody\n',
      );
      await Bun.write(
        join(cwd, '.mini-cc', 'agents', 'README.txt'),
        'not an agent',
      );
      const agents = await loadAgents({ cwd, userAgentsDir: user });
      expect(agents.map((a) => a.agentType)).toEqual(['good']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('agent files with no description and empty body are skipped silently', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeAgent(
        join(cwd, '.mini-cc', 'agents'),
        'broken.md',
        '---\n---\n',
      );
      await writeAgent(
        join(cwd, '.mini-cc', 'agents'),
        'good.md',
        '---\ndescription: ok\n---\nbody\n',
      );
      const agents = await loadAgents({ cwd, userAgentsDir: user });
      expect(agents.map((a) => a.agentType)).toEqual(['good']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });
});
