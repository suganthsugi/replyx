import { Body, Controller, HttpCode, Param, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { CustomerApi } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { SatisfactionService } from './satisfaction.service.js';

import type { Request } from 'express';

/**
 * `PUT /customer/ratings/{id}` (contracts/customer.yaml, FR-087, T248): the signed-in customer
 * rates (`{ score, comment? }`) or skips (`{ skip: true }`) one of their own resolved
 * conversations. Ownership is the only authorization: the id resolves only among the caller's
 * own tickets.
 */

const IdParams = z.object({ id: z.uuid() }).strict();

export const RatingBody = z.union([
  z.object({ score: z.int().min(1).max(5), comment: z.string().trim().max(1000).optional() }).strict(),
  z.object({ skip: z.literal(true) }).strict(),
]);

function customerIdOf(req: Request): string {
  if (req.actor?.kind !== 'customer') throw new Error('Route needs a customer session');
  return req.actor.userId;
}

@Controller('customer/ratings')
export class CustomerRatingsController {
  constructor(private readonly satisfaction: SatisfactionService) {}

  @Put(':id')
  @CustomerApi()
  @HttpCode(204)
  async rate(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(RatingBody)) body: z.infer<typeof RatingBody>,
  ): Promise<void> {
    const input = 'skip' in body ? body : { score: body.score, ...(body.comment === undefined || body.comment === '' ? {} : { comment: body.comment }) };
    await this.satisfaction.rate(tenantContextOf(req), customerIdOf(req), params.id, input);
  }
}
