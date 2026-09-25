import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';

import { SupportAccessController } from './support-access.controller.js';
import { SupportAccessService } from './support-access.service.js';
import { SuspensionService } from './suspension.service.js';
import { TenancyModule } from './tenant-provisioning.service.js';

/**
 * Tenant lifecycle beyond provisioning: suspension and support access, plus the tenant-host
 * routes that use them. It is api-only, because suspension ends sessions (IdentityModule) and
 * the worker has no reason to carry the HTTP surface.
 */
@Module({
  imports: [IdentityModule, TenancyModule],
  controllers: [SupportAccessController],
  providers: [SuspensionService, SupportAccessService],
  exports: [SuspensionService, SupportAccessService],
})
export class TenancyHttpModule {}
