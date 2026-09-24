import { Module } from '@nestjs/common';

import { AuthGuard } from './auth.guard.js';
import { SessionService } from './session.service.js';

/**
 * Identity (research D5): sessions and authentication now; sign-in, invitations, password reset
 * and users arrive with US3. The auth guard is registered globally by the API pipeline.
 */
@Module({
  providers: [SessionService, AuthGuard],
  exports: [SessionService, AuthGuard],
})
export class IdentityModule {}
