import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { IANAZone } from 'luxon';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { AUDIT_RETENTIONS, RETENTION_PERIODS } from './retention/retention-period.js';
import { TenantSettingsService, type TenantSettingsDto } from './settings.service.js';

import type { Request } from 'express';

/**
 * Tenant settings (contracts/operations.yaml `/settings`, T183). `tenant_settings.view` /
 * `tenant_settings.edit` are declared in `authorization/registry/initial-permissions.ts`.
 * `businessHoursId` and `notificationDefaults` are not accepted here yet (see
 * `settings.service.ts`); `.strict()` rejects them as unknown keys rather than silently ignoring
 * them. `retentionPeriod` / `auditRetention` (T193) are accepted; shortening `retentionPeriod`
 * needs `confirmPurgeCount`, shortening `auditRetention` needs `confirmAuditPurgeCount`.
 */

const HexColor = z.string().trim().regex(/^#[0-9a-f]{6}$/i, { message: 'invalid_format' });

const BrandColors = z
  .object({
    primary: HexColor.optional(),
    accent: HexColor.optional(),
  })
  .strict();

const Timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((zone) => IANAZone.isValidZone(zone), { message: 'invalid_timezone' });

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    logoAttachmentId: z.uuid().nullable().optional(),
    brandColors: BrandColors.optional(),
    welcomeMessage: z.string().trim().max(500).nullable().optional(),
    timezone: Timezone.optional(),
    selfRegistration: z.boolean().optional(),
    gracePeriodHours: z.int().min(1).max(720).optional(),
    afterCloseBehavior: z.enum(['new_follow_up', 'reopen_previous']).optional(),
    offlineCustomerNotification: z.enum(['email', 'off']).optional(),
    outOfHoursMessage: z.string().trim().max(500).nullable().optional(),
    retentionPeriod: z.enum(RETENTION_PERIODS).optional(),
    auditRetention: z.enum(AUDIT_RETENTIONS).optional(),
    confirmPurgeCount: z.int().min(0).optional(),
    confirmAuditPurgeCount: z.int().min(0).optional(),
  })
  .strict();

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @RequirePermission('tenant_settings.view')
  get(@Req() req: Request): Promise<TenantSettingsDto> {
    return this.settings.get(tenantContextOf(req));
  }

  @Patch()
  @RequirePermission('tenant_settings.edit')
  update(
    @Req() req: Request,
    @Body(new ZodValidationPipe(PatchBody)) body: z.infer<typeof PatchBody>,
  ): Promise<TenantSettingsDto> {
    return this.settings.update(tenantContextOf(req), body);
  }
}
