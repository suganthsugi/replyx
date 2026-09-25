import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import multer from 'multer';

import { AppError, validationFailed } from '../platform-kernel/http/app-error.js';

import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Parses a single-file `multipart/form-data` upload (field `file`) into memory, with the 25 MB
 * limit enforced while reading: a larger file is cut off and answered with 413
 * `ATTACHMENT_TOO_LARGE` before the service sees it (FR-045). Anything but exactly one `file`
 * part is a validation error.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the only augmentation point
  namespace Express {
    interface Request {
      /** Set by `UploadInterceptor`. */
      upload?: UploadedFile;
    }
  }
}

export function attachmentTooLarge(): AppError {
  return new AppError('ATTACHMENT_TOO_LARGE', 413, 'Files can be at most 25 MB');
}

const parse = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 },
}).single('file');

@Injectable()
export class UploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { file?: UploadedFile }>();
    await new Promise<void>((resolve, reject) => {
      parse(req, http.getResponse<Response>(), (error: unknown) => {
        if (error === undefined || error === null) return resolve();
        if (error instanceof multer.MulterError) {
          reject(error.code === 'LIMIT_FILE_SIZE' ? attachmentTooLarge() : validationFailed([{ path: 'file', issue: 'invalid' }]));
          return;
        }
        // Not multipart, or a broken body.
        reject(validationFailed([{ path: 'file', issue: 'required' }]));
      });
    });
    if (req.file === undefined) throw validationFailed([{ path: 'file', issue: 'required' }]);
    req.upload = { originalname: req.file.originalname, buffer: req.file.buffer, size: req.file.size };
    return next.handle();
  }
}
