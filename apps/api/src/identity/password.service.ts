import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing (research D5): argon2id with the OWASP Password Storage Cheat Sheet minimum
 * (19 MiB memory, 2 iterations, parallelism 1). Hashes are PHC strings, so the parameters travel
 * with each hash and `needsRehash` can upgrade old ones on the next successful sign-in.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Bounds from contracts/identity.yaml; longer input is rejected before hashing (no DoS). */
export const PASSWORD_MAX_LENGTH = 200;

@Injectable()
export class PasswordService {
  // A real argon2id hash of a random secret, so verifying against a missing user costs the same
  // as verifying against a real one. Created on first use.
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * True only when `password` matches `hash`. With no hash (unknown email, customer without a
   * password, invited user) it still runs a full argon2id verification and returns false, so the
   * response time does not reveal whether the account exists.
   */
  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (password.length > PASSWORD_MAX_LENGTH) return false;
    if (hash === null || hash === undefined || hash === '') {
      await this.safeVerify(await this.dummy(), password);
      return false;
    }
    return this.safeVerify(hash, password);
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      return true;
    }
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= argon2.hash(randomBytes(32).toString('base64url'), ARGON2_OPTIONS);
    return this.dummyHash;
  }

  /** A malformed stored hash is a failed verification, never a 500. */
  private async safeVerify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
