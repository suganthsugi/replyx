import { Module } from '@nestjs/common';

import { IdentityModule } from '../../identity/identity.module.js';

import { OperatorAuthController } from './operator-auth.controller.js';
import { OperatorAuthGuard } from './operator-auth.guard.js';
import { OperatorBootstrap } from './operator-bootstrap.js';
import { OperatorSessionService } from './operator-session.service.js';

/**
 * The platform console API (`/platform/*`, console host only). Operators are global, so nothing
 * here is tenant-scoped; the guard is registered by the api pipeline beside the tenant one.
 */
@Module({
  imports: [IdentityModule],
  controllers: [OperatorAuthController],
  providers: [OperatorSessionService, OperatorAuthGuard, OperatorBootstrap],
  exports: [OperatorSessionService, OperatorAuthGuard],
})
export class PlatformModule {}
