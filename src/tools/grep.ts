import { z } from 'zod';

import { buildTool } from '../Tool';
import { resolveWithinCwd } from './helpers';

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 1000;

const GrepInput = z.object({
  pattern: z
    .string()
    .describe(
      'Regex or literal pattern. Passed to ripgrep verbatim — use --fixed-strings? No, this tool always treats it as a regex. Escape as needed.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Root directory or file (absolute or cwd-relative). Defaults to cwd. Must live inside cwd.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Ripgrep --glob filter, e.g. "*.ts" or "!*.test.ts". Can be passed to scope which files rg searches.',
    ),
  case_insensitive: z
    .boolean()
    .optional()
    .describe(
      'When true, match case-insensitively (rg -i). Default false (rg -S smart case).',
    ),
});

/**
 * Grep — search file contents with ripgrep.
 *
 * Shells out to `rg` exactly like real Claude Code. Flags:
 *   -n  line numbers
 *   -H  always prefix with filename (even for single-file searches)
 *   -S  smart case (default) — becomes -i when case_insensitive is true
 *   --glob <g>   filter by glob pattern
 *
 * Return shape: ripgrep's stdout, capped at 50 KB / 1000 lines. Exit code 1
 * from rg means "no matches" — returned as "(no matches)" instead of
 * thrown. Any other non-zero exit surfaces rg's stderr so the LLM can see
 * what went wrong.
 *
 * Requires `rg` on PATH. On first invocation we probe `rg --version`;
 * ENOENT produces a clear "install ripgrep" error message.
 */
export const grepTool = buildTool({
  name: 'Grep',
  description:
    'Search file contents with ripgrep. Returns file:line:match entries, one per line. Requires ripgrep installed (brew install ripgrep).',
  inputSchema: GrepInput,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, ctx) {
    await ensureRgAvailable();

    const root = input.path
      ? resolveWithinCwd(input.path, ctx.cwd)
      : ctx.cwd;

    const args = ['-n', '-H'];
    if (input.case_insensitive) args.push('-i');
    else args.push('-S');
    if (input.glob) args.push('--glob', input.glob);
    args.push('--', input.pattern, root);

    const proc = Bun.spawn({
      cmd: ['rg', ...args],
      cwd: ctx.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctx.signal,
    });

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ]);

    // rg exit 1 = no matches. That's not a failure — return a tidy message.
    if (exitCode === 1 && stderrText.length === 0) {
      return '(no matches)';
    }
    if (exitCode !== 0) {
      return `rg exited ${exitCode}\n--- stderr ---\n${stderrText}`;
    }

    return truncate(stdoutText);
  },
});

// ---------- helpers ----------

let rgChecked = false;
let rgAvailable = false;

async function ensureRgAvailable(): Promise<void> {
  if (rgChecked) {
    if (!rgAvailable) throw rgMissingError();
    return;
  }
  rgChecked = true;
  try {
    const probe = Bun.spawn({
      cmd: ['rg', '--version'],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const code = await probe.exited;
    rgAvailable = code === 0;
  } catch {
    rgAvailable = false;
  }
  if (!rgAvailable) throw rgMissingError();
}

function rgMissingError(): Error {
  return new Error(
    'Grep requires ripgrep (rg) on PATH. Install with `brew install ripgrep` (macOS) or `apt install ripgrep` (Debian/Ubuntu).',
  );
}

/** Exported for tests. Resets the cached rg-availability probe. */
export function __resetRgCacheForTests(): void {
  rgChecked = false;
  rgAvailable = false;
}

function truncate(text: string): string {
  const lines = text.split('\n');
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (lines.length <= MAX_OUTPUT_LINES && byteLen <= MAX_OUTPUT_BYTES) {
    return text;
  }
  let out: string[] = lines;
  if (lines.length > MAX_OUTPUT_LINES) {
    out = lines.slice(0, MAX_OUTPUT_LINES);
  }
  let joined = out.join('\n');
  if (Buffer.byteLength(joined, 'utf8') > MAX_OUTPUT_BYTES) {
    joined = joined.slice(0, MAX_OUTPUT_BYTES);
  }
  return `${joined}\n[truncated — results exceeded limit (${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes)]`;
}
