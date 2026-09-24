import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { accountLocked, LockoutService } from '../../../src/identity/lockout.service.js';
import { ARGON2_OPTIONS, PasswordService } from '../../../src/identity/password.service.js';
import { Clock } from '../../../src/platform-kernel/clock.js';

class FixedClock extends Clock {
  constructor(private readonly ms: number) {
    super();
  }
  now(): Date {
    return new Date(this.ms);
  }
}

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id at the OWASP parameters', async () => {
    const hash = await passwords.hash('password-123456');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(passwords.needsRehash(hash)).toBe(false);
  });

  it('verifies the right password only', async () => {
    const hash = await passwords.hash('password-123456');
    await expect(passwords.verify(hash, 'password-123456')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'password-123457')).resolves.toBe(false);
  });

  it('returns false for a missing or malformed hash and for over-long input', async () => {
    await expect(passwords.verify(null, 'x')).resolves.toBe(false);
    await expect(passwords.verify(undefined, 'x')).resolves.toBe(false);
    await expect(passwords.verify('not-a-hash', 'x')).resolves.toBe(false);
    const hash = await passwords.hash('a'.repeat(201));
    await expect(passwords.verify(hash, 'a'.repeat(201))).resolves.toBe(false);
  });

  it('still runs a full argon2 verification for unknown users', async () => {
    // Warm up so the dummy hash creation is not part of the measurement.
    await passwords.verify(null, 'warm-up');
    const hash = await passwords.hash('password-123456');
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    const known = await time(() => passwords.verify(hash, 'wrong-password'));
    const unknown = await time(() => passwords.verify(null, 'wrong-password'));
    // Same work, so within a generous factor of each other (not an instant return).
    expect(unknown).toBeGreaterThan(known / 4);
  });

  it('asks for a rehash of weaker hashes', async () => {
    const weak = await argon2.hash('x', { ...ARGON2_OPTIONS, memoryCost: 4096 });
    expect(passwords.needsRehash(weak)).toBe(true);
    expect(passwords.needsRehash('garbage')).toBe(true);
  });
});

describe('LockoutService', () => {
  const NOW = Date.parse('2026-09-24T12:00:00Z');
  const lockout = new LockoutService(new FixedClock(NOW), {} as never);

  it('treats only a future locked_until as locked', () => {
    expect(lockout.isLocked({ locked_until: null })).toBe(false);
    expect(lockout.isLocked({ locked_until: new Date(NOW - 1) })).toBe(false);
    expect(lockout.isLocked({ locked_until: new Date(NOW) })).toBe(false);
    expect(lockout.isLocked({ locked_until: new Date(NOW + 1) })).toBe(true);
  });

  it('answers 423 ACCOUNT_LOCKED', () => {
    expect(accountLocked()).toMatchObject({ code: 'ACCOUNT_LOCKED', httpStatus: 423 });
  });
});
