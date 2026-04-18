import * as path from 'node:path';

/**
 * Resolve `filePath` against `cwd` and reject anything that escapes cwd.
 *
 * Accepts either absolute (preferred, per design doc) or cwd-relative paths.
 * Performs path traversal check: the resolved path must equal cwd or live
 * strictly inside cwd. Startswith-on-string is insufficient (cwd='/foo/bar'
 * would falsely accept '/foo/bar-other'); we use path.relative + a
 * traversal check instead.
 */
export function resolveWithinCwd(filePath: string, cwd: string): string {
  const absPath = path.resolve(cwd, filePath);
  if (absPath === cwd) return absPath;
  const rel = path.relative(cwd, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Path is outside working directory (cwd=${cwd}): ${filePath}`,
    );
  }
  return absPath;
}

/** Throw a tidy error if the abort signal has fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
