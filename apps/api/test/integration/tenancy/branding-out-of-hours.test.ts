import { beforeEach, describe, expect, it } from 'vitest';

import { getTestApp } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';
import { createBusinessHours, WEEKDAYS_9_TO_17 } from '../../support/sla.js';

/**
 * `GET /customer/branding` `outOfHoursMessage` (T224, FR-054): the configured message only while
 * the injected clock is outside the settings calendar's hours; chat itself stays available.
 */

const MESSAGE = 'We are away right now and will reply when we are back.';

const MONDAY_10 = new Date('2026-03-09T10:00:00.000Z');
const MONDAY_20 = new Date('2026-03-09T20:00:00.000Z');
const MONDAY_08 = new Date('2026-03-09T08:59:59.000Z');
const SATURDAY = new Date('2026-03-14T11:00:00.000Z');

async function setClock(date: Date): Promise<void> {
  (await getTestApp()).clock.set(date);
}

async function world(): Promise<{ tenant: TestTenant; admin: TestUser }> {
  await setClock(MONDAY_10);
  const tenant = await createTenant({ timezone: 'UTC' });
  const admin = await createUser(tenant, { roles: ['admin'] });
  return { tenant, admin };
}

async function outOfHours(tenant: TestTenant): Promise<string | null> {
  const response = await asGuest(tenant).get('/customer/branding');
  expect(response.status).toBe(200);
  return (response.body as { outOfHoursMessage: string | null }).outOfHoursMessage;
}

beforeEach(async () => {
  await setClock(MONDAY_10);
});

describe('outOfHoursMessage', () => {
  it('is null inside hours and the message outside hours, following the clock', async () => {
    const { tenant, admin } = await world();
    const hours = await createBusinessHours(tenant, { intervals: WEEKDAYS_9_TO_17 });
    const patched = await asUser(admin).patch('/settings', { businessHoursId: hours.id, outOfHoursMessage: MESSAGE });
    expect(patched.status).toBe(200);

    expect(await outOfHours(tenant)).toBeNull(); // Monday 10:00
    await setClock(MONDAY_20);
    expect(await outOfHours(tenant)).toBe(MESSAGE);
    await setClock(MONDAY_08);
    expect(await outOfHours(tenant)).toBe(MESSAGE);
    await setClock(SATURDAY);
    expect(await outOfHours(tenant)).toBe(MESSAGE);
    await setClock(MONDAY_10);
    expect(await outOfHours(tenant)).toBeNull();
  });

  it('is null with no calendar, or with a calendar but no message', async () => {
    const { tenant, admin } = await world();
    expect((await asUser(admin).patch('/settings', { outOfHoursMessage: MESSAGE })).status).toBe(200);
    await setClock(MONDAY_20);
    expect(await outOfHours(tenant)).toBeNull(); // message but no calendar

    const hours = await createBusinessHours(tenant, { intervals: WEEKDAYS_9_TO_17 });
    await setClock(MONDAY_10);
    expect((await asUser(admin).patch('/settings', { businessHoursId: hours.id, outOfHoursMessage: null })).status).toBe(200);
    await setClock(MONDAY_20);
    expect(await outOfHours(tenant)).toBeNull(); // calendar but no message
  });

  it('uses the calendar timezone and holidays', async () => {
    const { tenant, admin } = await world();
    const hours = await createBusinessHours(tenant, { timezone: 'America/Los_Angeles', intervals: WEEKDAYS_9_TO_17, holidays: ['2026-03-10'] });
    expect((await asUser(admin).patch('/settings', { businessHoursId: hours.id, outOfHoursMessage: MESSAGE })).status).toBe(200);

    // Monday 10:00 UTC is 03:00 in Los Angeles (PDT): closed.
    expect(await outOfHours(tenant)).toBe(MESSAGE);
    await setClock(new Date('2026-03-09T17:00:00.000Z')); // 10:00 local
    expect(await outOfHours(tenant)).toBeNull();
    await setClock(new Date('2026-03-10T17:00:00.000Z')); // 10:00 local, but a holiday
    expect(await outOfHours(tenant)).toBe(MESSAGE);
  });

  it('is per tenant: another tenant sees null whatever this one configures', async () => {
    const a = await world();
    const b = await world();
    const hours = await createBusinessHours(a.tenant, { intervals: WEEKDAYS_9_TO_17 });
    expect((await asUser(a.admin).patch('/settings', { businessHoursId: hours.id, outOfHoursMessage: MESSAGE })).status).toBe(200);
    await setClock(MONDAY_20);
    expect(await outOfHours(a.tenant)).toBe(MESSAGE);
    expect(await outOfHours(b.tenant)).toBeNull();
  });
});
