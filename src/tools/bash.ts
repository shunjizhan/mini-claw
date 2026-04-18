import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

import { buildTool } from '../Tool';

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const TRUNCATE_BYTES = 30 * 1024;
const ABORT_GRACE_MS = 5_000;
const OVERFLOW_DIR = path.join(os.homedir(), '.mini-cc', 'bash-output');

const BashInput = z.object({
  command: z
    .string()
    .describe('Shell command (bash -c). No stdin is provided — interactive commands will hang and be killed by timeout.'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SEC)
    .optional()
    .describe(
      `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}). Process gets SIGTERM, then SIGKILL after ${ABORT_GRACE_MS / 1_000}s.`,
    ),
});

/**
 * Bash — run a command via `bash -c`, capture stdout/stderr separately.
 *
 * Spec (from design doc §12):
 *   - cwd: inherited from ctx.cwd (QueryEngine's fixed cwd — no mid-session cd)
 *   - env: inherited wholesale (no filtering in Tier 1 — flagged as Tier 3
 *     security item)
 *   - stdin: closed; interactive commands will hang until timeout
 *   - stdout/stderr: captured separately, NOT line-by-line streamed
 *   - 30KB cap per stream; overflow persisted to ~/.mini-cc/bash-output/
 *   - exitCode 0 = success; non-zero is returned (never thrown) so the LLM
 *     can see the failure and adapt
 *   - Abort: SIGTERM via Bun.spawn({ signal }), SIGKILL after 5s grace;
 *     exitCode reports null to distinguish abort from timeout
 */
export const bashTool = buildTool({
  name: 'Bash',
  description:
    'Execute a shell command via `bash -c`. Returns stdout, stderr, and exit code. Default 120s timeout (max 600s). Stdout/stderr > 30KB are truncated with the full output spilled to ~/.mini-cc/bash-output/.',
  inputSchema: BashInput,
  isDestructive: true,
  async call(input, ctx) {
    const timeoutSec = Math.min(
      input.timeout ?? DEFAULT_TIMEOUT_SEC,
      MAX_TIMEOUT_SEC,
    );
    const timeoutMs = timeoutSec * 1_000;

    let timedOut = false;

    const proc = Bun.spawn({
      cmd: ['bash', '-c', input.command],
      cwd: ctx.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctx.signal,
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }, ABORT_GRACE_MS);
    }, timeoutMs);

    // Grace-period SIGKILL on external abort. Bun.spawn({ signal }) sends
    // SIGTERM automatically on abort; we escalate to SIGKILL if the process
    // ignores it.
    let killOnAbortTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      killOnAbortTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }, ABORT_GRACE_MS);
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    let exitCode: number | null = null;
    let stdoutText = '';
    let stderrText = '';
    try {
      const [rawStdout, rawStderr, code] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
        proc.exited,
      ]);
      stdoutText = rawStdout;
      stderrText = rawStderr;
      exitCode = code;
    } finally {
      clearTimeout(timeoutId);
      if (killOnAbortTimer) clearTimeout(killOnAbortTimer);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    const aborted = ctx.signal.aborted;
    const reportedExitCode = aborted ? null : exitCode;

    const pid = proc.pid;
    const stdoutFinal = await maybeTruncate(stdoutText, pid, 'stdout');
    const stderrFinal = await maybeTruncate(stderrText, pid, 'stderr');

    return formatBashResult({
      command: input.command,
      stdout: stdoutFinal,
      stderr: stderrFinal,
      exitCode: reportedExitCode,
      timedOut,
      aborted,
    });
  },
});

async function maybeTruncate(
  text: string,
  pid: number,
  stream: 'stdout' | 'stderr',
): Promise<string> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= TRUNCATE_BYTES) return text;
  await mkdir(OVERFLOW_DIR, { recursive: true });
  const outPath = path.join(OVERFLOW_DIR, `${pid}-${stream}.log`);
  await Bun.write(outPath, text);
  const head = text.slice(0, TRUNCATE_BYTES);
  return `${head}\n[truncated — ${bytes} bytes total; full output at ${outPath}]`;
}

function formatBashResult(r: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`$ ${r.command}`);
  if (r.stdout.length > 0) {
    parts.push('--- stdout ---', r.stdout);
  }
  if (r.stderr.length > 0) {
    parts.push('--- stderr ---', r.stderr);
  }
  const status = r.aborted
    ? 'aborted by user'
    : r.timedOut
      ? 'killed by timeout'
      : `exit ${r.exitCode ?? 'null'}`;
  parts.push(`--- status: ${status} ---`);
  return parts.join('\n');
}
