import { Global, Module } from '@nestjs/common';

import { CustomerRatingsController } from './customer-ratings.controller.js';
import { SatisfactionService } from './satisfaction.service.js';

/**
 * Satisfaction ratings (FR-087, spec US16). The service is global and shared by both processes, so
 * the customer conversation (MessagingModule, shared) can offer a rating without a messaging →
 * satisfaction import; the ticket, customer-profile and dashboard figures read `CsatRepository`
 * directly. The customer rating route is api only.
 */
@Global()
@Module({ providers: [SatisfactionService], exports: [SatisfactionService] })
export class SatisfactionModule {}

@Module({ controllers: [CustomerRatingsController] })
export class SatisfactionHttpModule {}
