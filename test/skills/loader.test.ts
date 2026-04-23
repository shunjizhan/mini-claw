import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadSkills,
  parseSkillFile,
  render,
  type Skill,
} from '../../src/skills/loader';

function makeTmpRoots(): { cwd: string; user: string } {
  const root = mkdtempSync(join(tmpdir(), 'mini-cc-skills-'));
  const cwd = join(root, 'project');
  const user = join(root, 'user');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(user, { recursive: true });
  return { cwd, user };
}

async function writeSkill(
  rootSkillsDir: string,
  name: string,
  body: string,
): Promise<void> {
  mkdirSync(join(rootSkillsDir, name), { recursive: true });
  await Bun.write(join(rootSkillsDir, name, 'SKILL.md'), body);
}

describe('parseSkillFile', () => {
  test('extracts frontmatter + body', () => {
    const raw = `---
name: foo
description: Does foo.
when_to_use: Whenever foo is needed.
---

# Foo

This is the body.
`;
    const parsed = parseSkillFile(raw, 'foo-dir');
    expect(parsed.name).toBe('foo');
    expect(parsed.description).toBe('Does foo.');
    expect(parsed.whenToUse).toBe('Whenever foo is needed.');
    expect(parsed.body).toContain('# Foo');
    expect(parsed.body).toContain('This is the body.');
  });

  test('name falls back to dirName when frontmatter lacks it', () => {
    const raw = `---
description: x
---

body
`;
    const parsed = parseSkillFile(raw, 'from-dir');
    expect(parsed.name).toBe('from-dir');
  });

  test('description falls back to first non-heading line of body', () => {
    const raw = `---
name: noop
---

# Heading
The actual description sentence.
More body.
`;
    const parsed = parseSkillFile(raw, 'noop-dir');
    expect(parsed.description).toBe('The actual description sentence.');
  });

  test('description falls back to a placeholder when body has only headings', () => {
    const raw = `---
name: only-heading
---

# Heading
## Sub
`;
    const parsed = parseSkillFile(raw, 'only-heading');
    expect(parsed.description).toContain('no description');
  });

  test('missing frontmatter → body is raw file, name=dirName', () => {
    const raw = 'plain markdown, no fences\nsecond line\n';
    const parsed = parseSkillFile(raw, 'plain');
    expect(parsed.name).toBe('plain');
    expect(parsed.body).toBe(raw);
  });

  test('malformed YAML frontmatter → falls back to dirName + first-line description', () => {
    const raw = `---
name: : broken: : yaml
---

My description.
`;
    const parsed = parseSkillFile(raw, 'fallback');
    expect(parsed.name).toBe('fallback');
    expect(parsed.description).toBe('My description.');
  });
});

describe('render', () => {
  test('substitutes $ARGUMENTS globally', () => {
    const skill: Skill = {
      name: 'echo',
      description: 'echo',
      body: 'Run: $ARGUMENTS. Then say: $ARGUMENTS.',
      source: 'project',
      filePath: '/fake',
    };
    expect(render(skill, 'hello')).toBe('Run: hello. Then say: hello.');
  });

  test('empty args → placeholder replaced with empty string', () => {
    const skill: Skill = {
      name: 'echo',
      description: 'echo',
      body: 'Say: "$ARGUMENTS"',
      source: 'project',
      filePath: '/fake',
    };
    expect(render(skill, '')).toBe('Say: ""');
  });

  test('substitutes $SKILL_DIR with the directory containing SKILL.md', () => {
    const skill: Skill = {
      name: 'with-script',
      description: 'demo',
      body: 'Run: bash "$SKILL_DIR/validate.sh"',
      source: 'project',
      filePath: '/abs/skills/with-script/SKILL.md',
    };
    expect(render(skill, '')).toBe('Run: bash "/abs/skills/with-script/validate.sh"');
  });

  test('renders $SKILL_DIR and $ARGUMENTS independently in the same body', () => {
    const skill: Skill = {
      name: 'mixed',
      description: 'demo',
      body: 'bash "$SKILL_DIR/run.sh" "$ARGUMENTS"',
      source: 'project',
      filePath: '/abs/skills/mixed/SKILL.md',
    };
    expect(render(skill, 'hello world')).toBe(
      'bash "/abs/skills/mixed/run.sh" "hello world"',
    );
  });

  test('substitutes every occurrence of $SKILL_DIR globally', () => {
    const skill: Skill = {
      name: 'multi',
      description: 'demo',
      body: '$SKILL_DIR/a.sh and $SKILL_DIR/b.sh',
      source: 'project',
      filePath: '/abs/skills/multi/SKILL.md',
    };
    expect(render(skill, '')).toBe(
      '/abs/skills/multi/a.sh and /abs/skills/multi/b.sh',
    );
  });
});

describe('loadSkills', () => {
  test('discovers project + user skills, returns sorted-by-name', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeSkill(
        join(cwd, '.mini-cc', 'skills'),
        'alpha',
        '---\nname: alpha\ndescription: A\n---\nbody A\n',
      );
      await writeSkill(
        user,
        'charlie',
        '---\nname: charlie\ndescription: C\n---\nbody C\n',
      );
      const skills = await loadSkills({ cwd, userSkillsDir: user });
      expect(skills.map((s) => s.name)).toEqual(['alpha', 'charlie']);
      expect(skills.find((s) => s.name === 'alpha')?.source).toBe('project');
      expect(skills.find((s) => s.name === 'charlie')?.source).toBe('user');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('first-wins: project skill hides user skill with the same name', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      await writeSkill(
        join(cwd, '.mini-cc', 'skills'),
        'shared',
        '---\nname: shared\ndescription: from-project\n---\nproject body\n',
      );
      await writeSkill(
        user,
        'shared',
        '---\nname: shared\ndescription: from-user\n---\nuser body\n',
      );
      const skills = await loadSkills({ cwd, userSkillsDir: user });
      expect(skills).toHaveLength(1);
      expect(skills[0]?.source).toBe('project');
      expect(skills[0]?.description).toBe('from-project');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('missing skill directories → returns empty array (no error)', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      const skills = await loadSkills({ cwd, userSkillsDir: user });
      expect(skills).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  test('skill directory without SKILL.md is skipped silently', async () => {
    const { cwd, user } = makeTmpRoots();
    try {
      mkdirSync(join(cwd, '.mini-cc', 'skills', 'empty-dir'), {
        recursive: true,
      });
      await writeSkill(
        join(cwd, '.mini-cc', 'skills'),
        'good',
        '---\nname: good\n---\nbody\n',
      );
      const skills = await loadSkills({ cwd, userSkillsDir: user });
      expect(skills.map((s) => s.name)).toEqual(['good']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });
});
