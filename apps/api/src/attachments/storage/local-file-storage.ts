import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { storageKey, type FileStorage, type StoredObject } from './file-storage.js';

import type { Readable } from 'node:stream';

/**
 * Files on a local directory (research D17 default): the `replyx-files` Docker volume mounted at
 * `FILES_DIR` in the api and worker containers, included in the VM backup.
 */
export class LocalFileStorage implements FileStorage {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  async put(object: StoredObject, body: Buffer): Promise<void> {
    const path = this.path(object);
    await mkdir(dirname(path), { recursive: true });
    // `wx`: an attachment id is written once; a collision is a bug, not an overwrite.
    await writeFile(path, body, { flag: 'wx', mode: 0o640 });
  }

  read(object: StoredObject): Promise<Readable> {
    const stream = createReadStream(this.path(object));
    // Surface a missing file as a rejection rather than a stream error later.
    return new Promise((resolve, reject) => {
      stream.once('open', () => resolve(stream));
      stream.once('error', reject);
    });
  }

  async promote(tenantId: string, attachmentId: string): Promise<void> {
    const to = this.path({ tenantId, attachmentId, area: 'files' });
    await mkdir(dirname(to), { recursive: true });
    await rename(this.path({ tenantId, attachmentId, area: 'quarantine' }), to);
  }

  async delete(object: StoredObject): Promise<void> {
    await rm(this.path(object), { force: true });
  }

  private path(object: StoredObject): string {
    return join(this.root, ...storageKey(object).split('/'));
  }
}
