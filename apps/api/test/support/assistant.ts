import { sql } from 'kysely';

import { AiTicketStatus } from '../../src/ai/assistant/ai-ticket-status.js';
import { AiTurnJob, type AiTurnJobData, type TurnJobOutcome } from '../../src/ai/assistant/ai-turn.job.js';
import { ConversationSummary } from '../../src/ai/assistant/conversation-summary.js';
import { DRAFT_WRITER, type DraftWriter } from '../../src/ai/assistant/draft-writer.js';
import { HandoffWriter } from '../../src/ai/assistant/handoff-writer.js';
import { ResponderService } from '../../src/ai/assistant/responder.js';
import { TURN_BRAIN, type TurnBrain } from '../../src/ai/assistant/turn-brain.js';
import { COMMERCE_CONNECTOR } from '../../src/ai/commerce/ports.js';
import { AiTriggerConsumer, StaffReplyConsumer } from '../../src/ai/consumers.js';
import { AiRouteConsumer, AiRouteJob, type AiRouteJobData, type RouteOutcome } from '../../src/ai/decisions/ai-route.job.js';
import { AI_PROVIDER, type AiProvider } from '../../src/ai/providers/ports.js';
import { AiRunsRecorder } from '../../src/ai/runs/ai-runs.recorder.js';
import { AiStatus } from '../../src/ai/settings/ai-status.js';
import { PolicyService } from '../../src/authorization/policy.service.js';
import { AssistantMessageWriter } from '../../src/messaging/assistant-message.writer.js';
import { NotificationsConsumer } from '../../src/notifications/notifications.consumer.js';
import { RecipientResolver } from '../../src/notifications/recipient-resolver.js';
import { Clock } from '../../src/platform-kernel/clock.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { QueueRegistry } from '../../src/platform-kernel/jobs/queues.js';
import { OutboxService } from '../../src/platform-kernel/outbox/outbox.service.js';
import { TicketHistoryService } from '../../src/tickets/ticket-history.service.js';
import { TicketsService } from '../../src/tickets/tickets.service.js';

import { getTestApp, service } from './app.js';
import { createUser, type TestTenant, type TestUser } from './factories.js';
import { asUser } from './http.js';

import type { FakeCommerceConnector } from '../../src/ai/commerce/fake/fake-commerce.connector.js';
import type { FakeAiProvider } from '../../src/ai/providers/fake/fake.provider.js';
import type { Job } from 'bullmq';

/**
 * Helpers for the assistant tests (specs/002-ai-assist T026). The trigger and staff-reply
 * consumers and the `ai-turn` job are worker-only, so they are built by hand over the api app's
 * services (as support/jobs.ts does) and run directly: no BullMQ worker, no 3 s debounce in real
 * time, and a test decides exactly when a turn reads, thinks and writes.
 */

export const contextOf = (tenant: { id: string }) => TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'assistant-test' });

export async function fakeProvider(): Promise<FakeAiProvider> {
  return (await getTestApp()).app.get<FakeAiProvider>(AI_PROVIDER);
}

export async function fakeStore(): Promise<FakeCommerceConnector> {
  return (await getTestApp()).app.get<FakeCommerceConnector>(COMMERCE_CONNECTOR);
}

export interface AiTenant {
  tenant: TestTenant;
  admin: TestUser;
  customer: TestUser;
}

/** A tenant with a provider key, the given reply mode and a store connection, plus a customer who owns order R100200. */
export async function setUpAiTenant(tenant: TestTenant, options: { mode?: 'off' | 'drafts' | 'auto'; apiKey?: string; store?: boolean } = {}): Promise<AiTenant> {
  const admin = await createUser(tenant, { roles: ['admin'] });
  const customer = await createUser(tenant, { roles: ['customer'] });
  const key = await asUser(admin).put('/ai/settings/provider-key', { apiKey: options.apiKey ?? 'sk-or-v1-assistant-test-KEY1' });
  if (key.status !== 200) throw new Error(`Saving the provider key failed: ${key.status} ${JSON.stringify(key.body)}`);
  const mode = await asUser(admin).patch('/ai/settings', { replyMode: options.mode ?? 'auto' });
  if (mode.status !== 200) throw new Error(`Setting the reply mode failed: ${mode.status} ${JSON.stringify(mode.body)}`);
  if (options.store !== false) {
    const store = await asUser(admin).put('/ai/store-connection', { kind: 'spree', baseUrl: 'https://shop.example.com', apiKey: 'spree-read-only-key' });
    if (store.status !== 200) throw new Error(`Saving the store connection failed: ${store.status} ${JSON.stringify(store.body)}`);
  }
  (await fakeStore()).useCustomerEmail(customer.email);
  return { tenant, admin, customer };
}

/** The customer sends a chat message; returns the ticket it joined. */
export async function customerSays(customer: TestUser, body: string): Promise<string> {
  const response = await asUser(customer).post('/customer/messages', { body, clientMessageId: uuidv7() });
  if (response.status !== 201) throw new Error(`Customer message failed: ${response.status} ${JSON.stringify(response.body)}`);
  return ticketOf(customer);
}

class AssistantTestRepository extends TenantRepository {
  ticketOf(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select('id').where('customer_id', '=', customerId).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  }

  messages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages')
      .select(['id', 'author_kind', 'visibility', 'body', 'metadata'])
      .where('ticket_id', '=', ticketId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  state(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ai_ticket_state').selectAll().where('ticket_id', '=', ticketId).executeTakeFirst();
  }

  drafts(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ai_drafts').select(['id', 'status', 'body', 'resolved_by']).where('ticket_id', '=', ticketId).orderBy('created_at').execute();
  }

  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['id', 'owner_id', 'waiting_on', 'first_agent_reply_at', 'last_agent_reply_at'])
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow();
  }

  ticketGroup(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select('group_id').where('id', '=', ticketId).executeTakeFirstOrThrow();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history').select(['field', 'actor_kind', 'new_value']).where('ticket_id', '=', ticketId).orderBy('created_at').orderBy('id').execute();
  }

  tagNames(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_tags').innerJoin('tags', 'tags.id', 'ticket_tags.tag_id').select('tags.name').where('ticket_tags.ticket_id', '=', ticketId).execute();
  }

  events(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events').select(['id', 'payload', 'customer_payload', 'streams']).where('type', '=', type).orderBy('id').execute();
  }

  latestMessageEvent(tx: TenantTransaction, messageId: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select('id')
      .where('type', '=', 'message.created')
      .where(sql<boolean>`payload ->> 'id' = ${messageId}`)
      .executeTakeFirstOrThrow();
  }

  notifications(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'notifications').select(['event_type']).where('recipient_id', '=', userId).execute();
  }
}

async function read<T>(tenant: { id: string }, fn: (tx: TenantTransaction, repo: AssistantTestRepository) => Promise<T>): Promise<T> {
  const ctx = contextOf(tenant);
  return (await service(UnitOfWork)).withTenantReadOnly(ctx, (tx) => fn(tx, new AssistantTestRepository(ctx)));
}

export const ticketOf = (customer: TestUser) => read(customer.tenant, async (tx, repo) => (await repo.ticketOf(tx, customer.id)).id);
export const messagesOf = (tenant: { id: string }, ticketId: string) => read(tenant, (tx, repo) => repo.messages(tx, ticketId));
export const assistantMessages = async (tenant: { id: string }, ticketId: string) => (await messagesOf(tenant, ticketId)).filter((m) => m.author_kind === 'assistant');
export const aiStateOf = (tenant: { id: string }, ticketId: string) => read(tenant, (tx, repo) => repo.state(tx, ticketId));
export const draftsOf = (tenant: { id: string }, ticketId: string) => read(tenant, (tx, repo) => repo.drafts(tx, ticketId));
export const ticketRow = (tenant: { id: string }, ticketId: string) => read(tenant, (tx, repo) => repo.ticket(tx, ticketId));
export const historyOf = (tenant: { id: string }, ticketId: string) => read(tenant, (tx, repo) => repo.history(tx, ticketId));
export const tagsOf = async (tenant: { id: string }, ticketId: string) => (await read(tenant, (tx, repo) => repo.tagNames(tx, ticketId))).map((row) => row.name);
export const eventsOf = (tenant: { id: string }, type: string) => read(tenant, (tx, repo) => repo.events(tx, type));
export const notificationTypes = async (user: TestUser) => (await read(user.tenant, (tx, repo) => repo.notifications(tx, user.id))).map((row) => row.event_type);

/** The `ai-turn` job over the app's services; `brain` replaces the real one (e.g. to act while the turn thinks). */
export async function turnJob(options: { brain?: (real: TurnBrain) => TurnBrain } = {}): Promise<AiTurnJob> {
  const { app } = await getTestApp();
  const real = app.get<TurnBrain>(TURN_BRAIN);
  const summary = new ConversationSummary(await service(UnitOfWork), await service(AiRunsRecorder), app.get(AI_PROVIDER));
  return new AiTurnJob(
    await service(UnitOfWork),
    await service(AiStatus),
    summary,
    await service(AssistantMessageWriter),
    await service(HandoffWriter),
    options.brain?.(real) ?? real,
    app.get<DraftWriter>(DRAFT_WRITER),
  );
}

/** Runs one `ai-turn` for the ticket, as the worker would; `attemptsMade` stages a retry. */
export async function runTurn(tenant: { id: string }, ticketId: string, options: { job?: AiTurnJob; attemptsMade?: number } = {}): Promise<TurnJobOutcome> {
  const job = options.job ?? (await turnJob());
  const data: AiTurnJobData = { tenantId: tenant.id, ticketId };
  const fake = { id: `turn.${ticketId}`, data, attemptsMade: options.attemptsMade ?? 0, opts: { attempts: 3 } } as unknown as Job<AiTurnJobData>;
  return job.process(data, fake);
}

async function messageEventId(tenant: { id: string }, messageId: string): Promise<string> {
  return (await read(tenant, (tx, repo) => repo.latestMessageEvent(tx, messageId))).id;
}

/** Delivers a message's `message.created` to the trigger consumer (enqueues the debounced turn). */
export async function deliverToTrigger(tenant: { id: string }, messageId: string): Promise<string> {
  const consumer = new AiTriggerConsumer(await service(UnitOfWork), await service(AiTicketStatus), await service(QueueRegistry));
  return consumer.process({ tenantId: tenant.id, eventId: await messageEventId(tenant, messageId) }, `trigger-test-${messageId}`);
}

/** Delivers a message's `message.created` to the staff-reply consumer. */
export async function deliverToStaffReply(tenant: { id: string }, messageId: string): Promise<string> {
  const consumer = new StaffReplyConsumer(await service(UnitOfWork), await service(ResponderService), await service(Clock));
  return consumer.process({ tenantId: tenant.id, eventId: await messageEventId(tenant, messageId) }, `staff-reply-test-${messageId}`);
}

/** Delivers a message's `message.created` to the notifications consumer. */
export async function deliverToNotifications(tenant: { id: string }, messageId: string): Promise<string> {
  const consumer = new NotificationsConsumer(
    await service(UnitOfWork),
    new RecipientResolver(await service(PolicyService)),
    await service(OutboxService),
    await service(Clock),
    await service(AiTicketStatus),
  );
  return consumer.process({ tenantId: tenant.id, eventId: await messageEventId(tenant, messageId) }, `notifications-test-${messageId}`);
}

/** The `ai-turn` jobs queued for one ticket (waiting or delayed). */
export async function queuedTurns(ticketId: string): Promise<Job[]> {
  const queue = (await service(QueueRegistry)).get('ai');
  return (await queue.getJobs(['waiting', 'delayed'])).filter((job) => job.name === 'ai-turn' && (job.data as AiTurnJobData).ticketId === ticketId);
}

/** Removes the ticket's queued turns, so a later file's worker never runs them. */
export async function clearQueuedTurns(ticketId: string): Promise<void> {
  for (const job of await queuedTurns(ticketId)) await job.remove();
}

// --- Routing (US4) -------------------------------------------------------------------------------

class RouteEvents extends TenantRepository {
  ticketCreated(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select('id')
      .where('type', '=', 'ticket.created')
      .where(sql<boolean>`payload -> 'ticket' ->> 'id' = ${ticketId}`)
      .executeTakeFirstOrThrow();
  }
}

/** Delivers the ticket's `ticket.created` to the routing trigger (enqueues `ai-route` when routing applies). */
export async function deliverToRouteTrigger(tenant: { id: string }, ticketId: string): Promise<string> {
  const ctx = contextOf(tenant);
  const { id: eventId } = await (await service(UnitOfWork)).withTenantReadOnly(ctx, (tx) => new RouteEvents(ctx).ticketCreated(tx, ticketId));
  const consumer = new AiRouteConsumer(await service(UnitOfWork), await service(AiStatus), await service(QueueRegistry));
  return consumer.process({ tenantId: tenant.id, eventId }, `route-trigger-test-${ticketId}`);
}

/** The `ai-route` job over the app's services; `provider` wraps the fake (e.g. to act while it decides). */
export async function routeJob(options: { provider?: (real: AiProvider) => AiProvider } = {}): Promise<AiRouteJob> {
  const real = (await getTestApp()).app.get<AiProvider>(AI_PROVIDER);
  return new AiRouteJob(
    await service(UnitOfWork),
    await service(AiStatus),
    await service(AiRunsRecorder),
    await service(TicketsService),
    await service(TicketHistoryService),
    options.provider?.(real) ?? real,
  );
}

export async function runRoute(tenant: { id: string }, ticketId: string, options: { job?: AiRouteJob; attemptsMade?: number } = {}): Promise<RouteOutcome> {
  const job = options.job ?? (await routeJob());
  const data: AiRouteJobData = { tenantId: tenant.id, ticketId };
  const fake = { id: `route.${ticketId}`, data, attemptsMade: options.attemptsMade ?? 0, opts: { attempts: 5 } } as unknown as Job<AiRouteJobData>;
  return job.process(data, fake);
}

/** The `ai-route` jobs queued for one ticket. */
export async function queuedRoutes(ticketId: string): Promise<Job[]> {
  const queue = (await service(QueueRegistry)).get('ai');
  return (await queue.getJobs(['waiting', 'delayed'])).filter((job) => job.name === 'ai-route' && (job.data as AiRouteJobData).ticketId === ticketId);
}

export async function clearQueuedRoutes(ticketId: string): Promise<void> {
  for (const job of await queuedRoutes(ticketId)) await job.remove();
}

export const groupOf = async (tenant: { id: string }, ticketId: string) =>
  (await read(tenant, (tx, repo) => repo.ticketGroup(tx, ticketId))).group_id;
