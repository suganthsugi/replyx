import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestApp, getTestWorker } from '../../support/app.js';
import { createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { sweeperJob } from '../../support/jobs.js';
import { createBusinessHours, createSlaPolicy, recomputeSla, setTicketSla } from '../../support/sla.js';
import { createView } from '../../support/view-factory.js';

import type { ConditionGroup } from '../../../src/views/condition-schema.js';

/**
 * The Escalated default view, the `sla_status` view filter and the view counts after a breach
 * (T224, FR-085; views/view-compiler.ts `slaStatusFilter`, views/counts-notifier.ts). Runs the real
 * worker so the counts consumer invalidates the cached counts; the sweeper runs by hand on the API
 * app's TestClock.
 */

const T0 = new Date('2026-03-09T10:00:00.000Z');
const MINUTE = 60_000;

interface ViewItem {
  id: string;
  system: string | null;
}

let tenant: TestTenant;
let admin: TestUser;
let customer: TestUser;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant({ timezone: 'UTC' });
  admin = await createUser(tenant, { roles: ['admin'] });
  customer = await createUser(tenant, { roles: ['customer'] });
});

beforeEach(async () => {
  (await getTestApp()).clock.set(T0);
});

async function escalatedViewId(): Promise<string> {
  const response = await asUser(admin).get('/views');
  const view = (response.body as { items: ViewItem[] }).items.find((item) => item.system === 'escalated');
  if (view === undefined) throw new Error('No Escalated view');
  return view.id;
}

async function idsIn(viewId: string): Promise<Set<string>> {
  const response = await asUser(admin).get(`/tickets?viewId=${viewId}&limit=100`);
  expect(response.status).toBe(200);
  return new Set((response.body as { items: { id: string }[] }).items.map((item) => item.id));
}

const slaCondition = (operator: 'is' | 'is_not' | 'contains', value: string | string[]): ConditionGroup => ({ op: 'and', items: [{ field: 'sla_status', operator, value }] });

describe('Escalated and sla_status', () => {
  it('Escalated lists warning and breached open tickets only, and a custom sla_status view filters on the status', async () => {
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 60 });
    const make = (state: 'open' | 'resolved' | 'closed' = 'open') => createTicket(tenant, { customer, state, now: T0, messages: [{ body: 'x' }] });
    const [ok, warning, breached, none, resolvedBreached, closedBreached] = [await make(), await make(), await make(), await make(), await make('resolved'), await make('closed')];
    await setTicketSla(tenant, ok.id, policy, 'ok');
    await setTicketSla(tenant, warning.id, policy, 'warning');
    await setTicketSla(tenant, breached.id, policy, 'breached');
    await setTicketSla(tenant, resolvedBreached.id, policy, 'breached');
    await setTicketSla(tenant, closedBreached.id, policy, 'breached');

    const escalated = await idsIn(await escalatedViewId());
    expect(escalated.has(warning.id)).toBe(true);
    expect(escalated.has(breached.id)).toBe(true);
    expect(escalated.has(resolvedBreached.id)).toBe(true); // only closed tickets are excluded
    expect(escalated.has(ok.id)).toBe(false);
    expect(escalated.has(none.id)).toBe(false);
    expect(escalated.has(closedBreached.id)).toBe(false);

    const only = async (operator: 'is' | 'is_not' | 'contains', value: string | string[]) => {
      const view = await createView(tenant, { conditions: slaCondition(operator, value) });
      return idsIn(view.id);
    };
    const breachedOnly = await only('is', 'breached');
    expect([breachedOnly.has(breached.id), breachedOnly.has(warning.id), breachedOnly.has(none.id)]).toEqual([true, false, false]);
    const notBreached = await only('is_not', 'breached');
    expect([notBreached.has(ok.id), notBreached.has(none.id), notBreached.has(breached.id)]).toEqual([true, true, false]); // no row counts as not breached
    const noSla = await only('is', 'none');
    expect(noSla.has(none.id)).toBe(true);
    expect(noSla.has(ok.id)).toBe(false);
    const anyOf = await only('contains', ['ok', 'none']);
    expect([anyOf.has(ok.id), anyOf.has(none.id), anyOf.has(warning.id)]).toEqual([true, true, false]);
  });

  it('a breach moves the ticket into Escalated, and the cached view counts follow', async () => {
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60, warningPercent: 80 });
    const viewId = await escalatedViewId();
    const before = ((await asUser(admin).get('/views/counts')).body as Record<string, number>)[viewId] ?? 0;

    const ticket = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await idsIn(viewId)).has(ticket.id)).toBe(false);

    const sweepAt = async (minutes: number) => {
      (await getTestApp()).clock.set(new Date(T0.getTime() + minutes * MINUTE));
      await (await sweeperJob()).process();
    };

    await sweepAt(50); // warning
    expect((await idsIn(viewId)).has(ticket.id)).toBe(true);
    await vi.waitFor(
      async () => {
        const counts = (await asUser(admin).get('/views/counts')).body as Record<string, number>;
        expect(counts[viewId]).toBe(before + 1);
      },
      { timeout: 20_000, interval: 250 },
    );

    await sweepAt(61); // breached: still escalated, count unchanged
    expect((await idsIn(viewId)).has(ticket.id)).toBe(true);
    const counts = (await asUser(admin).get('/views/counts')).body as Record<string, number>;
    expect(counts[viewId]).toBe(before + 1);
  });
});
