import { z } from 'zod';

import { buildTool } from '../Tool';
import { resolveWithinCwd } from './helpers';

const DEFAULT_LIMIT = 2000;

const ReadInput = z.object({
  file_path: z
    .string()
    .describe(
      'Absolute path (preferred) or cwd-relative path to the file. Must live inside cwd — paths escaping cwd are rejected.',
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      '1-indexed line number to start reading from. Defaults to 1 (start of file).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Max number of lines to return. Defaults to ${DEFAULT_LIMIT}. Use offset+limit for paginated reads of large files.`,
    ),
});

/**
 * Read — returns file contents as line-numbered text in the format
 * "<line_number>\t<content>" (matches real Claude Code's addLineNumbers).
 *
 * Truncation: if the file has more lines than `limit` (or the default 2000),
 * output ends with a marker telling the model the next offset to read from.
 */
export const readTool = buildTool({
  name: 'Read',
  description:
    'Read a text file. Returns line-numbered content (format: "<n>\\t<line>"). Supports offset+limit for paginated reads. Paths must live inside the session cwd.',
  inputSchema: ReadInput,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, ctx) {
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const absPath = resolveWithinCwd(input.file_path, ctx.cwd);

    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${input.file_path}`);
    }
    const text = await file.text();

    if (text.length === 0) return '';

    const lines = text.split('\n');
    const total = lines.length;
    const startIdx = offset - 1;
    if (startIdx >= total) {
      return `[file has ${total} line${total === 1 ? '' : 's'}; offset=${offset} is past end]`;
    }
    const endIdx = Math.min(startIdx + limit, total);
    const slice = lines.slice(startIdx, endIdx);

    const formatted = slice
      .map((line, i) => `${offset + i}\t${line}`)
      .join('\n');

    if (endIdx < total) {
      const nextOffset = endIdx + 1;
      return `${formatted}\n[truncated — file has ${total} lines; re-read with offset=${nextOffset} to continue]`;
    }
    return formatted;
  },
});
