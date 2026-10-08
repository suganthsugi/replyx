import { describe, expect, it } from 'vitest';

import { SecretBox, last4 } from '../../../src/platform-kernel/crypto/secret-box.js';

const KEY = 'a'.repeat(64);

describe('SecretBox', () => {
  it('round-trips and never stores the plaintext', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('sk-or-v1-secret-value');
    expect(sealed).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(sealed).not.toContain('secret-value');
    expect(box.open(sealed)).toBe('sk-or-v1-secret-value');
  });

  it('uses a fresh IV for every seal', () => {
    const box = new SecretBox(KEY);
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('rejects tampered values, other keys and unknown versions', () => {
    const sealed = new SecretBox(KEY).seal('value');
    const [version, iv, tag, ciphertext] = sealed.split(':') as [string, string, string, string];
    const flipped = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    expect(() => new SecretBox(KEY).open([version, iv, tag, flipped].join(':'))).toThrow();
    expect(() => new SecretBox('b'.repeat(64)).open(sealed)).toThrow();
    expect(() => new SecretBox(KEY).open(sealed.replace(/^v1/, 'v9'))).toThrow('Unrecognized sealed secret');
  });

  it('requires a 64-hex-character key', () => {
    expect(() => new SecretBox('')).toThrow('REPLYX_SECRETS_KEY');
    expect(() => new SecretBox('short')).toThrow('REPLYX_SECRETS_KEY');
    expect(() => new SecretBox('z'.repeat(64))).toThrow('REPLYX_SECRETS_KEY');
  });

  it('shows only the last 4 characters', () => {
    expect(last4('sk_live_1234abcd')).toBe('abcd');
  });
});
