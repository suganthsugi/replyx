import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HANDOFF_MESSAGE, HANDOFF_TAG } from '../../../src/ai/assistant/handoff-writer.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp } from '../../support/app.js';
import {
  aiStateOf,
  assistantMessages,
  clearQueuedTurns,
  customerSays,
  deliverToNotifications,
  deliverToStaffReply,
  deliverToTrigger,
  draftsOf,
  eventsOf,
  fakeProvider,
  fakeStore,
  historyOf,
  messagesOf,
  notificationTypes,
  queuedTurns,
  runTurn,
  setUpAiTenant,
  tagsOf,
  ticketRow,
  turnJob,
  type AiTenant,
} from '../../support/assistant.js';
import { createGroup, createTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { createPolicy, newestVersionId, runIndex } from '../../support/policies.js';
import { createBusinessHours, createSlaPolicy, recomputeSla, slaRow } from '../../support/sla.js';

/**
 * The assistant in the ticket conversation (specs/002-ai-assist US3, T026), with the fake provider
 * and the fake store. Turns run directly (support/assistant.ts), so a test controls when a turn
 * reads, thinks and writes. The fake chat looks up an order when the customer's text has an order
 * number, searches policies on return/refund/shipping words and asks for the number on "order";
 * `[fake:handoff]` makes the hand-off check say the customer wants a person.
 */

beforeAll(async () => {
  await getTestApp();
});

afterEach(async () => {
  (await fakeProvider()).reset();
  (await fakeStore()).reset();
});

async function aiTenant(options: Parameters<typeof setUpAiTenant>[1] = {}): Promise<AiTenant> {
  return setUpAiTenant(await createTenant(), options);
}

/** Moves the ticket into a group, so staff can own it and the take-over has an eligible owner. */
async function groupTicket(ai: AiTenant, ticketId: string): Promise<{ id: string }> {
  const group = await createGroup(ai.tenant);
  const moved = await asUser(ai.admin).patch(`/tickets/${ticketId}`, { groupId: group.id });
  if (moved.status !== 200) throw new Error(`Grouping the ticket failed: ${moved.status} ${JSON.stringify(moved.body)}`);
  return group;
}

const codeOf = (response: { body: unknown }) => (response.body as { error?: { code?: string } }).error?.code;

async function staffReply(user: TestUser, ticketId: string, body: string, extra: object = {}) {
  return asUser(user).post(`/tickets/${ticketId}/messages`, { visibility: 'public', body, clientMessageId: uuidv7(), ...extra });
}

async function customerConversation(customer: TestUser) {
  return (await asUser(customer).get('/customer/conversation')).body as {
    items: { type: string; message?: { body: string; from: { kind: string; name?: string }; isAi?: boolean } }[];
    responder?: { kind: string; name?: string };
  };
}

describe('answers about orders and policies', () => {
  it('asks for the order number, then gives the status of the customer’s own order', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Where is my order?');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    expect((await assistantMessages(ai.tenant, ticketId)).map((m) => m.body)).toEqual(['I can check that for you. Could you share your order number?']);
    expect(await aiStateOf(ai.tenant, ticketId)).toMatchObject({ awaiting: 'order_number', stopped_reason: null });

    await customerSays(ai.customer, 'It is R100200');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    const replies = await assistantMessages(ai.tenant, ticketId);
    expect(replies).toHaveLength(2);
    expect(replies[1]?.body).toContain('R100200');
    expect(replies[1]?.body).toContain('TRK100200');
    expect((await fakeStore()).calls).toEqual([expect.objectContaining({ method: 'getOrder', number: 'R100200', baseUrl: 'https://shop.example.com' })]);
  });

  it("answers another customer's order number exactly like an unknown one", async () => {
    const ai = await aiTenant();
    const otherTicket = await customerSays(ai.customer, 'Status of R999999 please');
    await runTurn(ai.tenant, otherTicket);
    const [someoneElses] = (await assistantMessages(ai.tenant, otherTicket)).map((m) => m.body);

    const second = await setUpAiTenant(ai.tenant, {});
    const unknownTicket = await customerSays(second.customer, 'Status of R123456 please');
    await runTurn(ai.tenant, unknownTicket);
    const [unknown] = (await assistantMessages(ai.tenant, unknownTicket)).map((m) => m.body);

    expect(someoneElses).toBeDefined();
    expect(someoneElses).toBe(unknown);
    expect(someoneElses).not.toContain('Leather Wallet');
  });

  it('answers a policy question from the active policy', async () => {
    const ai = await aiTenant();
    const policy = await createPolicy(ai.admin, { title: 'Returns', text: '# Returns\n\nYou can return unworn items within 30 days of delivery for a full refund.' });
    expect(policy.status).toBe(201);
    expect((await runIndex(ai.tenant, policy.id, await newestVersionId(ai.admin, policy.id))).outcome).toBe('active');

    const ticketId = await customerSays(ai.customer, 'What is your return policy?');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    const [answer] = await assistantMessages(ai.tenant, ticketId);
    expect(answer?.body).toContain('within 30 days');
  });

  it('shows the answer to the customer as an AI support message and to staff as the assistant', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello there');
    await runTurn(ai.tenant, ticketId);

    const conversation = await customerConversation(ai.customer);
    const support = conversation.items.filter((item) => item.message?.from.kind === 'support');
    expect(support).toHaveLength(1);
    expect(support).toMatchObject([{ message: { isAi: true } }]);
    expect(conversation.responder).toEqual({ kind: 'assistant' });

    const staff = (await asUser(ai.admin).get(`/tickets/${ticketId}/messages`)).body as { items: { authorKind: string; author: { name: string } | null }[] };
    const fromAssistant = staff.items.filter((m) => m.authorKind === 'assistant');
    expect(fromAssistant).toHaveLength(1);
    expect(fromAssistant).toMatchObject([{ author: { name: 'Assistant' } }]);
  });
});

describe('idempotency and debounce', () => {
  it('posts one reply when the same turn runs twice', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    expect(await runTurn(ai.tenant, ticketId)).toBe('duplicate');
    expect(await assistantMessages(ai.tenant, ticketId)).toHaveLength(1);
  });

  it('turns three quick messages into one pending turn and one reply', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hi');
    await customerSays(ai.customer, 'I have a question');
    await customerSays(ai.customer, 'about my order');
    const customerMessages = (await messagesOf(ai.tenant, ticketId)).filter((m) => m.author_kind === 'customer');
    expect(customerMessages).toHaveLength(3);
    try {
      for (const message of customerMessages) expect(await deliverToTrigger(ai.tenant, message.id)).toBe('handled');
      expect(await queuedTurns(ticketId)).toHaveLength(1);
    } finally {
      await clearQueuedTurns(ticketId);
    }

    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    expect(await runTurn(ai.tenant, ticketId)).toBe('duplicate');
    expect(await assistantMessages(ai.tenant, ticketId)).toHaveLength(1);
  });

  it('queues no turn while AI is paused, and none in Off mode', async () => {
    const paused = await aiTenant({ apiKey: 'fake-invalid' });
    await asUser(paused.admin).post('/ai/settings/provider-key/test');
    expect((await asUser(paused.admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'invalid_key' } });
    const pausedTicket = await customerSays(paused.customer, 'Hello?');
    const [pausedMessage] = await messagesOf(paused.tenant, pausedTicket);
    expect(await deliverToTrigger(paused.tenant, pausedMessage!.id)).toBe('handled');
    expect(await queuedTurns(pausedTicket)).toEqual([]);
    // A turn that was already queued does nothing either.
    expect(await runTurn(paused.tenant, pausedTicket)).toBe('skipped');
    expect(await assistantMessages(paused.tenant, pausedTicket)).toEqual([]);

    const off = await aiTenant({ mode: 'off' });
    const offTicket = await customerSays(off.customer, 'Hello?');
    const [offMessage] = await messagesOf(off.tenant, offTicket);
    expect(await deliverToTrigger(off.tenant, offMessage!.id)).toBe('handled');
    expect(await queuedTurns(offTicket)).toEqual([]);
    expect(await runTurn(off.tenant, offTicket)).toBe('skipped');
  });

  it('pauses the tenant when the provider rejects the key during a turn', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await asUser(ai.admin).put('/ai/settings/provider-key', { apiKey: 'fake-no-credit' });
    expect(await runTurn(ai.tenant, ticketId)).toBe('paused');
    expect((await asUser(ai.admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'no_credit' } });
    expect(await assistantMessages(ai.tenant, ticketId)).toEqual([]);
  });
});

describe('stop rules', () => {
  it('hands off once: one notice, the tag, history, waiting on support and the stop', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'I want to talk to a person [fake:handoff]');
    expect(await runTurn(ai.tenant, ticketId)).toBe('handoff');

    const notices = await assistantMessages(ai.tenant, ticketId);
    expect(notices).toHaveLength(1);
    expect(notices).toMatchObject([{ body: HANDOFF_MESSAGE, metadata: { handoff: true } }]);
    expect(await tagsOf(ai.tenant, ticketId)).toContain(HANDOFF_TAG);
    expect((await historyOf(ai.tenant, ticketId)).filter((entry) => entry.field === 'ai_handoff')).toEqual([expect.objectContaining({ actor_kind: 'ai' })]);
    expect(await ticketRow(ai.tenant, ticketId)).toMatchObject({ waiting_on: 'support' });
    expect((await aiStateOf(ai.tenant, ticketId))?.stopped_reason).toMatch(/^handoff:/);
    expect((await customerConversation(ai.customer)).responder).toEqual({ kind: 'team' });

    // Stopped: the next customer message gets no answer.
    await customerSays(ai.customer, 'Hello?');
    expect(await runTurn(ai.tenant, ticketId)).toBe('skipped');
    expect(await assistantMessages(ai.tenant, ticketId)).toHaveLength(1);
  });

  it('hands off without a notice in Drafts mode', async () => {
    const ai = await aiTenant({ mode: 'drafts' });
    const ticketId = await customerSays(ai.customer, 'Get me a human [fake:handoff]');
    expect(await runTurn(ai.tenant, ticketId)).toBe('handoff');
    expect(await assistantMessages(ai.tenant, ticketId)).toEqual([]);
    expect(await tagsOf(ai.tenant, ticketId)).toContain(HANDOFF_TAG);
  });

  it('hands off on low confidence and after two unresolved turns in a row', async () => {
    const lowConfidence = await aiTenant();
    const lowTicket = await customerSays(lowConfidence.customer, 'Something odd [fake:lowconf]');
    expect(await runTurn(lowConfidence.tenant, lowTicket)).toBe('handoff');

    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hmm [fake:unresolved]');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
    expect(await aiStateOf(ai.tenant, ticketId)).toMatchObject({ unresolved_turns: 1 });
    // The second unresolved turn in a row hands off instead of answering.
    await customerSays(ai.customer, 'Still not it [fake:unresolved]');
    expect(await runTurn(ai.tenant, ticketId)).toBe('handoff');
    expect((await aiStateOf(ai.tenant, ticketId))?.stopped_reason).toBe('handoff:unresolved');
  });

  it('stops answering after a staff reply and closes the open draft as superseded', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await runTurn(ai.tenant, ticketId);
    await groupTicket(ai, ticketId);

    const reply = await staffReply(ai.admin, ticketId, 'Hi, this is Sam from support.');
    expect(reply.status).toBe(201);
    expect(await deliverToStaffReply(ai.tenant, (reply.body as { id: string }).id)).toBe('handled');
    expect((await aiStateOf(ai.tenant, ticketId))?.agent_replied_at).not.toBeNull();

    await customerSays(ai.customer, 'Thanks Sam, one more thing');
    expect(await runTurn(ai.tenant, ticketId)).toBe('skipped');
    expect(await assistantMessages(ai.tenant, ticketId)).toHaveLength(1);
    expect((await customerConversation(ai.customer)).responder).toEqual({ kind: 'team' });
  });

  it('discards a turn whose customer got a newer message or a staff reply while it was thinking', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'First question');
    const job = await turnJob({
      brain: (real) => ({
        think: async (input) => {
          await customerSays(ai.customer, 'Actually, a second question');
          return real.think(input);
        },
      }),
    });
    expect(await runTurn(ai.tenant, ticketId, { job })).toBe('dropped');
    expect(await assistantMessages(ai.tenant, ticketId)).toEqual([]);
    // The newer message gets its own turn.
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
  });
});

describe('take over and hand back', () => {
  it('take over makes the caller the owner and stops the assistant; hand back resumes it', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await runTurn(ai.tenant, ticketId);
    await groupTicket(ai, ticketId);

    const before = (await asUser(ai.admin).get(`/tickets/${ticketId}`)).body as { responder: object; ai: object };
    expect(before.responder).toEqual({ kind: 'assistant' });
    expect(before.ai).toMatchObject({ stopped: false, canTakeOver: true, canHandBack: false });

    const taken = await asUser(ai.admin).post(`/tickets/${ticketId}/ai/takeover`);
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ kind: 'agent', name: ai.admin.name });
    expect(await ticketRow(ai.tenant, ticketId)).toMatchObject({ owner_id: ai.admin.id });
    expect(await aiStateOf(ai.tenant, ticketId)).toMatchObject({ stopped_reason: 'taken_over', taken_over_by: ai.admin.id });
    expect((await historyOf(ai.tenant, ticketId)).map((entry) => entry.field)).toContain('ai_takeover');
    expect((await customerConversation(ai.customer)).responder).toMatchObject({ kind: 'agent', name: ai.admin.name });
    const after = (await asUser(ai.admin).get(`/tickets/${ticketId}`)).body as { ai: object };
    expect(after.ai).toMatchObject({ stopped: true, stoppedReason: 'takeover', canTakeOver: false, canHandBack: true });

    // Again as the same user: 200, nothing new.
    const changes = (await eventsOf(ai.tenant, 'conversation.responder_changed')).length;
    expect((await asUser(ai.admin).post(`/tickets/${ticketId}/ai/takeover`)).status).toBe(200);
    expect(await eventsOf(ai.tenant, 'conversation.responder_changed')).toHaveLength(changes);

    await customerSays(ai.customer, 'Are you there?');
    expect(await runTurn(ai.tenant, ticketId)).toBe('skipped');

    const back = await asUser(ai.admin).post(`/tickets/${ticketId}/ai/handback`);
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ kind: 'assistant' });
    expect(await ticketRow(ai.tenant, ticketId)).toMatchObject({ owner_id: null });
    expect(await aiStateOf(ai.tenant, ticketId)).toMatchObject({ stopped_reason: null, taken_over_by: null, unresolved_turns: 0 });
    expect((await historyOf(ai.tenant, ticketId)).map((entry) => entry.field)).toContain('ai_handback');

    // The assistant answers from the next customer message on.
    await customerSays(ai.customer, 'One more question');
    expect(await runTurn(ai.tenant, ticketId)).toBe('replied');
  });

  it('emits responder changes with no ticket fields for the customer', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await groupTicket(ai, ticketId);
    await asUser(ai.admin).post(`/tickets/${ticketId}/ai/takeover`);
    const [event] = await eventsOf(ai.tenant, 'conversation.responder_changed');
    expect(event?.payload).toMatchObject({ ticketId, responder: { kind: 'agent' } });
    expect(event?.customer_payload).toMatchObject({ type: 'conversation.responder_changed', data: { responder: { kind: 'agent', name: ai.admin.name } } });
    expect(Object.keys((event?.customer_payload as { data: object }).data)).toEqual(['responder']);
  });

  it('discards an in-flight turn after a take over', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await groupTicket(ai, ticketId);
    const job = await turnJob({
      brain: (real) => ({
        think: async (input) => {
          expect((await asUser(ai.admin).post(`/tickets/${ticketId}/ai/takeover`)).status).toBe(200);
          return real.think(input);
        },
      }),
    });
    expect(await runTurn(ai.tenant, ticketId, { job })).toBe('dropped');
    expect(await assistantMessages(ai.tenant, ticketId)).toEqual([]);
  });

  it('refuses hand back outside Auto-reply and while paused', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await groupTicket(ai, ticketId);
    await asUser(ai.admin).post(`/tickets/${ticketId}/ai/takeover`);

    await asUser(ai.admin).patch('/ai/settings', { replyMode: 'drafts' });
    const notAuto = await asUser(ai.admin).post(`/tickets/${ticketId}/ai/handback`);
    expect([notAuto.status, codeOf(notAuto)]).toEqual([409, 'AI_NOT_IN_AUTO_MODE']);

    await asUser(ai.admin).patch('/ai/settings', { replyMode: 'auto' });
    await asUser(ai.admin).put('/ai/settings/provider-key', { apiKey: 'fake-invalid' });
    await asUser(ai.admin).post('/ai/settings/provider-key/test');
    const paused = await asUser(ai.admin).post(`/tickets/${ticketId}/ai/handback`);
    expect([paused.status, codeOf(paused)]).toEqual([409, 'AI_PAUSED']);
  });
});

describe('drafts mode', () => {
  it('stores a draft the customer never sees; sending with aiDraftId marks it sent', async () => {
    const ai = await aiTenant({ mode: 'drafts' });
    const ticketId = await customerSays(ai.customer, 'Hello');
    expect(await runTurn(ai.tenant, ticketId)).toBe('drafted');
    expect(await assistantMessages(ai.tenant, ticketId)).toEqual([]);
    expect((await customerConversation(ai.customer)).items.filter((item) => item.message?.from.kind === 'support')).toEqual([]);
    expect(await eventsOf(ai.tenant, 'ai.draft_ready')).toHaveLength(1);

    const draft = await asUser(ai.admin).get(`/tickets/${ticketId}/ai-draft`);
    expect(draft.status).toBe(200);
    const { id: draftId, body } = draft.body as { id: string; body: string };

    const sent = await staffReply(ai.admin, ticketId, `${body} (edited)`, { aiDraftId: draftId });
    expect(sent.status).toBe(201);
    await deliverToStaffReply(ai.tenant, (sent.body as { id: string }).id);
    expect(await draftsOf(ai.tenant, ticketId)).toEqual([expect.objectContaining({ id: draftId, status: 'sent', resolved_by: ai.admin.id })]);
    const gone = await asUser(ai.admin).get(`/tickets/${ticketId}/ai-draft`);
    expect([gone.status, codeOf(gone)]).toEqual([404, 'AI_DRAFT_NOT_FOUND']);
  });

  it('keeps one open draft per ticket and discards it on request', async () => {
    const ai = await aiTenant({ mode: 'drafts' });
    const ticketId = await customerSays(ai.customer, 'Hello');
    await runTurn(ai.tenant, ticketId);
    await customerSays(ai.customer, 'Another thing');
    expect(await runTurn(ai.tenant, ticketId)).toBe('drafted');
    expect((await draftsOf(ai.tenant, ticketId)).filter((d) => d.status === 'open')).toHaveLength(1);

    expect((await asUser(ai.admin).post(`/tickets/${ticketId}/ai-draft/discard`)).status).toBe(204);
    expect((await draftsOf(ai.tenant, ticketId)).filter((d) => d.status === 'open')).toEqual([]);
  });
});

describe('SLA and notifications', () => {
  it('an assistant answer meets the first response; a hand-off notice alone does not', async () => {
    const answered = await aiTenant();
    const hours = await createBusinessHours(answered.tenant);
    await createSlaPolicy(answered.tenant, { businessHours: hours, firstResponseMinutes: 30 });
    const answeredTicket = await customerSays(answered.customer, 'Hello');
    await recomputeSla(answered.tenant, answeredTicket);
    expect((await slaRow(answered.tenant, answeredTicket))?.firstResponseDueAt).not.toBeNull();
    await runTurn(answered.tenant, answeredTicket);
    expect((await ticketRow(answered.tenant, answeredTicket)).first_agent_reply_at).not.toBeNull();
    expect(await ticketRow(answered.tenant, answeredTicket)).toMatchObject({ waiting_on: 'customer' });
    await recomputeSla(answered.tenant, answeredTicket);
    expect((await slaRow(answered.tenant, answeredTicket))?.firstResponseDueAt).toBeNull();

    const handedOff = await aiTenant();
    const handoffHours = await createBusinessHours(handedOff.tenant);
    await createSlaPolicy(handedOff.tenant, { businessHours: handoffHours, firstResponseMinutes: 30 });
    const handoffTicket = await customerSays(handedOff.customer, 'A person please [fake:handoff]');
    await runTurn(handedOff.tenant, handoffTicket);
    expect(await assistantMessages(handedOff.tenant, handoffTicket)).toHaveLength(1);
    expect((await ticketRow(handedOff.tenant, handoffTicket)).first_agent_reply_at).toBeNull();
    await recomputeSla(handedOff.tenant, handoffTicket);
    expect((await slaRow(handedOff.tenant, handoffTicket))?.firstResponseDueAt).not.toBeNull();
  });

  it('notifies no staff about assistant messages or customer follow-ups the assistant is answering', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Hello');
    await runTurn(ai.tenant, ticketId);
    const [answer] = await assistantMessages(ai.tenant, ticketId);
    expect(await deliverToNotifications(ai.tenant, answer!.id)).toBe('handled');

    await customerSays(ai.customer, 'And another thing');
    const followUp = (await messagesOf(ai.tenant, ticketId)).filter((m) => m.author_kind === 'customer').at(-1);
    expect(await deliverToNotifications(ai.tenant, followUp!.id)).toBe('handled');
    expect((await notificationTypes(ai.admin)).filter((type) => type.startsWith('message.'))).toEqual([]);
  });
});

describe('store connection', () => {
  it('rejects store URLs that are not public https', async () => {
    const ai = await aiTenant({ store: false });
    for (const baseUrl of ['https://127.0.0.1', 'https://10.0.0.5', 'https://169.254.169.254', 'http://shop.example.com', 'https://localhost']) {
      const response = await asUser(ai.admin).put('/ai/store-connection', { kind: 'spree', baseUrl, apiKey: 'spree-read-only-key' });
      expect([baseUrl, response.status, codeOf(response)]).toEqual([baseUrl, 400, 'STORE_URL_NOT_ALLOWED']);
    }
  });

  it('shows the key as last4 only and tests the connection', async () => {
    const ai = await aiTenant();
    const saved = await asUser(ai.admin).get('/ai/store-connection');
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain('spree-read-only-key');
    expect(saved.body).toMatchObject({ kind: 'spree', baseUrl: 'https://shop.example.com', apiKey: { last4: '-key' } });
    const tested = await asUser(ai.admin).post('/ai/store-connection/test');
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true });
  });
});

describe('usage', () => {
  it('records one run per provider call of a turn, with totals', async () => {
    const ai = await aiTenant();
    const ticketId = await customerSays(ai.customer, 'Where is R100200?');
    await runTurn(ai.tenant, ticketId);
    const runs = (await asUser(ai.admin).get('/ai/runs')).body as { items: { purpose: string; outcome: string }[]; totals: { runs: number; costUsd: number } };
    const turnCalls = (await fakeProvider()).calls.filter((call) => call.kind === 'chat' || call.kind === 'decide').length;
    expect(runs.items.filter((run) => run.purpose !== 'connection_test')).toHaveLength(turnCalls);
    expect(runs.totals.runs).toBe(runs.items.length);
    expect(runs.totals.costUsd).toBeGreaterThan(0);
  });
});
