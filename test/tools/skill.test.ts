import { describe, test, expect } from 'bun:test';

import { buildSkillTool } from '../../src/tools/skill';
import type { Skill } from '../../src/skills/loader';
import type { ToolContext } from '../../src/Tool';

function ctx(): ToolContext {
  return { cwd: '/tmp', signal: new AbortController().signal };
}

const s = (over: Partial<Skill> = {}): Skill => ({
  name: 'greet',
  description: 'Say hello.',
  body: 'Hello, $ARGUMENTS!',
  source: 'project',
  filePath: '/fake',
  ...over,
});

describe('Skill tool', () => {
  test('returns content + one injection with the rendered body', async () => {
    const tool = buildSkillTool([s()]);
    const out = await tool.call({ skill: 'greet', args: 'world' }, ctx());
    if (typeof out === 'string') throw new Error('expected object output');
    expect(out.content).toBe('Launching skill: greet');
    expect(out.injections).toEqual([{ role: 'user', text: 'Hello, world!' }]);
  });

  test('defaults args to empty string when not provided', async () => {
    const tool = buildSkillTool([s()]);
    const out = await tool.call({ skill: 'greet' }, ctx());
    if (typeof out === 'string') throw new Error('expected object output');
    expect(out.injections?.[0]?.text).toBe('Hello, !');
  });

  test('unknown skill → throws with a helpful list of available names', async () => {
    const tool = buildSkillTool([
      s({ name: 'one' }),
      s({ name: 'two' }),
    ]);
    await expect(
      tool.call({ skill: 'three' }, ctx()),
    ).rejects.toThrow(/Unknown skill.*one.*two/);
  });

  test('empty skill set: tool exists but any invocation fails clearly', async () => {
    const tool = buildSkillTool([]);
    await expect(
      tool.call({ skill: 'whatever' }, ctx()),
    ).rejects.toThrow(/Unknown skill/);
  });

  test('description changes when no skills are available', () => {
    const empty = buildSkillTool([]);
    const withOne = buildSkillTool([s()]);
    expect(empty.description).toContain('No skills');
    expect(withOne.description).not.toContain('No skills');
  });
});
