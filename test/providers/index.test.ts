import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { resolveBaseURL } from '../../src/providers/index';

describe('resolveBaseURL', () => {
  const original = process.env['MINI_CC_BASE_URL'];

  beforeEach(() => {
    delete process.env['MINI_CC_BASE_URL'];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env['MINI_CC_BASE_URL'];
    } else {
      process.env['MINI_CC_BASE_URL'] = original;
    }
  });

  test('returns undefined when nothing set (SDK defaults win)', () => {
    expect(resolveBaseURL()).toBeUndefined();
  });

  test('picks up env override', () => {
    process.env['MINI_CC_BASE_URL'] = 'https://api.anthropic.com';
    expect(resolveBaseURL()).toBe('https://api.anthropic.com');
  });

  test('explicit argument wins over env', () => {
    process.env['MINI_CC_BASE_URL'] = 'https://api.anthropic.com';
    expect(resolveBaseURL('https://proxy.example/v1')).toBe(
      'https://proxy.example/v1',
    );
  });
});
