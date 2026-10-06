import { Controller, Get, Req } from '@nestjs/common';
import { ZodError } from 'zod';

import { Public } from '../authorization/registry/module-permissions.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { requestIdOf } from '../platform-kernel/http/request-context.js';
import { AllowSuspended } from '../platform-kernel/http/tenant-resolver.middleware.js';
import { BusinessCalendarError } from '../sla/business-calendar.js';
import { businessHoursRowToCalendar } from '../sla/business-hours.mapper.js';
import { SlaRepository } from '../sla/sla.repository.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { Request } from 'express';

/**
 * What the customer chat needs before anybody signs in (contracts/customer.yaml
 * `GET /customer/branding`): the workspace's name and look, whether strangers may register, and
 * whether support is reachable at all.
 *
 * It is `@Public()` and `@AllowSuspended()` on purpose: a suspended workspace must still be able
 * to say so (`available: false`), which is the whole point of the customer unavailable page
 * (FR-004). Nothing here is business data.
 */

export interface BrandingDto {
  tenantName: string;
  logoUrl: string | null;
  colors: { primary?: string; accent?: string };
  welcomeMessage: string | null;
  selfRegistration: boolean;
  available: boolean;
  /** FR-054: set only outside the workspace's business hours, when configured. */
  outOfHoursMessage: string | null;
}

@Controller('customer/branding')
export class BrandingController {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Public()
  @AllowSuspended()
  async branding(@Req() req: Request): Promise<BrandingDto> {
    const tenant = req.tenant;
    if (tenant === undefined) throw new Error('Branding needs a resolved tenant');
    // No actor: the caller is anonymous, and the settings row is the tenant's own.
    const ctx = TenantContext.create({
      tenantId: tenant.id,
      actor: { kind: 'system' },
      requestId: requestIdOf(req),
      readOnly: true,
    });
    const { settings, outOfHoursMessage } = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await new BrandingRepository(ctx).settings(tx);
      return { settings: row, outOfHoursMessage: await this.outOfHoursMessage(ctx, tx, row) };
    });

    return {
      tenantName: settings?.name ?? tenant.slug,
      // Attachment-backed logos arrive with US16; the column is already here.
      logoUrl: null,
      colors: brandColors(settings?.brand_colors),
      welcomeMessage: settings?.welcome_message ?? null,
      // A suspended workspace accepts nobody, whatever the setting says.
      selfRegistration: tenant.status === 'active' && (settings?.self_registration ?? false),
      available: tenant.status === 'active',
      outOfHoursMessage,
    };
  }

  /**
   * The configured message, only while now (the injected clock) is outside the tenant's business
   * hours. Null with no message, no calendar, an unusable calendar, or while the workspace is open.
   * Chat stays available either way (FR-054).
   */
  private async outOfHoursMessage(ctx: TenantContext, tx: TenantTransaction, settings: BrandingSettings | undefined): Promise<string | null> {
    const message = settings?.out_of_hours_message?.trim();
    const hoursId = settings?.business_hours_id;
    if (message === undefined || message === '' || hoursId === undefined || hoursId === null) return null;
    const hours = await new SlaRepository(ctx).businessHours(tx, hoursId);
    if (hours === undefined) return null;
    try {
      return businessHoursRowToCalendar(hours).isWithinBusinessHours(this.clock.now()) ? null : message;
    } catch (error) {
      if (error instanceof BusinessCalendarError || error instanceof ZodError) return null;
      throw error;
    }
  }
}

/** `brand_colors` is free-form json in the database; only known string keys reach the client. */
function brandColors(value: JsonValue | undefined): { primary?: string; accent?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const { primary, accent } = value as { primary?: unknown; accent?: unknown };
  return {
    ...(typeof primary === 'string' ? { primary } : {}),
    ...(typeof accent === 'string' ? { accent } : {}),
  };
}

type BrandingSettings = Awaited<ReturnType<BrandingRepository['settings']>> & object;

class BrandingRepository extends TenantRepository {
  settings(tx: TenantTransaction) {
    return this.selectFrom(tx, 'tenant_settings')
      .innerJoin('tenants', 'tenants.id', 'tenant_settings.tenant_id')
      .select([
        'tenants.name',
        'tenant_settings.brand_colors',
        'tenant_settings.welcome_message',
        'tenant_settings.self_registration',
        'tenant_settings.out_of_hours_message',
        'tenant_settings.business_hours_id',
      ])
      .executeTakeFirst();
  }
}
