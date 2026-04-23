import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import { buildTool } from '../Tool';
import { resolveWithinCwd } from './helpers';

const WriteInput = z.object({
  file_path: z
    .string()
    .describe(
      'Absolute path (preferred) or cwd-relative path. Parent directory must already exist (no implicit mkdir).',
    ),
  content: z.string().describe('Full file content. Overwrites any existing file.'),
});

/**
 * Write — create or overwrite a file with the given content.
 *
 * No implicit mkdir — parent directory must exist (error otherwise, per design
 * doc). No pre-read diff in Tier 1; we just report whether this was a create
 * or update and how many bytes landed. Atomic semantics are intentionally
 * not guaranteed — use Edit for in-place modification.
 */
export const writeTool = buildTool({
  name: 'Write',
  description:
    'Create or overwrite a file. Parent directory must exist. Returns "Created"/"Updated" with byte count.',
  inputSchema: WriteInput,
  isDestructive: true,
  async checkPermissions(input) {
    const bytes = Buffer.byteLength(input.content, 'utf8');
    return {
      behavior: 'ask',
      prompt: `Write ${bytes} bytes to ${input.file_path}?`,
    };
  },
  async call(input, ctx) {
    const absPath = resolveWithinCwd(input.file_path, ctx.cwd);
    // Bun.write auto-creates parents by default; the spec says Tier 1 must
    // error instead, so we stat the parent explicitly first.
    const parent = path.dirname(absPath);
    try {
      const st = await stat(parent);
      if (!st.isDirectory()) {
        throw new Error(`Parent is not a directory: ${parent}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Parent directory does not exist: ${parent}`);
      }
      throw err;
    }
    const existed = await Bun.file(absPath).exists();
    await Bun.write(absPath, input.content);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    return existed
      ? `Updated ${input.file_path} (${bytes} bytes)`
      : `Created ${input.file_path} (${bytes} bytes)`;
  },
});
