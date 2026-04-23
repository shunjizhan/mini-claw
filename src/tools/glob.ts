import { z } from 'zod';

import { buildTool } from '../Tool';
import { resolveWithinCwd } from './helpers';

const DEFAULT_LIMIT = 500;

const GlobInput = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern, e.g. "**/*.ts" or "src/tools/*.test.ts". Bun.Glob syntax.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Root directory for the scan (absolute or cwd-relative). Defaults to cwd. Must live inside cwd.',
    ),
});

/**
 * Glob — list files whose paths match a pattern, sorted.
 *
 * Uses Bun.Glob. Returns cwd-relative paths (one per line), sorted, capped
 * at DEFAULT_LIMIT with a trailing notice when truncated. Dotfiles are
 * excluded by default (Bun.Glob default), matching real-CC behavior.
 */
export const globTool = buildTool({
  name: 'Glob',
  description:
    'List files matching a glob pattern. Returns cwd-relative paths, one per line, sorted. Uses Bun.Glob (supports **, *, ?, character classes).',
  inputSchema: GlobInput,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, ctx) {
    const root = input.path
      ? resolveWithinCwd(input.path, ctx.cwd)
      : ctx.cwd;

    const glob = new Bun.Glob(input.pattern);
    const matches: string[] = [];
    for await (const match of glob.scan({ cwd: root, absolute: false })) {
      matches.push(match);
      if (matches.length > DEFAULT_LIMIT) break;
    }

    if (matches.length === 0) return '(no matches)';

    matches.sort();
    const truncated = matches.length > DEFAULT_LIMIT;
    const shown = truncated ? matches.slice(0, DEFAULT_LIMIT) : matches;
    const body = shown.join('\n');
    return truncated
      ? `${body}\n[truncated — more than ${DEFAULT_LIMIT} matches]`
      : body;
  },
});
