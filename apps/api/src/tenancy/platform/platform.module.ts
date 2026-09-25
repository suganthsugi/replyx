import { Module } from '@nestjs/common';

import { IdentityModule } from '../../identity/identity.module.js';
import { TenancyHttpModule } from '../tenancy-http.module.js';
import { TenancyModule } from '../tenant-provisioning.service.js';

import { OperatorAuthController } from './operator-auth.controller.js';
import { OperatorAuthGuard } from './operator-auth.guard.js';
import { OperatorBootstrap } from './operator-bootstrap.js';
import { OperatorSessionService } from './operator-session.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

/**
 * The platform console API (`/platform/*`, console host only). Operators are global, so nothing
 * here is tenant-scoped; the guard is registered by the api pipeline beside the tenant one.
 */
@Module({
  imports: [IdentityModule, TenancyModule, TenancyHttpModule],
  controllers: [OperatorAuthController, TenantsController],
  providers: [OperatorSessionService, OperatorAuthGuard, OperatorBootstrap, TenantsService],
  exports: [OperatorSessionService, OperatorAuthGuard, TenantsService],
})
export class PlatformModule {}
