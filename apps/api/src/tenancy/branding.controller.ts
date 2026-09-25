import { Controller, Get, Req } from '@nestjs/common';

import { Public } from '../authorization/registry/module-permissions.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { requestIdOf } from '../platform-kernel/http/request-context.js';
import { AllowSuspended } from '../platform-kernel/http/tenant-resolver.middleware.js';

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
}

@Controller('customer/branding')
export class BrandingController {
  constructor(private readonly unitOfWork: UnitOfWork) {}

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
    const settings = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new BrandingRepository(ctx).settings(tx));

    return {
      tenantName: settings?.name ?? tenant.slug,
      // Attachment-backed logos arrive with US16; the column is already here.
      logoUrl: null,
      colors: brandColors(settings?.brand_colors),
      welcomeMessage: settings?.welcome_message ?? null,
      // A suspended workspace accepts nobody, whatever the setting says.
      selfRegistration: tenant.status === 'active' && (settings?.self_registration ?? false),
      available: tenant.status === 'active',
      // `outOfHoursMessage` needs business hours (US12, T208) and is added there.
    };
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

class BrandingRepository extends TenantRepository {
  settings(tx: TenantTransaction) {
    return this.selectFrom(tx, 'tenant_settings')
      .innerJoin('tenants', 'tenants.id', 'tenant_settings.tenant_id')
      .select([
        'tenants.name',
        'tenant_settings.brand_colors',
        'tenant_settings.welcome_message',
        'tenant_settings.self_registration',
      ])
      .executeTakeFirst();
  }
}
