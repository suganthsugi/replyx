import type { Readable } from 'node:stream';

/**
 * Where attachment bytes live (research D17). Two areas per tenant: `quarantine` for uploads
 * that haven't been scanned yet and `files` for clean ones. Keys are
 * `{tenantId}/{quarantine|files}/{attachmentId}` and never leave the API.
 *
 * `local` (default) is a directory on a Docker volume; `s3` is any S3-compatible store, chosen
 * with `FILE_STORAGE=s3`. Adapters never decide anything: validation, scanning and access
 * checks happen before they are called.
 */

export type StorageArea = 'quarantine' | 'files';

export interface StoredObject {
  tenantId: string;
  attachmentId: string;
  area: StorageArea;
}

export interface DownloadOptions {
  fileName: string;
  contentType: string;
  /** `inline` only for safe image types. */
  disposition: 'inline' | 'attachment';
  expiresInSeconds: number;
}

export interface FileStorage {
  readonly kind: 'local' | 's3';
  put(object: StoredObject, body: Buffer): Promise<void>;
  read(object: StoredObject): Promise<Readable>;
  /** Moves a scanned file out of quarantine. */
  promote(tenantId: string, attachmentId: string): Promise<void>;
  /** Missing objects are not an error. */
  delete(object: StoredObject): Promise<void>;
  /** A direct, expiring download URL when the store can serve files itself (S3 presigning). */
  presignedUrl?(object: StoredObject, options: DownloadOptions): Promise<string>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `{tenantId}/{area}/{attachmentId}`; ids are checked so a key can never escape its tenant. */
export function storageKey(object: StoredObject): string {
  if (!UUID.test(object.tenantId) || !UUID.test(object.attachmentId)) {
    throw new Error('Storage keys are built from tenant and attachment uuids only');
  }
  return `${object.tenantId}/${object.area}/${object.attachmentId}`;
}
