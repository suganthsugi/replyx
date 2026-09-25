import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { storageKey, type DownloadOptions, type FileStorage, type StoredObject } from './file-storage.js';

import type { Readable } from 'node:stream';

/**
 * Any S3-compatible object store (research D17, optional), selected with `FILE_STORAGE=s3`. The
 * bucket stays private: downloads go through presigned URLs that expire with the API's own
 * download tokens (15 minutes).
 */

export interface S3Settings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For non-AWS stores; path-style addressing is used when set. */
  endpoint?: string;
}

export function s3SettingsFromEnv(env: NodeJS.ProcessEnv = process.env): S3Settings {
  const required = (name: string) => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is required when FILE_STORAGE=s3`);
    return value;
  };
  const endpoint = env.S3_ENDPOINT;
  return {
    bucket: required('S3_BUCKET'),
    region: required('S3_REGION'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    ...(endpoint === undefined || endpoint === '' ? {} : { endpoint }),
  };
}

export class S3FileStorage implements FileStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly settings: S3Settings) {
    this.client = new S3Client({
      region: settings.region,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint, forcePathStyle: true }),
    });
  }

  async put(object: StoredObject, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: storageKey(object), Body: body }));
  }

  async read(object: StoredObject): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: storageKey(object) }));
    return result.Body as Readable;
  }

  async promote(tenantId: string, attachmentId: string): Promise<void> {
    const from = storageKey({ tenantId, attachmentId, area: 'quarantine' });
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.settings.bucket,
        CopySource: `${this.settings.bucket}/${from}`,
        Key: storageKey({ tenantId, attachmentId, area: 'files' }),
      }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: from }));
  }

  async delete(object: StoredObject): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: storageKey(object) }));
  }

  presignedUrl(object: StoredObject, options: DownloadOptions): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.settings.bucket,
        Key: storageKey(object),
        ResponseContentType: options.contentType,
        ResponseContentDisposition: contentDisposition(options.disposition, options.fileName),
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}

/** RFC 6266 with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
