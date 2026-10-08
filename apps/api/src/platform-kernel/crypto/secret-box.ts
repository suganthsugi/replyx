import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals tenant-supplied secrets (AI provider keys, store keys) at rest (specs/002-ai-assist
 * research R2). AES-256-GCM with a random 96-bit IV; the stored form is
 * `v1:<iv>:<tag>:<ciphertext>` (base64url parts), so a later key rotation can add `v2`.
 *
 * The key is `REPLYX_SECRETS_KEY`: 64 hex characters (32 bytes). It must never change once secrets
 * are stored. Sealed values never leave the API and plaintext is opened only where it is used.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string | undefined = process.env.REPLYX_SECRETS_KEY) {
    if (hexKey === undefined || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
      throw new Error('REPLYX_SECRETS_KEY must be set to 64 hex characters (32 bytes)');
    }
    this.key = Buffer.from(hexKey, 'hex');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
  }

  /** Throws on a tampered value, an unknown version, or a different key. */
  open(sealed: string): string {
    const [version, iv, tag, ciphertext, ...rest] = sealed.split(':');
    if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined || rest.length > 0) {
      throw new Error('Unrecognized sealed secret');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** The only part of a secret that may be shown back (FR-001). */
export function last4(secret: string): string {
  return secret.slice(-4);
}
