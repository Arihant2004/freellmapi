import { describe, it, expect, afterEach } from 'vitest';
import { publicApiUrl } from '../../routes/settings.js';

describe('PUBLIC_API_URL (Keys page "For your websites" panel)', () => {
  const original = process.env.PUBLIC_API_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = original;
  });

  it('is null when unset or blank', () => {
    delete process.env.PUBLIC_API_URL;
    expect(publicApiUrl()).toBeNull();
    process.env.PUBLIC_API_URL = '   ';
    expect(publicApiUrl()).toBeNull();
  });

  it('returns an http(s) URL trimmed of whitespace and trailing slashes', () => {
    process.env.PUBLIC_API_URL = ' https://freellmapi.tail33e0b4.ts.net/v1/ ';
    expect(publicApiUrl()).toBe('https://freellmapi.tail33e0b4.ts.net/v1');
  });

  it('ignores anything that is not an http(s) URL', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://example.com/v1', 'not a url']) {
      process.env.PUBLIC_API_URL = bad;
      expect(publicApiUrl(), bad).toBeNull();
    }
  });
});
