import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * `/routing-rules*` (T217; contracts/operations.yaml, FR-059-FR-061) and the end-to-end routing of
 * a real customer message. Each endpoint gets success, 403 (an agent holds no routing_rule
 * permission) and the cross-tenant 404 equal to the unknown-id body.
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

interface RuleBody {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: Record<string, string[]>;
  actions: { groupId: string; priority?: string; tagIds?: string[] };
  createdAt: string;
  updatedAt: string;
}

interface DryRunBody {
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  actions: RuleBody['actions'] | null;
  skipped: { ruleId: string; ruleName: string; reason: string }[];
}

type ErrorBody = { error: { code: string; details?: { path: string; issue: string }[] } };

const body = <T>(response: { body: unknown }) => response.body as T;
const failure = (response: { body: unknown }) => response.body as ErrorBody;

function ruleInput(groupId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Refunds',
    enabled: true,
    conditions: { messageContainsAny: ['refund'] },
    actions: { groupId },
    ...overrides,
  };
}

function systemContext(tenant: TestTenant): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'routing-rules-test' });
}

class Inspect extends TenantRepository {
  audit(tx: TenantTransaction, action: string) {
    return this.selectFrom(tx, 'audit_logs').select(['action', 'resource_id', 'details']).where('action', '=', action).execute();
  }

  ticketsOf(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select(['id', 'group_id', 'priority', 'state']).where('customer_id', '=', customerId).orderBy('created_at').execute();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history').select(['field', 'actor_kind', 'new_value']).where('ticket_id', '=', ticketId).execute();
  }

  ticketTags(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_tags').select('tag_id').where('ticket_id', '=', ticketId).execute();
  }

  ruleCount(tx: TenantTransaction) {
    return this.selectFrom(tx, 'routing_rules').select('id').execute();
  }

  insertRules(tx: TenantTransaction, rows: { name: string; enabled: boolean; position: number; conditions: string; actions: string }[]) {
    return this.insertInto(tx, 'routing_rules', rows).execute();
  }

  setGroupStatus(tx: TenantTransaction, groupId: string, status: 'active' | 'inactive') {
    return this.updateTable(tx, 'groups').set({ status }).where('id', '=', groupId).execute();
  }

  addCustomerTag(tx: TenantTransaction, userId: string, tagId: string) {
    return this.insertInto(tx, 'customer_tags', { user_id: userId, tag_id: tagId }).execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = systemContext(tenant);
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

async function createRule(admin: TestUser, groupId: string, overrides: Record<string, unknown> = {}): Promise<RuleBody> {
  const response = await asUser(admin).post('/routing-rules', ruleInput(groupId, overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return body<RuleBody>(response);
}

async function createTag(admin: TestUser, name: string): Promise<string> {
  const response = await asUser(admin).post('/tags', { name: `${name.slice(0, 20)} ${uuidv7().slice(-8)}` });
  expect(response.status).toBe(201);
  return body<{ id: string }>(response).id;
}

const listRules = async (admin: TestUser) => body<{ items: RuleBody[] }>(await asUser(admin).get('/routing-rules')).items;

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let agent: TestUser;
let adminB: TestUser;

/** Each test starts from an empty rule list so positions are predictable. */
async function clearRules(): Promise<void> {
  for (const rule of await listRules(admin)) {
    expect((await asUser(admin).delete(`/routing-rules/${rule.id}`)).status).toBe(204);
  }
}

beforeAll(async () => {
  await getTestApp();
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [admin, agent, adminB] = await Promise.all([
    createUser(a, { roles: ['admin'] }),
    createUser(a, { roles: ['agent'] }),
    createUser(b, { roles: ['admin'] }),
  ]);
});

describe('GET /routing-rules', () => {
  it('lists the tenant rules in position order, never another tenant rules (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const first = await createRule(admin, group.id, { name: 'First' });
    const second = await createRule(admin, group.id, { name: 'Second' });
    const groupB = await createGroup(b);
    const foreign = await createRule(adminB, groupB.id, { name: 'Other tenant' });

    const response = await asUser(admin).get('/routing-rules');
    expect(response.status).toBe(200);
    const items = body<{ items: RuleBody[] }>(response).items;
    expect(items.map((rule) => [rule.id, rule.position])).toEqual([
      [first.id, 0],
      [second.id, 1],
    ]);
    expect(JSON.stringify(response.body)).not.toContain(foreign.id);
    expect(Object.keys(items[0] as RuleBody).sort()).toEqual(['actions', 'conditions', 'createdAt', 'enabled', 'id', 'name', 'position', 'updatedAt']);
  });

  it('is 403 PERMISSION_DENIED for a user without routing_rule.view', async () => {
    const response = await asUser(agent).get('/routing-rules');
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('POST /routing-rules', () => {
  it('creates a rule at the end and audits it (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const tagId = await createTag(admin, `Billing ${uuidv7()}`);
    const response = await asUser(admin).post(
      '/routing-rules',
      ruleInput(group.id, {
        conditions: { messageContainsAny: ['refund', 'refund'], emailDomains: ['@Example.com'] },
        actions: { groupId: group.id, priority: 'high', tagIds: [tagId] },
      }),
    );
    expect(response.status).toBe(201);
    const rule = body<RuleBody>(response);
    expect(rule).toMatchObject({
      name: 'Refunds',
      position: 0,
      enabled: true,
      conditions: { messageContainsAny: ['refund'], emailDomains: ['example.com'] },
      actions: { groupId: group.id, priority: 'high', tagIds: [tagId] },
    });
    expect((await createRule(admin, group.id, { name: 'Second' })).position).toBe(1);

    const audit = await inspect(a, (tx, repo) => repo.audit(tx, 'routing_rule.created'));
    expect(audit.map((row) => row.resource_id)).toContain(rule.id);
  });

  it('is 403 without routing_rule.create', async () => {
    const group = await createGroup(a);
    const response = await asUser(agent).post('/routing-rules', ruleInput(group.id));
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('cannot use another tenant group or tag (cross-tenant ids are unknown ids)', async () => {
    const groupB = await createGroup(b);
    const tagB = await createTag(adminB, `Tag ${uuidv7()}`);
    const response = await asUser(admin).post(
      '/routing-rules',
      ruleInput(groupB.id, { conditions: { customerTagIds: [tagB] }, actions: { groupId: groupB.id, tagIds: [tagB] } }),
    );
    expect(response.status).toBe(400);
    expect(failure(response).error.code).toBe('VALIDATION_FAILED');
    expect(failure(response).error.details).toEqual(
      expect.arrayContaining([
        { path: 'actions.groupId', issue: 'invalid_value' },
        { path: 'conditions.customerTagIds.0', issue: 'invalid_value' },
        { path: 'actions.tagIds.0', issue: 'invalid_value' },
      ]),
    );
  });

  it('validates the body', async () => {
    const group = await createGroup(a);
    const noCondition = await asUser(admin).post('/routing-rules', ruleInput(group.id, { conditions: { messageContainsAny: [] } }));
    expect(noCondition.status).toBe(400);
    expect(failure(noCondition).error.code).toBe('VALIDATION_FAILED');
    expect(failure(noCondition).error.details).toEqual([{ path: 'conditions', issue: 'invalid' }]);

    const unknownGroup = await asUser(admin).post('/routing-rules', ruleInput(uuidv7()));
    expect(failure(unknownGroup).error.details).toEqual([{ path: 'actions.groupId', issue: 'invalid_value' }]);

    const unknownTag = await asUser(admin).post('/routing-rules', ruleInput(group.id, { actions: { groupId: group.id, tagIds: [uuidv7()] } }));
    expect(failure(unknownTag).error.details).toEqual([{ path: 'actions.tagIds.0', issue: 'invalid_value' }]);

    const badName = await asUser(admin).post('/routing-rules', ruleInput(group.id, { name: '' }));
    expect(badName.status).toBe(400);
    expect(failure(badName).error.details?.[0]?.path).toBe('name');
  });

  it('requires an active group for an enabled rule, but lets a disabled rule keep an inactive one', async () => {
    const inactive = await createGroup(a, { status: 'inactive' });
    const enabled = await asUser(admin).post('/routing-rules', ruleInput(inactive.id));
    expect(enabled.status).toBe(400);
    expect(failure(enabled).error.details).toEqual([{ path: 'actions.groupId', issue: 'invalid_value' }]);

    const disabled = await asUser(admin).post('/routing-rules', ruleInput(inactive.id, { enabled: false }));
    expect(disabled.status).toBe(201);
  });

  it('refuses the 101st rule with 409 ROUTING_RULE_LIMIT', async () => {
    const tenant = await createTenant();
    const owner = await createUser(tenant, { roles: ['admin'] });
    const group = await createGroup(tenant);
    const rows = Array.from({ length: 100 }, (_unused, index) => ({
      name: `Rule ${index}`,
      enabled: true,
      position: index,
      conditions: JSON.stringify({ messageContainsAny: ['x'] }),
      actions: JSON.stringify({ groupId: group.id }),
    }));
    await inspect(tenant, (tx, repo) => repo.insertRules(tx, rows));

    const response = await asUser(owner).post('/routing-rules', ruleInput(group.id));
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('ROUTING_RULE_LIMIT');
  });
});

describe('PUT /routing-rules/{id}', () => {
  it('replaces the definition, keeps the position and audits (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const other = await createGroup(a);
    await createRule(admin, group.id, { name: 'Zero' });
    const rule = await createRule(admin, group.id, { name: 'One' });

    const response = await asUser(admin).put(
      `/routing-rules/${rule.id}`,
      ruleInput(other.id, { name: 'Renamed', enabled: false, conditions: { messageContainsAll: ['a', 'b'] } }),
    );
    expect(response.status).toBe(200);
    expect(body<RuleBody>(response)).toMatchObject({
      id: rule.id,
      name: 'Renamed',
      position: 1,
      enabled: false,
      conditions: { messageContainsAll: ['a', 'b'] },
      actions: { groupId: other.id },
    });
    const audit = await inspect(a, (tx, repo) => repo.audit(tx, 'routing_rule.updated'));
    expect(audit.map((row) => row.resource_id)).toContain(rule.id);
  });

  it('is 403 without routing_rule.edit', async () => {
    const group = await createGroup(a);
    const rule = await createRule(admin, group.id);
    const response = await asUser(agent).put(`/routing-rules/${rule.id}`, ruleInput(group.id));
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('is 404 ROUTING_RULE_NOT_FOUND for another tenant rule, equal to an unknown id', async () => {
    const group = await createGroup(a);
    const rule = await createRule(admin, group.id);
    const groupB = await createGroup(b);
    await expectCrossTenant404((id) => asUser(adminB).put(`/routing-rules/${id}`, ruleInput(groupB.id)), rule.id);
    const unknown = await asUser(adminB).put(`/routing-rules/${UNKNOWN_ID}`, ruleInput(groupB.id));
    expect(failure(unknown).error.code).toBe('ROUTING_RULE_NOT_FOUND');
  });

  it('validates the body before changing anything', async () => {
    const group = await createGroup(a);
    const rule = await createRule(admin, group.id, { name: 'Keep me' });
    const response = await asUser(admin).put(`/routing-rules/${rule.id}`, ruleInput(uuidv7()));
    expect(response.status).toBe(400);
    expect((await listRules(admin)).find((item) => item.id === rule.id)?.name).toBe('Keep me');
  });
});

describe('PUT /routing-rules/order', () => {
  it('sets positions from the id list and audits (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const r1 = await createRule(admin, group.id, { name: 'R1' });
    const r2 = await createRule(admin, group.id, { name: 'R2' });
    const r3 = await createRule(admin, group.id, { name: 'R3' });

    const response = await asUser(admin).put('/routing-rules/order', { ids: [r3.id, r1.id, r2.id] });
    expect(response.status).toBe(204);
    expect((await listRules(admin)).map((rule) => [rule.id, rule.position])).toEqual([
      [r3.id, 0],
      [r1.id, 1],
      [r2.id, 2],
    ]);
    expect(await inspect(a, (tx, repo) => repo.audit(tx, 'routing_rule.reordered'))).not.toHaveLength(0);
  });

  it('is 403 without routing_rule.edit', async () => {
    const response = await asUser(agent).put('/routing-rules/order', { ids: [] });
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('rejects a list that is not exactly the workspace rules, including another tenant id (400 on ids)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const r1 = await createRule(admin, group.id);
    const r2 = await createRule(admin, group.id);
    const groupB = await createGroup(b);
    const foreign = await createRule(adminB, groupB.id);

    const expected = [{ path: 'ids', issue: 'invalid' }];
    for (const ids of [[r1.id], [r1.id, r2.id, uuidv7()], [r1.id, foreign.id], [r1.id, r1.id]]) {
      const response = await asUser(admin).put('/routing-rules/order', { ids });
      expect(response.status).toBe(400);
      expect(failure(response).error.details).toEqual(expected);
    }
    expect((await listRules(admin)).map((rule) => rule.id)).toEqual([r1.id, r2.id]);
  });
});

describe('DELETE /routing-rules/{id}', () => {
  it('hard deletes, re-compacts positions and audits (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const r1 = await createRule(admin, group.id, { name: 'R1' });
    const r2 = await createRule(admin, group.id, { name: 'R2' });
    const r3 = await createRule(admin, group.id, { name: 'R3' });

    expect((await asUser(admin).delete(`/routing-rules/${r2.id}`)).status).toBe(204);
    expect((await listRules(admin)).map((rule) => [rule.id, rule.position])).toEqual([
      [r1.id, 0],
      [r3.id, 1],
    ]);
    const rows = await inspect(a, (tx, repo) => repo.ruleCount(tx));
    expect(rows.map((row) => row.id)).not.toContain(r2.id);
    const audit = await inspect(a, (tx, repo) => repo.audit(tx, 'routing_rule.deleted'));
    expect(audit.map((row) => row.resource_id)).toContain(r2.id);
  });

  it('is 403 without routing_rule.delete', async () => {
    const group = await createGroup(a);
    const rule = await createRule(admin, group.id);
    const response = await asUser(agent).delete(`/routing-rules/${rule.id}`);
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
    expect((await listRules(admin)).map((item) => item.id)).toContain(rule.id);
  });

  it('is 404 ROUTING_RULE_NOT_FOUND for another tenant rule and leaves it in place', async () => {
    const group = await createGroup(a);
    const rule = await createRule(admin, group.id);
    await expectCrossTenant404((id) => asUser(adminB).delete(`/routing-rules/${id}`), rule.id);
    expect((await listRules(admin)).map((item) => item.id)).toContain(rule.id);
  });
});

describe('POST /routing-rules/test (dry run)', () => {
  it('reports the matching rule and its actions without writing anything (success)', async () => {
    await clearRules();
    const group = await createGroup(a);
    const tagId = await createTag(admin, `Dry ${uuidv7()}`);
    const rule = await createRule(admin, group.id, { name: 'Refunds', actions: { groupId: group.id, priority: 'urgent', tagIds: [tagId] } });
    const before = await inspect(a, (tx, repo) => repo.ruleCount(tx));

    const response = await asUser(admin).post('/routing-rules/test', { message: 'I want a REFUND please' });
    expect(response.status).toBe(200);
    expect(body<DryRunBody>(response)).toEqual({
      matchedRuleId: rule.id,
      matchedRuleName: 'Refunds',
      actions: { groupId: group.id, priority: 'urgent', tagIds: [tagId] },
      skipped: [],
    });
    expect(await inspect(a, (tx, repo) => repo.ruleCount(tx))).toEqual(before);
  });

  it('answers null when nothing matches and lists skipped rules with an inactive group', async () => {
    await clearRules();
    const group = await createGroup(a);
    const fallbackGroup = await createGroup(a);
    const first = await createRule(admin, group.id, { name: 'Will be skipped' });
    const second = await createRule(admin, fallbackGroup.id, { name: 'Fallback' });
    await inspect(a, (tx, repo) => repo.setGroupStatus(tx, group.id, 'inactive'));

    const skipped = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'refund' }));
    expect(skipped.matchedRuleId).toBe(second.id);
    expect(skipped.skipped).toEqual([{ ruleId: first.id, ruleName: 'Will be skipped', reason: 'group_inactive' }]);

    const none = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'hello there' }));
    expect(none).toEqual({ matchedRuleId: null, matchedRuleName: null, actions: null, skipped: [] });
  });

  it('uses the sample email and tags, or a real customer email and tags', async () => {
    await clearRules();
    const group = await createGroup(a);
    const tagId = await createTag(admin, `Vip ${uuidv7()}`);
    const domainRule = await createRule(admin, group.id, { name: 'Domain', conditions: { emailDomains: ['acme.test'] } });
    const tagRule = await createRule(admin, group.id, { name: 'Tag', conditions: { customerTagIds: [tagId] } });

    const byEmail = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'hi', customerEmail: 'x@acme.test' }));
    expect(byEmail.matchedRuleId).toBe(domainRule.id);
    const byTag = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'hi', customerTagIds: [tagId] }));
    expect(byTag.matchedRuleId).toBe(tagRule.id);

    const customer = await createUser(a, { roles: ['customer'] });
    await inspect(a, (tx, repo) => repo.addCustomerTag(tx, customer.id, tagId));
    const byCustomer = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'hi', customerId: customer.id }));
    expect(byCustomer.matchedRuleId).toBe(tagRule.id);

    const mixed = await asUser(admin).post('/routing-rules/test', { message: 'hi', customerId: customer.id, customerEmail: 'x@acme.test' });
    expect(mixed.status).toBe(400);
  });

  it('is 403 without routing_rule.view', async () => {
    const response = await asUser(agent).post('/routing-rules/test', { message: 'refund' });
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('is 404 CUSTOMER_NOT_FOUND for another tenant customer, equal to an unknown id', async () => {
    const customerA = await createUser(a, { roles: ['customer'] });
    await expectCrossTenant404((id) => asUser(adminB).post('/routing-rules/test', { message: 'hi', customerId: id }), customerA.id);
    const unknown = await asUser(adminB).post('/routing-rules/test', { message: 'hi', customerId: UNKNOWN_ID });
    expect(failure(unknown).error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('never evaluates another tenant rules', async () => {
    await clearRules();
    const groupB = await createGroup(b);
    await createRule(adminB, groupB.id, { name: 'B refunds' });
    const response = body<DryRunBody>(await asUser(admin).post('/routing-rules/test', { message: 'refund' }));
    expect(response.matchedRuleId).toBeNull();
  });
});

describe('routing a real customer message', () => {
  async function send(customer: TestUser, text: string): Promise<void> {
    const response = await asUser(customer).post('/customer/messages', { body: text, clientMessageId: uuidv7() });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  it('creates the ticket in the rule group with its priority and tags, recorded as routing history', async () => {
    await clearRules();
    const group = await createGroup(a);
    const tagId = await createTag(admin, `Refund ${uuidv7()}`);
    await createRule(admin, group.id, { name: 'Refunds', actions: { groupId: group.id, priority: 'high', tagIds: [tagId] } });
    const customer = await createUser(a, { roles: ['customer'] });

    await send(customer, 'I want a refund');

    const [ticket] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, customer.id));
    expect(ticket).toMatchObject({ group_id: group.id, priority: 'high', state: 'new' });
    const ticketId = (ticket as { id: string }).id;
    const tags = await inspect(a, (tx, repo) => repo.ticketTags(tx, ticketId));
    expect(tags.map((row) => row.tag_id)).toEqual([tagId]);
    const history = await inspect(a, (tx, repo) => repo.history(tx, ticketId));
    const routed = history.filter((row) => row.actor_kind === 'routing');
    expect(routed.map((row) => row.field).sort()).toEqual(['group_id', 'priority', 'tags']);
  });

  it('applies only the first of two overlapping rules', async () => {
    await clearRules();
    const first = await createGroup(a);
    const second = await createGroup(a);
    await createRule(admin, first.id, { name: 'First', actions: { groupId: first.id, priority: 'urgent' } });
    await createRule(admin, second.id, { name: 'Second', actions: { groupId: second.id, priority: 'low' } });
    const customer = await createUser(a, { roles: ['customer'] });

    await send(customer, 'Refund needed');

    const [ticket] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, customer.id));
    expect(ticket).toMatchObject({ group_id: first.id, priority: 'urgent' });
  });

  it('leaves the ticket ungrouped (Needs Triage) when no rule matches', async () => {
    await clearRules();
    const group = await createGroup(a);
    await createRule(admin, group.id);
    const customer = await createUser(a, { roles: ['customer'] });

    await send(customer, 'How do I change my password?');

    const [ticket] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, customer.id));
    expect(ticket).toMatchObject({ group_id: null, priority: 'normal' });
    const history = await inspect(a, (tx, repo) => repo.history(tx, (ticket as { id: string }).id));
    expect(history.filter((row) => row.actor_kind === 'routing')).toEqual([]);
  });

  it('skips a rule whose group was deactivated and falls to the next rule, or to Needs Triage', async () => {
    await clearRules();
    const gone = await createGroup(a);
    const next = await createGroup(a);
    await createRule(admin, gone.id, { name: 'Deactivated target' });
    await createRule(admin, next.id, { name: 'Next', actions: { groupId: next.id } });
    await inspect(a, (tx, repo) => repo.setGroupStatus(tx, gone.id, 'inactive'));
    const customer = await createUser(a, { roles: ['customer'] });
    await send(customer, 'refund please');
    const [fallback] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, customer.id));
    expect(fallback).toMatchObject({ group_id: next.id });

    await inspect(a, (tx, repo) => repo.setGroupStatus(tx, next.id, 'inactive'));
    const other = await createUser(a, { roles: ['customer'] });
    await send(other, 'refund please');
    const [triage] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, other.id));
    expect(triage).toMatchObject({ group_id: null });
  });

  it('does not route with another tenant rules', async () => {
    await clearRules();
    const groupB = await createGroup(b);
    await createRule(adminB, groupB.id, { name: 'B refunds' });
    const customer = await createUser(a, { roles: ['customer'] });

    await send(customer, 'refund');

    const [ticket] = await inspect(a, (tx, repo) => repo.ticketsOf(tx, customer.id));
    expect(ticket).toMatchObject({ group_id: null });
  });
});
