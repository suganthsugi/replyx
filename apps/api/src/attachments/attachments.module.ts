import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';

import { CustomerAttachmentsController, StaffAttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { FILE_STORAGE, type FileStorage } from './storage/file-storage.js';
import { LocalFileStorage } from './storage/local-file-storage.js';
import { S3FileStorage, s3SettingsFromEnv } from './storage/s3-file-storage.js';

/** `FILE_STORAGE=s3` picks the S3 adapter; anything else stores files under `FILES_DIR`. */
export function fileStorageFromEnv(env: NodeJS.ProcessEnv = process.env): FileStorage {
  if (env.FILE_STORAGE === 's3') return new S3FileStorage(s3SettingsFromEnv(env));
  return new LocalFileStorage(env.FILES_DIR ?? '/data/files');
}

/** File storage for both processes (the api uploads and serves, the worker scans). */
@Global()
@Module({
  providers: [{ provide: FILE_STORAGE, useFactory: () => fileStorageFromEnv() }],
  exports: [FILE_STORAGE],
})
export class FileStorageModule implements OnApplicationShutdown {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage) {}

  onApplicationShutdown(): void {
    if (this.storage instanceof S3FileStorage) this.storage.destroy();
  }
}

/** HTTP side of attachments (api process only). */
@Module({
  controllers: [StaffAttachmentsController, CustomerAttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsHttpModule {}
