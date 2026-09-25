import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { CustomerApi } from '../authorization/registry/module-permissions.js';
import { MAX_LIMIT } from '../platform-kernel/http/pagination.js';
import { RateLimit } from '../platform-kernel/http/rate-limit.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { CustomerConversationService, type ConversationPage } from './customer-conversation.service.js';
import { CustomerMessageRouter } from './customer-message-router.js';

import type { ConversationMessage } from './customer-projection.js';
import type { Request } from 'express';

/**
 * The customer's conversation (contracts/customer.yaml `/customer/conversation`,
 * `/customer/messages*`). Authorization is by ownership: every call works on the signed-in
 * customer's own thread, and nothing here takes a ticket, customer or tenant id as input.
 */

export const MESSAGE_BODY_MAX = 10_000;
export const MAX_ATTACHMENTS = 10;

const ConversationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(30),
    before: z.string().min(1).max(1024).optional(),
  })
  .strict();

/** Leading and trailing whitespace is dropped; a blank message is `too_short`. */
export const MessageBody = z.string().trim().min(1).max(MESSAGE_BODY_MAX);

const SendBody = z
  .object({
    body: MessageBody,
    clientMessageId: z.uuid(),
    attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
  })
  .strict();

const ReadBody = z.object({ upToMessageId: z.uuid() }).strict();

function customerIdOf(req: Request): string {
  if (req.actor?.kind !== 'customer') throw new Error('Route needs a customer session');
  return req.actor.userId;
}

@Controller('customer')
export class CustomerController {
  constructor(
    private readonly conversations: CustomerConversationService,
    private readonly router: CustomerMessageRouter,
  ) {}

  @Get('conversation')
  @CustomerApi()
  conversation(@Req() req: Request, @Query(new ZodValidationPipe(ConversationQuery)) query: z.infer<typeof ConversationQuery>): Promise<ConversationPage> {
    return this.conversations.conversation(tenantContextOf(req), customerIdOf(req), query);
  }

  /** 201 with the stored message; a repeated `clientMessageId` returns the original. */
  @Post('messages')
  @CustomerApi()
  @RateLimit('customer-message')
  async send(@Req() req: Request, @Body(new ZodValidationPipe(SendBody)) body: z.infer<typeof SendBody>): Promise<ConversationMessage> {
    const { message } = await this.router.accept(tenantContextOf(req), customerIdOf(req), body);
    return message;
  }

  @Post('messages/read')
  @CustomerApi()
  @HttpCode(204)
  async read(@Req() req: Request, @Body(new ZodValidationPipe(ReadBody)) body: z.infer<typeof ReadBody>): Promise<void> {
    await this.conversations.markRead(tenantContextOf(req), customerIdOf(req), body.upToMessageId);
  }
}
