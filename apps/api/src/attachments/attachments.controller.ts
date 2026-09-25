import { Controller, Post, Req, UseInterceptors } from '@nestjs/common';

import { CustomerApi, RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';

import { AttachmentsService, type UploadedAttachmentDto } from './attachments.service.js';
import { UploadInterceptor, type UploadedFile } from './upload.interceptor.js';

import type { Request } from 'express';

/**
 * Uploads for a later message (contracts/tickets.yaml `POST /attachments`, customer.yaml
 * `POST /customer/attachments`): multipart with one `file` part. 201 with `scanStatus: pending`;
 * 413 `ATTACHMENT_TOO_LARGE` over 25 MB, 415 `ATTACHMENT_TYPE_NOT_ALLOWED` for other types.
 */

function uploadOf(req: Request): UploadedFile {
  if (req.upload === undefined) throw new Error('Route needs the UploadInterceptor');
  return req.upload;
}

function actorIdOf(req: Request): string {
  if (req.actor === undefined) throw new Error('Route needs an authenticated actor');
  return req.actor.userId;
}

@Controller('attachments')
export class StaffAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** Anyone who may reply somewhere may upload; sending checks the ticket. */
  @Post()
  @RequirePermission('ticket.edit')
  @UseInterceptors(UploadInterceptor)
  upload(@Req() req: Request): Promise<UploadedAttachmentDto> {
    return this.attachments.upload(tenantContextOf(req), actorIdOf(req), uploadOf(req));
  }
}

@Controller('customer/attachments')
export class CustomerAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @CustomerApi()
  @UseInterceptors(UploadInterceptor)
  upload(@Req() req: Request): Promise<UploadedAttachmentDto> {
    return this.attachments.upload(tenantContextOf(req), actorIdOf(req), uploadOf(req));
  }
}
