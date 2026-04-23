import { rename } from 'node:fs/promises';
import { z } from 'zod';

import { buildTool } from '../Tool';
import { resolveWithinCwd } from './helpers';

const EditInput = z.object({
  file_path: z
    .string()
    .describe('Absolute path (preferred) or cwd-relative path to the file.'),
  old_string: z
    .string()
    .describe(
      'Exact text to find. Include enough surrounding context that it is unique in the file, or set replace_all:true.',
    ),
  new_string: z.string().describe('Replacement text. Must differ from old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'When true, replace every occurrence of old_string. When false (default) the match must be unique.',
    ),
});

/**
 * Edit — replace a substring in a file.
 *
 * Contract (matches real Claude Code's FileEditTool):
 *   - old_string === new_string → error (no-op edits are rejected)
 *   - 0 matches                  → error ("not found")
 *   - >1 matches with replace_all=false → error ("ambiguous")
 *   - N matches with replace_all=true → replace all
 *
 * Atomic write: content is written to a sibling tmp file, then renamed into
 * place (POSIX rename is atomic on the same filesystem). Partial writes or
 * mid-operation aborts cannot leave the target file corrupted.
 */
export const editTool = buildTool({
  name: 'Edit',
  description:
    'Replace text in a file. Errors if old_string is not found, or matches more than once without replace_all:true. Writes atomically.',
  inputSchema: EditInput,
  isDestructive: true,
  async checkPermissions(input) {
    const suffix = input.replace_all ? ' (replace all)' : '';
    return {
      behavior: 'ask',
      prompt: `Edit ${input.file_path}${suffix}?`,
    };
  },
  async call(input, ctx) {
    if (input.old_string === input.new_string) {
      throw new Error('old_string and new_string are identical — no edit would be made.');
    }
    const absPath = resolveWithinCwd(input.file_path, ctx.cwd);
    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${input.file_path}`);
    }
    const content = await file.text();

    const parts = content.split(input.old_string);
    const matchCount = parts.length - 1;
    const replaceAll = input.replace_all ?? false;

    if (matchCount === 0) {
      throw new Error(
        `old_string not found in ${input.file_path}. Check whitespace and include more surrounding context.`,
      );
    }
    if (matchCount > 1 && !replaceAll) {
      throw new Error(
        `Found ${matchCount} matches of old_string in ${input.file_path}. Set replace_all:true, or include more context to make old_string unique.`,
      );
    }

    const changesCount = replaceAll ? matchCount : 1;
    const updated = replaceAll
      ? parts.join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    const tmpPath = `${absPath}.mini-cc-tmp-${process.pid}-${Date.now()}`;
    await Bun.write(tmpPath, updated);
    await rename(tmpPath, absPath);

    return `Edited ${input.file_path} (${changesCount} replacement${changesCount === 1 ? '' : 's'})`;
  },
});
