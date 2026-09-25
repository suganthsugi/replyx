import { Module } from '@nestjs/common';

import { AuthGuard } from './auth.guard.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { LockoutService } from './lockout.service.js';
import { MeService } from './me.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { StaffAuthController } from './staff-auth.controller.js';
import { StaffAuthService } from './staff-auth.service.js';

/**
 * Identity (research D5): sessions, authentication, password hashing, lockout, staff sign-in and
 * password reset; invitations, customer auth and users follow in US3. The auth guard is
 * registered globally by the API pipeline, which is also what brings in the controllers.
 */
@Module({
  controllers: [StaffAuthController, InvitationsController],
  providers: [SessionService, AuthGuard, PasswordService, LockoutService, MeService, StaffAuthService, InvitationsService],
  exports: [SessionService, AuthGuard, PasswordService, LockoutService, MeService, InvitationsService],
})
export class IdentityModule {}
