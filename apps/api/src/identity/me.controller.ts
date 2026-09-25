import { Body, Controller, Get, HttpCode, Patch, Put, Req } from '@nestjs/common';
import { IANAZone } from 'luxon';
import { z } from 'zod';

import { StaffApi } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MeService, type MeDto } from './me.service.js';
import { PASSWORD_MAX_LENGTH } from './password.service.js';
import { PASSWORD_MIN_LENGTH } from './staff-auth.controller.js';

import type { Request } from 'express';

/** The signed-in staff user's own account (contracts/identity.yaml `/me*`). */

const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Avatars need the attachments module; until then only clearing is accepted.
    avatarAttachmentId: z.null().optional(),
    availability: z.enum(['online', 'away', 'offline']).optional(),
    timeDisplay: z
      .object({
        timezone: z
          .string()
          .max(64)
          .refine((zone) => IANAZone.isValidZone(zone), { message: 'invalid_timezone' })
          .optional(),
        hour12: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ChangePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @StaffApi()
  get(@Req() req: Request): Promise<MeDto> {
    return this.me.me(tenantContextOf(req));
  }

  @Patch()
  @StaffApi()
  update(@Req() req: Request, @Body(new ZodValidationPipe(UpdateMeBody)) body: z.infer<typeof UpdateMeBody>): Promise<MeDto> {
    return this.me.update(tenantContextOf(req), body);
  }

  /** 204; every other session of the user ends. */
  @Put('password')
  @StaffApi()
  @HttpCode(204)
  async changePassword(
    @Req() req: Request,
    @Body(new ZodValidationPipe(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
  ): Promise<void> {
    await this.me.changePassword(tenantContextOf(req), req.actor?.sessionId ?? '', body.currentPassword, body.newPassword);
  }
}
