import { beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { createBusinessHours, createSlaPolicy, recomputeSla, setTicketSla, slaRow } from '../../support/sla.js';

/**
 * `/business-hours*` and `/sla-policies*` (T224, US12, FR-084; permissions `sla_policy.*`):
 * triad, validation, conflicts, audit rows and re-application to open tickets. The generated
 * cross-tenant suite also walks all six routes (FIXTURES.sla_policy).
 */

const T0 = new Date('2026-03-09T10:00:00.000Z'); // a Monday
const MINUTE = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

const HIGH = { op: 'and', items: [{ field: 'priority', operator: 'is', value: 'high' }] };
const NOT_LOW = { op: 'and', items: [{ field: 'priority', operator: 'is_not', value: 'low' }] };
const HOURS_BODY = { name: 'Support hours', timezone: 'Europe/Berlin', intervals: { mon: [{ from: '09:00', to: '17:00' }], tue: [{ from: '09:00', to: '17:00' }] }, holidays: ['2026-12-25'] };

interface Fail {
  error: { code: string; message: string; details?: { path: string; issue: string }[] };
}
const fail = (response: { body: unknown }) => (response.body as Fail).error;
const details = (response: { body: unknown }) => fail(response).details ?? [];
const paths = (response: { body: unknown }) => details(response).map((d) => d.path);

interface Ctx {
  tenant: TestTenant;
  admin: TestUser;
  noPerm: TestUser;
}

async function ctx(): Promise<Ctx> {
  const tenant = await createTenant({ timezone: 'UTC' });
  const admin = await createUser(tenant, { roles: ['admin'] });
  const role = await createRole(tenant, { permissions: ['ticket.view'] });
  const noPerm = await createUser(tenant, { roles: [{ id: role.id }] });
  return { tenant, admin, noPerm };
}

function policyBody(businessHoursId: string, extra: Record<string, unknown> = {}) {
  return { name: 'High priority', conditions: HIGH, businessHoursId, firstResponseMinutes: 60, resolutionMinutes: 480, warningPercent: 80, ...extra };
}

async function auditActions(admin: TestUser): Promise<string[]> {
  const response = await asUser(admin).get('/audit-logs?limit=100');
  expect(response.status).toBe(200);
  return (response.body as { items: { action: string }[] }).items.map((item) => item.action);
}

beforeEach(async () => {
  (await getTestApp()).clock.set(T0);
});

describe('business hours: CRUD triad', () => {
  it('creates, lists, replaces and deletes a calendar', async () => {
    const { admin } = await ctx();
    const created = await asUser(admin).post('/business-hours', HOURS_BODY);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String) as string, ...HOURS_BODY });
    const id = (created.body as { id: string }).id;

    const list = await asUser(admin).get('/business-hours');
    expect(list.status).toBe(200);
    expect((list.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([id]);

    const replaced = await asUser(admin).put(`/business-hours/${id}`, { ...HOURS_BODY, name: 'Renamed', holidays: ['2026-12-26', '2026-12-25', '2026-12-25'] });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ id, name: 'Renamed', holidays: ['2026-12-25', '2026-12-26'] }); // sorted, deduplicated

    expect((await asUser(admin).delete(`/business-hours/${id}`)).status).toBe(204);
    expect(((await asUser(admin).get('/business-hours')).body as { items: unknown[] }).items).toEqual([]);
  });

  it('answers 403 PERMISSION_DENIED for every route without sla_policy permissions', async () => {
    const { tenant, noPerm } = await ctx();
    const hours = await createBusinessHours(tenant);
    const calls = [
      asUser(noPerm).get('/business-hours'),
      asUser(noPerm).post('/business-hours', HOURS_BODY),
      asUser(noPerm).put(`/business-hours/${hours.id}`, HOURS_BODY),
      asUser(noPerm).delete(`/business-hours/${hours.id}`),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(fail(response).code).toBe('PERMISSION_DENIED');
    }
  });

  it('answers tenant B the same 404 as an unknown id, and never lists tenant A calendars', async () => {
    const a = await ctx();
    const b = await ctx();
    const hours = await createBusinessHours(a.tenant);
    const unknown = uuidv7();

    const put = await asUser(b.admin).put(`/business-hours/${hours.id}`, HOURS_BODY);
    const putUnknown = await asUser(b.admin).put(`/business-hours/${unknown}`, HOURS_BODY);
    expect([put.status, put.body]).toEqual([404, putUnknown.body]);
    const del = await asUser(b.admin).delete(`/business-hours/${hours.id}`);
    const delUnknown = await asUser(b.admin).delete(`/business-hours/${unknown}`);
    expect([del.status, del.body]).toEqual([404, delUnknown.body]);

    expect(JSON.stringify((await asUser(b.admin).get('/business-hours')).body)).not.toContain(hours.id);
    // Tenant A's calendar is untouched.
    expect(((await asUser(a.admin).get('/business-hours')).body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([hours.id]);
  });
});

describe('business hours: validation and conflicts', () => {
  it('rejects an unknown timezone, malformed times, bad holidays and a calendar that is never open', async () => {
    const { admin } = await ctx();
    const cases: [object, string[]][] = [
      [{ ...HOURS_BODY, timezone: 'Mars/Base' }, ['timezone']],
      [{ ...HOURS_BODY, intervals: { mon: [{ from: '9:00', to: '17:00' }] } }, ['intervals.mon.0.from']],
      [{ ...HOURS_BODY, intervals: { mon: [{ from: '09:00', to: '25:00' }] } }, ['intervals.mon.0.to']],
      [{ ...HOURS_BODY, intervals: { mon: [{ from: '09:00', to: '09:00' }] } }, ['intervals.mon.0']],
      [{ ...HOURS_BODY, intervals: {} }, ['intervals']],
      [{ ...HOURS_BODY, holidays: ['2026-02-30'] }, ['holidays.0']],
      [{ ...HOURS_BODY, holidays: ['25/12/2026'] }, ['holidays.0']],
      [{ ...HOURS_BODY, name: '' }, ['name']],
      [{ ...HOURS_BODY, extra: 1 }, ['extra']],
    ];
    for (const [body, expected] of cases) {
      const response = await asUser(admin).post('/business-hours', body);
      expect(response.status).toBe(400);
      expect(fail(response).code).toBe('VALIDATION_FAILED');
      expect([...new Set(paths(response))]).toEqual(expected); // a malformed date can be reported by the format check and the date check
    }
  });

  it('treats a name already taken in the tenant (case-insensitively) as 409 BUSINESS_HOURS_NAME_TAKEN, but not in another tenant', async () => {
    const a = await ctx();
    const b = await ctx();
    expect((await asUser(a.admin).post('/business-hours', HOURS_BODY)).status).toBe(201);

    const again = await asUser(a.admin).post('/business-hours', { ...HOURS_BODY, name: 'SUPPORT HOURS' });
    expect(again.status).toBe(409);
    expect(fail(again).code).toBe('BUSINESS_HOURS_NAME_TAKEN');

    const other = await asUser(a.admin).post('/business-hours', { ...HOURS_BODY, name: 'Other' });
    const clash = await asUser(a.admin).put(`/business-hours/${(other.body as { id: string }).id}`, HOURS_BODY);
    expect(clash.status).toBe(409);
    expect(fail(clash).code).toBe('BUSINESS_HOURS_NAME_TAKEN');
    // Replacing a calendar with its own name is fine.
    expect((await asUser(a.admin).put(`/business-hours/${(other.body as { id: string }).id}`, { ...HOURS_BODY, name: 'Other' })).status).toBe(200);

    expect((await asUser(b.admin).post('/business-hours', HOURS_BODY)).status).toBe(201);
  });

  it('refuses to delete a calendar a policy uses (409 IN_USE) until the policy is gone', async () => {
    const { tenant, admin } = await ctx();
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30 });

    const refused = await asUser(admin).delete(`/business-hours/${hours.id}`);
    expect(refused.status).toBe(409);
    expect(fail(refused).code).toBe('IN_USE');

    expect((await asUser(admin).delete(`/sla-policies/${policy.id}`)).status).toBe(204);
    expect((await asUser(admin).delete(`/business-hours/${hours.id}`)).status).toBe(204);
  });

  it('refuses to delete the calendar the workspace settings use (409 IN_USE) until it is detached', async () => {
    const { tenant, admin } = await ctx();
    const hours = await createBusinessHours(tenant);
    expect((await asUser(admin).patch('/settings', { businessHoursId: hours.id })).status).toBe(200);

    const refused = await asUser(admin).delete(`/business-hours/${hours.id}`);
    expect(refused.status).toBe(409);
    expect(fail(refused).code).toBe('IN_USE');

    expect((await asUser(admin).patch('/settings', { businessHoursId: null })).status).toBe(200);
    expect((await asUser(admin).delete(`/business-hours/${hours.id}`)).status).toBe(204);
  });
});

describe('sla policies: CRUD triad', () => {
  it('creates last by default, lists in position order, replaces and deletes', async () => {
    const { tenant, admin } = await ctx();
    const hours = await createBusinessHours(tenant);

    const first = await asUser(admin).post('/sla-policies', policyBody(hours.id, { name: 'First', position: 10 }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      name: 'First',
      businessHoursId: hours.id,
      conditions: HIGH,
      firstResponseMinutes: 60,
      nextResponseMinutes: null,
      resolutionMinutes: 480,
      warningPercent: 80,
    });
    const second = await asUser(admin).post('/sla-policies', policyBody(hours.id, { name: 'Second' }));
    const secondBody = second.body as { id: string; position: number };
    expect(secondBody.position).toBeGreaterThan((first.body as { position: number }).position);

    const list = (await asUser(admin).get('/sla-policies')).body as { items: { name: string }[] };
    expect(list.items.map((item) => item.name)).toEqual(['First', 'Second']);

    const replaced = await asUser(admin).put(`/sla-policies/${secondBody.id}`, policyBody(hours.id, { name: 'Second v2', position: 0, resolutionMinutes: null, warningPercent: 90 }));
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ id: secondBody.id, name: 'Second v2', position: 0, resolutionMinutes: null, warningPercent: 90 });
    expect(((await asUser(admin).get('/sla-policies')).body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(['Second v2', 'First']);

    expect((await asUser(admin).delete(`/sla-policies/${secondBody.id}`)).status).toBe(204);
    expect(((await asUser(admin).get('/sla-policies')).body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('answers 403 PERMISSION_DENIED for every route without sla_policy permissions', async () => {
    const { tenant, noPerm } = await ctx();
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30 });
    const calls = [
      asUser(noPerm).get('/sla-policies'),
      asUser(noPerm).post('/sla-policies', policyBody(hours.id)),
      asUser(noPerm).put(`/sla-policies/${policy.id}`, policyBody(hours.id)),
      asUser(noPerm).delete(`/sla-policies/${policy.id}`),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(fail(response).code).toBe('PERMISSION_DENIED');
    }
  });

  it('answers tenant B the same 404 as an unknown id, and never lists tenant A policies', async () => {
    const a = await ctx();
    const b = await ctx();
    const hoursA = await createBusinessHours(a.tenant);
    const hoursB = await createBusinessHours(b.tenant);
    const policy = await createSlaPolicy(a.tenant, { businessHours: hoursA, firstResponseMinutes: 30 });
    const unknown = uuidv7();

    const put = await asUser(b.admin).put(`/sla-policies/${policy.id}`, policyBody(hoursB.id));
    const putUnknown = await asUser(b.admin).put(`/sla-policies/${unknown}`, policyBody(hoursB.id));
    expect([put.status, put.body]).toEqual([404, putUnknown.body]);
    const del = await asUser(b.admin).delete(`/sla-policies/${policy.id}`);
    const delUnknown = await asUser(b.admin).delete(`/sla-policies/${unknown}`);
    expect([del.status, del.body]).toEqual([404, delUnknown.body]);
    expect(JSON.stringify((await asUser(b.admin).get('/sla-policies')).body)).not.toContain(policy.id);
  });
});

describe('sla policies: validation', () => {
  it('validates warningPercent (50-99), minutes, conditions shape and unknown keys', async () => {
    const { tenant, admin } = await ctx();
    const hours = await createBusinessHours(tenant);
    const cases: [Record<string, unknown>, string[]][] = [
      [{ warningPercent: 49 }, ['warningPercent']],
      [{ warningPercent: 100 }, ['warningPercent']],
      [{ firstResponseMinutes: 0 }, ['firstResponseMinutes']],
      [{ resolutionMinutes: 1.5 }, ['resolutionMinutes']],
      [{ name: '' }, ['name']],
      [{ businessHoursId: 'not-a-uuid' }, ['businessHoursId']],
      [{ nope: true }, ['nope']],
    ];
    for (const [extra, expected] of cases) {
      const response = await asUser(admin).post('/sla-policies', policyBody(hours.id, extra));
      expect(response.status).toBe(400);
      expect(paths(response)).toEqual(expected);
    }
    for (const value of [50, 99]) {
      expect((await asUser(admin).post('/sla-policies', policyBody(hours.id, { name: `P${value}`, warningPercent: value }))).status).toBe(201);
    }
  });

  it('rejects conditions the matcher cannot evaluate (other fields or operators)', async () => {
    const { tenant, admin } = await ctx();
    const hours = await createBusinessHours(tenant);
    const field = await asUser(admin).post('/sla-policies', policyBody(hours.id, { conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] } }));
    expect(field.status).toBe(400);
    expect(details(field)).toEqual([{ path: 'conditions.items.0.field', issue: 'invalid_value' }]);

    const operator = await asUser(admin).post('/sla-policies', policyBody(hours.id, { conditions: { op: 'and', items: [{ field: 'priority', operator: 'contains', value: 'high' }] } }));
    expect(operator.status).toBe(400);
    expect(paths(operator)).toEqual(['conditions.items.0.operator']);
  });

  it('rejects a foreign or unknown group and a foreign or unknown calendar as invalid_value', async () => {
    const a = await ctx();
    const b = await ctx();
    const hoursA = await createBusinessHours(a.tenant);
    const hoursB = await createBusinessHours(b.tenant);
    const groupB = await createGroup(b.tenant);
    const groupA = await createGroup(a.tenant);

    const foreignGroup = await asUser(a.admin).post('/sla-policies', policyBody(hoursA.id, { conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: groupB.id }] } }));
    expect(foreignGroup.status).toBe(400);
    expect(details(foreignGroup)).toEqual([{ path: 'conditions.items.0.value', issue: 'invalid_value' }]);

    const listed = await asUser(a.admin).post('/sla-policies', policyBody(hoursA.id, { conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: [groupA.id, uuidv7()] }] } }));
    expect(listed.status).toBe(400);
    expect(details(listed)).toEqual([{ path: 'conditions.items.0.value.1', issue: 'invalid_value' }]);

    for (const businessHoursId of [hoursB.id, uuidv7()]) {
      const response = await asUser(a.admin).post('/sla-policies', policyBody(businessHoursId));
      expect(response.status).toBe(400);
      expect(details(response)).toEqual([{ path: 'businessHoursId', issue: 'invalid_value' }]);
    }

    // The tenant's own group, and the literal `ungrouped`, are fine.
    const ok = await asUser(a.admin).post('/sla-policies', policyBody(hoursA.id, { conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: [groupA.id, 'ungrouped'] }] } }));
    expect(ok.status).toBe(201);
  });
});

describe('audit', () => {
  it('writes audit rows for every calendar and policy write', async () => {
    const { admin } = await ctx();
    const hours = (await asUser(admin).post('/business-hours', HOURS_BODY)).body as { id: string };
    await asUser(admin).put(`/business-hours/${hours.id}`, { ...HOURS_BODY, name: 'Hours v2' });
    const policy = (await asUser(admin).post('/sla-policies', policyBody(hours.id))).body as { id: string };
    await asUser(admin).put(`/sla-policies/${policy.id}`, policyBody(hours.id, { name: 'Policy v2' }));
    await asUser(admin).delete(`/sla-policies/${policy.id}`);
    await asUser(admin).delete(`/business-hours/${hours.id}`);

    const actions = await auditActions(admin);
    for (const action of ['business_hours.created', 'business_hours.updated', 'business_hours.deleted', 'sla_policy.created', 'sla_policy.updated', 'sla_policy.deleted']) {
      expect(actions.filter((a) => a === action)).toHaveLength(1);
    }
  });
});

describe('re-applying the configuration to open tickets', () => {
  it('editing a policy rebuilds open tickets, leaves resolved and closed ones alone', async () => {
    const { tenant, admin } = await ctx();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 100, warningPercent: 80 });
    const open = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'a' }] });
    const resolved = await createTicket(tenant, { customer, state: 'resolved', now: T0, messages: [{ body: 'b' }] });
    const closed = await createTicket(tenant, { customer, state: 'closed', now: T0, messages: [{ body: 'c' }] });
    await recomputeSla(tenant, open.id);
    expect((await slaRow(tenant, open.id))?.resolutionDueAt).toEqual(at(100));
    await setTicketSla(tenant, resolved.id, policy, 'warning');
    await setTicketSla(tenant, closed.id, policy, 'breached');

    const updated = await asUser(admin).put(`/sla-policies/${policy.id}`, {
      name: 'Edited',
      conditions: NOT_LOW,
      businessHoursId: hours.id,
      resolutionMinutes: 200,
      warningPercent: 50,
    });
    expect(updated.status).toBe(200);

    expect(await slaRow(tenant, open.id)).toMatchObject({ resolutionDueAt: at(200), resolutionWarnAt: at(100) });
    expect(await slaRow(tenant, resolved.id)).toMatchObject({ status: 'warning', resolutionDueAt: null });
    expect(await slaRow(tenant, closed.id)).toMatchObject({ status: 'breached', resolutionDueAt: null });
  });

  it('a policy that stops matching, or is deleted, removes the open ticket row; a new matching policy creates it', async () => {
    const { tenant, admin } = await ctx();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 100 });
    const ticket = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'a' }] }); // priority normal
    await recomputeSla(tenant, ticket.id);
    expect(await slaRow(tenant, ticket.id)).toBeDefined();

    const narrowed = await asUser(admin).put(`/sla-policies/${policy.id}`, policyBody(hours.id, { firstResponseMinutes: null, resolutionMinutes: 100 })); // high only
    expect(narrowed.status).toBe(200);
    expect(await slaRow(tenant, ticket.id)).toBeUndefined();

    const created = await asUser(admin).post('/sla-policies', { name: 'All', conditions: NOT_LOW, businessHoursId: hours.id, firstResponseMinutes: 45 });
    expect(created.status).toBe(201);
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ firstResponseDueAt: at(45) });

    expect((await asUser(admin).delete(`/sla-policies/${(created.body as { id: string }).id}`)).status).toBe(204);
    expect(await slaRow(tenant, ticket.id)).toBeUndefined();
  });

  it('editing a calendar recomputes open tickets on the new schedule', async () => {
    const { tenant, admin } = await ctx();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const hours = await createBusinessHours(tenant, { name: 'Edited hours' });
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'a' }] });
    const resolved = await createTicket(tenant, { customer, state: 'resolved', now: T0, messages: [{ body: 'b' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(60)); // open all week
    const policyRow = await slaRow(tenant, ticket.id);
    await setTicketSla(tenant, resolved.id, { id: policyRow?.policyId ?? '' }, 'ok');

    // Monday 11:00-17:00 UTC only: created at 10:00, the 60 minutes start at 11:00.
    const response = await asUser(admin).put(`/business-hours/${hours.id}`, {
      name: 'Edited hours',
      timezone: 'UTC',
      intervals: { mon: [{ from: '11:00', to: '17:00' }] },
      holidays: [],
    });
    expect(response.status).toBe(200);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(120)); // 12:00
    expect(await slaRow(tenant, resolved.id)).toMatchObject({ status: 'ok', firstResponseDueAt: null });
  });
});
