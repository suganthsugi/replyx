import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';

import { BrandingController } from './branding.controller.js';
import { SettingsController } from './settings.controller.js';
import { TenantSettingsService } from './settings.service.js';
import { SupportAccessController } from './support-access.controller.js';
import { SupportAccessService } from './support-access.service.js';
import { SuspensionService } from './suspension.service.js';
import { TenancyModule } from './tenant-provisioning.service.js';

/**
 * Tenant lifecycle beyond provisioning: suspension, support access and tenant settings, plus the
 * tenant-host routes that use them. It is api-only, because suspension ends sessions
 * (IdentityModule) and the worker has no reason to carry the HTTP surface.
 */
@Module({
  imports: [IdentityModule, TenancyModule],
  controllers: [SupportAccessController, BrandingController, SettingsController],
  providers: [SuspensionService, SupportAccessService, TenantSettingsService],
  exports: [SuspensionService, SupportAccessService],
})
export class TenancyHttpModule {}
