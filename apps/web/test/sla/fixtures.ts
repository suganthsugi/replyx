import type { BusinessHours, Me, SlaPolicy } from '../../src/api/generated/model';

export function makeMe(permissions: string[]): Me {
  return {
    id: 'u1',
    email: 'ada@acme.test',
    name: 'Ada',
    kind: 'staff',
    roles: [],
    permissions,
    groupAccess: [],
    accessVersion: 1,
  };
}

export function makePolicy(overrides: Partial<SlaPolicy> = {}): SlaPolicy {
  return {
    id: 'p1',
    name: 'Urgent first response',
    position: 0,
    conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['urgent'] }] },
    businessHoursId: 'cal-office',
    firstResponseMinutes: 15,
    nextResponseMinutes: null,
    resolutionMinutes: 480,
    warningPercent: 80,
    ...overrides,
  };
}

export const calendarOffice: BusinessHours = {
  id: 'cal-office',
  name: 'Office hours',
  timezone: 'Europe/London',
  intervals: {
    mon: [{ from: '09:00', to: '17:00' }],
    tue: [{ from: '09:00', to: '17:00' }],
    wed: [{ from: '09:00', to: '17:00' }],
    thu: [{ from: '09:00', to: '17:00' }],
    fri: [{ from: '09:00', to: '17:00' }],
  },
  holidays: ['2026-12-25', '2026-12-26'],
};

export const calendarNight: BusinessHours = {
  id: 'cal-night',
  name: 'Night desk',
  timezone: 'UTC',
  intervals: { sat: [{ from: '00:00', to: '24:00' }], sun: [{ from: '00:00', to: '24:00' }] },
  holidays: [],
};
