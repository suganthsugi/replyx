import { Module } from '@nestjs/common';

import { AuthGuard } from './auth.guard.js';
import { LockoutService } from './lockout.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * Identity (research D5): sessions, authentication, password hashing and lockout now; sign-in,
 * invitations, password reset and users arrive with US3. The auth guard is registered globally
 * by the API pipeline.
 */
@Module({
  providers: [SessionService, AuthGuard, PasswordService, LockoutService],
  exports: [SessionService, AuthGuard, PasswordService, LockoutService],
})
export class IdentityModule {}
