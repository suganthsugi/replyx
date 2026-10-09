import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL_MODELS } from '../../../src/ai/providers/catalog.js';
import { getTestApp } from '../../support/app.js';
import {
  clearQueuedRoutes,
  customerSays,
  deliverToRouteTrigger,
  fakeProvider,
  groupOf,
  historyOf,
  queuedRoutes,
  routeJob,
  runRoute,
  runTurn,
  setUpAiTenant,
  type AiTenant,
} from '../../support/assistant.js';
import { createGroup, createRole, createTenant, createUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { AiProvider } from '../../../src/ai/providers/ports.js';

/**
 * AI routing and complexity levels (specs/002-ai-assist US4, T030/T031) with the fake provider. Its
 * `choice` answers pick the option whose description shares the most words with the ticket's
 * title and first message (probability 0.9), or `none`; `[fake:cx_<key>]` in the customer's text
 * makes the complexity factor `<key>` (a yes/no) answer 0.95.
 */

beforeAll(async () => {
  await getTestApp();
});

afterEach(async () => {
  (await fakeProvider()).reset();
});

const codeOf = (response: { body: unknown }) => (response.body as { error?: { code?: string } }).error?.code;
const detailsOf = (response: { body: unknown }) => (response.body as { error?: { details?: { path: string; issue: string }[] } }).error?.details;

/** A tenant with AI routing on (reply mode Off) and two described groups. */
async function routingTenant(options: { threshold?: number } = {}) {
  const ai = await setUpAiTenant(await createTenant(), { mode: 'off', store: false });
  const settings = await asUser(ai.admin).patch('/ai/settings', { routingEnabled: true, ...(options.threshold === undefined ? {} : { routingThreshold: options.threshold }) });
  expect(settings.status).toBe(200);
  const billing = await describedGroup(ai, 'Billing', 'Invoices, charges, payments and refunds on a customer account');
  const shipping = await describedGroup(ai, 'Shipping', 'Parcels, delivery dates, couriers and tracking numbers');
  return { ...ai, billing, shipping };
}

async function describedGroup(ai: AiTenant, name: string, aiDescription: string | null, status: 'active' | 'inactive' = 'active') {
  const group = await createGroup(ai.tenant, { name: `${name} ${Math.random().toString(36).slice(2, 6)}`, status });
  const updated = await asUser(ai.admin).patch(`/groups/${group.id}`, { aiDescription });
  expect(updated.status).toBe(200);
  return group;
}

const decideCalls = async () => (await fakeProvider()).calls.filter((call) => call.kind === 'decide');

describe('AI routing', () => {
  it('moves an ungrouped customer ticket to the best described group and records why', async () => {
    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'My parcel tracking number shows no delivery date');
    expect(await runRoute(ai.tenant, ticketId)).toBe('routed');
    expect(await groupOf(ai.tenant, ticketId)).toBe(ai.shipping.id);
    const history = await historyOf(ai.tenant, ticketId);
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'ai_routing', actor_kind: 'ai', new_value: { groupId: ai.shipping.id, confidence: 0.9 } })]));
    expect(history.filter((entry) => entry.field === 'group_id')).toEqual([expect.objectContaining({ actor_kind: 'ai' })]);

    const runs = (await asUser(ai.admin).get('/ai/runs?purpose=routing')).body as { items: { purpose: string; ticket?: { id?: string } }[] };
    expect(runs.items).toHaveLength(1);
    expect(runs.items).toMatchObject([{ purpose: 'routing', ticket: { id: ticketId } }]);
  });

  it('queues one route job per new ungrouped ticket, and none when routing is off', async () => {
    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'Where is my parcel?');
    try {
      expect(await deliver(ai, ticketId)).toBe('handled');
      expect(await queuedRoutes(ticketId)).toHaveLength(1);
    } finally {
      await clearQueuedRoutes(ticketId);
    }

    await asUser(ai.admin).patch('/ai/settings', { routingEnabled: false });
    const other = await customerSays(await createUser(ai.tenant, { roles: ['customer'] }), 'Where is my parcel?');
    expect(await deliver(ai, other)).toBe('handled');
    expect(await queuedRoutes(other)).toEqual([]);
    expect(await runRoute(ai.tenant, other)).toBe('skipped');
  });

  it('lets a matching routing rule win: no route job, no decision call', async () => {
    const ai = await routingTenant();
    const rule = await asUser(ai.admin).post('/routing-rules', { name: 'Refunds', enabled: true, conditions: { messageContainsAny: ['refund'] }, actions: { groupId: ai.billing.id } });
    expect(rule.status).toBe(201);
    const ticketId = await customerSays(ai.customer, 'I want a refund for my parcel delivery');
    expect(await groupOf(ai.tenant, ticketId)).toBe(ai.billing.id);
    expect(await deliver(ai, ticketId)).toBe('handled');
    expect(await queuedRoutes(ticketId)).toEqual([]);
    expect(await runRoute(ai.tenant, ticketId)).toBe('skipped');
    expect(await decideCalls()).toEqual([]);
  });

  it('leaves the ticket in Needs Triage below the threshold or when no group fits', async () => {
    const strict = await routingTenant({ threshold: 0.95 });
    const strictTicket = await customerSays(strict.customer, 'My parcel tracking number is wrong');
    expect(await runRoute(strict.tenant, strictTicket)).toBe('below_threshold');
    expect(await groupOf(strict.tenant, strictTicket)).toBeNull();

    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'Hello there');
    expect(await runRoute(ai.tenant, ticketId)).toBe('none');
    expect(await groupOf(ai.tenant, ticketId)).toBeNull();
    expect((await historyOf(ai.tenant, ticketId)).some((entry) => entry.field === 'ai_routing')).toBe(false);
  });

  it('never offers an inactive group or one without a description', async () => {
    const ai = await routingTenant();
    const inactive = await describedGroup(ai, 'Warranty', 'Warranty claims for broken blenders and kettles', 'inactive');
    const undescribed = await describedGroup(ai, 'Kettles', null);
    const ticketId = await customerSays(ai.customer, 'My blender kettle is broken, warranty claim please');
    expect(await runRoute(ai.tenant, ticketId)).toBe('none');
    expect(await groupOf(ai.tenant, ticketId)).toBeNull();
    const [call] = await decideCalls();
    const criteria = Object.keys((call?.request as { questions: { route: { criteria: Record<string, string> } } }).questions.route.criteria);
    expect(criteria).toEqual(expect.arrayContaining([ai.billing.id, ai.shipping.id, 'none']));
    expect(criteria).not.toContain(inactive.id);
    expect(criteria).not.toContain(undescribed.id);
  });

  it('lets manual triage during the decision win', async () => {
    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'My parcel tracking number shows nothing');
    const job = await routeJob({
      provider: (real): AiProvider =>
        Object.assign(Object.create(real) as AiProvider, {
          decide: async (...args: Parameters<AiProvider['decide']>) => {
            expect((await asUser(ai.admin).patch(`/tickets/${ticketId}`, { groupId: ai.billing.id })).status).toBe(200);
            return real.decide(...args);
          },
        }),
    });
    expect(await runRoute(ai.tenant, ticketId, { job })).toBe('dropped');
    expect(await groupOf(ai.tenant, ticketId)).toBe(ai.billing.id);
  });

  it('pauses the tenant on a rejected key and leaves the ticket ungrouped', async () => {
    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'My parcel tracking number shows nothing');
    await asUser(ai.admin).put('/ai/settings/provider-key', { apiKey: 'fake-invalid' });
    expect(await runRoute(ai.tenant, ticketId)).toBe('paused');
    expect(await groupOf(ai.tenant, ticketId)).toBeNull();
    expect((await asUser(ai.admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'invalid_key' } });
  });

  it('gives up quietly on the last attempt when the provider is down', async () => {
    const ai = await routingTenant();
    const ticketId = await customerSays(ai.customer, 'My parcel tracking number shows nothing');
    await asUser(ai.admin).put('/ai/settings/provider-key', { apiKey: 'fake-down' });
    await expect(runRoute(ai.tenant, ticketId)).rejects.toThrow();
    expect(await runRoute(ai.tenant, ticketId, { attemptsMade: 4 })).toBe('failed');
    expect(await groupOf(ai.tenant, ticketId)).toBeNull();
  });
});

async function deliver(ai: AiTenant, ticketId: string): Promise<string> {
  return deliverToRouteTrigger(ai.tenant, ticketId);
}

describe('group AI descriptions', () => {
  it('need ai_settings.manage on top of group.edit, and are returned on the group', async () => {
    const ai = await setUpAiTenant(await createTenant(), { mode: 'off', store: false });
    const group = await createGroup(ai.tenant);
    const updated = await asUser(ai.admin).patch(`/groups/${group.id}`, { aiDescription: '  Refunds and invoices  ' });
    expect(updated.body).toMatchObject({ id: group.id, aiDescription: 'Refunds and invoices' });

    const role = await createRole(ai.tenant, { permissions: ['group.view', 'group.edit'] });
    const editor = await createUser(ai.tenant, { roles: [{ id: role.id }] });
    const denied = await asUser(editor).patch(`/groups/${group.id}`, { aiDescription: 'Something else' });
    expect([denied.status, codeOf(denied)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await asUser(editor).patch(`/groups/${group.id}`, { name: 'Renamed by editor' })).status).toBe(200);
    expect((await asUser(ai.admin).get(`/groups/${group.id}`)).body).toMatchObject({ name: 'Renamed by editor', aiDescription: 'Refunds and invoices' });

    const tooLong = await asUser(ai.admin).patch(`/groups/${group.id}`, { aiDescription: 'x'.repeat(501) });
    expect(detailsOf(tooLong)).toEqual([{ path: 'aiDescription', issue: 'too_long' }]);
    const cleared = await asUser(ai.admin).patch(`/groups/${group.id}`, { aiDescription: null });
    expect(cleared.body).toMatchObject({ aiDescription: null });
  });
});

const URGENT = {
  key: 'urgent',
  label: 'Urgent',
  kind: 'noul',
  weight: 1,
  instructions: 'Decide whether the request is urgent.',
  criteria: { true: 'It is urgent.', false: 'It is not urgent.' },
} as const;

describe('complexity configuration', () => {
  it('seeds the default factors when AI is first switched on', async () => {
    const ai = await setUpAiTenant(await createTenant(), { mode: 'auto', store: false });
    const config = (await asUser(ai.admin).get('/ai/complexity')).body as { thresholds: object; factors: { key: string; kind: string; weight: number }[] };
    expect(config.thresholds).toEqual({ standard: 0.45, advanced: 0.8 });
    expect(config.factors.map((factor) => [factor.key, factor.kind, factor.weight])).toEqual([
      ['frustration', 'score', 2],
      ['several_issues', 'noul', 1],
      ['technical_problem', 'noul', 1],
    ]);
  });

  it('replaces the whole set and returns it in order', async () => {
    const ai = await setUpAiTenant(await createTenant(), { mode: 'auto', store: false });
    const tag = (await asUser(ai.admin).post('/tags', { name: `VIP ${Math.random().toString(36).slice(2, 6)}` })).body as { id: string };
    const body = {
      thresholds: { standard: 0.3, advanced: 0.6 },
      factors: [
        URGENT,
        { key: 'topic', label: 'Topic', kind: 'choice', weight: 2, instructions: 'What is it about?', options: [{ key: 'billing', description: 'Billing', value: 1 }, { key: 'other', description: 'Anything else', value: 0 }] },
        { key: 'vip', label: 'VIP', kind: 'customer_tag', weight: 1, tagId: tag.id },
        { key: 'reopens', label: 'Reopens', kind: 'reopen_count', weight: 0.5 },
        { key: 'late', label: 'SLA breached', kind: 'sla_breached', weight: 0 },
      ],
    };
    const saved = await asUser(ai.admin).put('/ai/complexity', body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual(body);
    expect((await asUser(ai.admin).get('/ai/complexity')).body).toEqual(body);
  });

  it.each<[string, object, { path: string; issue: string }[]]>([
    ['thresholds out of order', { thresholds: { standard: 0.8, advanced: 0.5 }, factors: [URGENT] }, [{ path: 'thresholds.advanced', issue: 'not_above_standard' }]],
    ['no positive weight', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ ...URGENT, weight: 0 }] }, [{ path: 'factors', issue: 'no_positive_weight' }]],
    ['duplicate keys', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [URGENT, { ...URGENT, label: 'Again' }] }, [{ path: 'factors.1.key', issue: 'duplicate' }]],
    ['a bad key', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ ...URGENT, key: 'Urgent!' }] }, [{ path: 'factors.0.key', issue: 'invalid_format' }]],
    ['a weight above 10', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ ...URGENT, weight: 11 }] }, [{ path: 'factors.0.weight', issue: 'too_large' }]],
    [
      'one choice option',
      { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ key: 'topic', label: 'Topic', kind: 'choice', weight: 1, instructions: 'What?', options: [{ key: 'a', description: 'A', value: 1 }] }] },
      [{ path: 'factors.0.options', issue: 'too_few' }],
    ],
    ['one score level', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ key: 'mood', label: 'Mood', kind: 'score', weight: 1, instructions: 'Mood?', levels: ['calm'] }] }, [{ path: 'factors.0.levels', issue: 'too_few' }]],
    ['options on a yes/no factor', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ ...URGENT, options: [] }] }, [{ path: 'factors.0.options', issue: 'unrecognized_key' }]],
    ['an unknown tag', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: [{ key: 'vip', label: 'VIP', kind: 'customer_tag', weight: 1, tagId: '0192f3c4-0000-7000-8000-000000000999' }] }, [{ path: 'factors.0.tagId', issue: 'not_found' }]],
    ['13 factors', { thresholds: { standard: 0.4, advanced: 0.8 }, factors: Array.from({ length: 13 }, (_, i) => ({ ...URGENT, key: `f${i}` })) }, [{ path: 'factors', issue: 'too_many' }]],
  ])('rejects %s with a field-level 400', async (_name, body, details) => {
    const ai = await setUpAiTenant(await createTenant(), { mode: 'off', store: false });
    const response = await asUser(ai.admin).put('/ai/complexity', body);
    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(detailsOf(response)).toEqual(details);
  });
});

describe('complexity levels in a turn', () => {
  async function turnWithUrgent(text: string) {
    const ai = await setUpAiTenant(await createTenant(), { mode: 'auto', store: false });
    expect((await asUser(ai.admin).put('/ai/complexity', { thresholds: { standard: 0.45, advanced: 0.8 }, factors: [URGENT] })).status).toBe(200);
    const ticketId = await customerSays(ai.customer, text);
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    const runs = (await asUser(ai.admin).get('/ai/runs?purpose=reply')).body as { items: { model: string; level: string | null; complexityScore: number | null }[] };
    return runs.items;
  }

  it('uses the Advanced model for a high score, in the same single decision call', async () => {
    const runs = await turnWithUrgent('Hello [fake:cx_urgent] I need this today');
    expect(runs).toEqual([expect.objectContaining({ model: DEFAULT_LEVEL_MODELS.advanced, level: 'advanced', complexityScore: 0.95 })]);
    const decisions = (await fakeProvider()).calls.filter((call) => call.kind === 'decide');
    expect(decisions).toHaveLength(1);
    expect(Object.keys((decisions[0]?.request as { questions: object }).questions)).toEqual(['wants_human', 'refund_or_exception', 'frustration', 'cx_urgent']);
  });

  it('uses the Fast model for a low score', async () => {
    const runs = await turnWithUrgent('Hello, a quick question');
    expect(runs).toEqual([expect.objectContaining({ model: DEFAULT_LEVEL_MODELS.fast, level: 'fast', complexityScore: 0.05 })]);
  });
});
