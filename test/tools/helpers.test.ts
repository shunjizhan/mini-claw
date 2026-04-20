import { describe, test, expect } from 'bun:test';
import { resolveWithinCwd } from '../../src/tools/helpers';

describe('resolveWithinCwd', () => {
  test('absolute path inside cwd', () => {
    expect(resolveWithinCwd('/tmp/foo/a.txt', '/tmp/foo')).toBe('/tmp/foo/a.txt');
  });

  test('relative path resolves against cwd', () => {
    expect(resolveWithinCwd('a.txt', '/tmp/foo')).toBe('/tmp/foo/a.txt');
    expect(resolveWithinCwd('./sub/a.txt', '/tmp/foo')).toBe('/tmp/foo/sub/a.txt');
  });

  test('rejects absolute path outside cwd', () => {
    expect(() => resolveWithinCwd('/etc/passwd', '/tmp/foo')).toThrow();
  });

  test('rejects sibling directory (startsWith false positive)', () => {
    expect(() => resolveWithinCwd('/tmp/foo-other/a.txt', '/tmp/foo')).toThrow();
  });

  test('rejects ../ traversal', () => {
    expect(() => resolveWithinCwd('../outside.txt', '/tmp/foo')).toThrow();
    expect(() => resolveWithinCwd('sub/../../outside.txt', '/tmp/foo')).toThrow();
  });
});
