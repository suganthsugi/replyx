import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  BusinessCalendar,
  BusinessCalendarError,
  MAX_SCAN_DAYS,
  twentyFourSeven,
} from '../../../src/sla/business-calendar.js';

// 2026 reference dates: Jan 5 Mon, Jan 9 Fri, Jan 10 Sat, Jan 11 Sun, Jan 12 Mon, Jan 13 Tue, Jan 14 Wed.
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const at = (value: string): Date => new Date(value);
const iso = (d: Date): string => d.toISOString();

function cal(
  timezone: string,
  days: number[],
  start: string,
  end: string,
  holidays: string[] = [],
): BusinessCalendar {
  return new BusinessCalendar({
    timezone,
    intervals: days.map((day) => ({ day, start, end })),
    holidays,
  });
}

/** Mon-Fri 09:00-17:00 UTC. */
const office = (holidays: string[] = []): BusinessCalendar =>
  cal('UTC', WEEKDAYS, '09:00', '17:00', holidays);

describe('weekends', () => {
  it('skips the weekend after Friday close', () => {
    // Fri 16:00 + 120 min: 60 until 17:00, 60 more on Mon 09:00 -> Mon 10:00
    expect(iso(office().addBusinessMinutes(at('2026-01-09T16:00:00Z'), 120))).toBe(
      '2026-01-12T10:00:00.000Z',
    );
  });

  it('starts a weekend request on Monday morning', () => {
    // Sat 12:00 + 0 -> Mon 09:00; Sun 12:00 + 30 -> Mon 09:30
    expect(iso(office().addBusinessMinutes(at('2026-01-10T12:00:00Z'), 0))).toBe(
      '2026-01-12T09:00:00.000Z',
    );
    expect(iso(office().addBusinessMinutes(at('2026-01-11T12:00:00Z'), 30))).toBe(
      '2026-01-12T09:30:00.000Z',
    );
  });

  it('returns the closing instant when minutes end exactly at close', () => {
    // Fri 16:00 + 60 -> Fri 17:00
    expect(iso(office().addBusinessMinutes(at('2026-01-09T16:00:00Z'), 60))).toBe(
      '2026-01-09T17:00:00.000Z',
    );
  });
});

describe('holidays', () => {
  it('skips a single mid-week holiday', () => {
    // Wed Jan 14 closed: Tue 16:00 + 120 -> Tue 17:00 (60) then Thu 09:00 + 60 -> Thu 10:00
    const c = office(['2026-01-14']);
    expect(iso(c.addBusinessMinutes(at('2026-01-13T16:00:00Z'), 120))).toBe(
      '2026-01-15T10:00:00.000Z',
    );
  });

  it('skips consecutive holidays', () => {
    // Mon+Tue closed: Fri 16:00 + 120 -> Wed 10:00
    const c = office(['2026-01-12', '2026-01-13']);
    expect(iso(c.addBusinessMinutes(at('2026-01-09T16:00:00Z'), 120))).toBe(
      '2026-01-14T10:00:00.000Z',
    );
  });

  it('skips a Monday holiday after the weekend', () => {
    // Mon Jan 12 closed: Fri 16:00 + 120 -> Tue 10:00
    const c = office(['2026-01-12']);
    expect(iso(c.addBusinessMinutes(at('2026-01-09T16:00:00Z'), 120))).toBe(
      '2026-01-13T10:00:00.000Z',
    );
    expect(iso(c.nextBusinessOpen(at('2026-01-10T08:00:00Z')))).toBe('2026-01-13T09:00:00.000Z');
  });

  it('treats a start on a holiday as closed', () => {
    const c = office(['2026-01-12']);
    expect(c.isWithinBusinessHours(at('2026-01-12T10:00:00Z'))).toBe(false);
    // Mon holiday 10:00 + 60 -> Tue 10:00
    expect(iso(c.addBusinessMinutes(at('2026-01-12T10:00:00Z'), 60))).toBe(
      '2026-01-13T10:00:00.000Z',
    );
  });

  it('uses the tenant local date for holidays', () => {
    // Asia/Kolkata +05:30: Mon Jan 12 09:00-17:00 local = 03:30Z-11:30Z, holiday closes it.
    const c = cal('Asia/Kolkata', WEEKDAYS, '09:00', '17:00', ['2026-01-12']);
    expect(c.isWithinBusinessHours(at('2026-01-12T04:00:00Z'))).toBe(false);
    expect(c.isWithinBusinessHours(at('2026-01-13T04:00:00Z'))).toBe(true);
  });
});

describe('daylight saving (America/New_York)', () => {
  const ny = cal('America/New_York', ALL_DAYS, '00:00', '06:00');

  it('spring forward: 00:00-06:00 is 300 real minutes', () => {
    // Sun Mar 8 2026: 00:00 EST = 05:00Z, 06:00 EDT = 10:00Z
    expect(ny.businessMinutesBetween(at('2026-03-08T05:00:00Z'), at('2026-03-08T10:00:00Z'))).toBe(
      300,
    );
  });

  it('fall back: 00:00-06:00 is 420 real minutes', () => {
    // Sun Nov 1 2026: 00:00 EDT = 04:00Z, 06:00 EST = 11:00Z
    expect(ny.businessMinutesBetween(at('2026-11-01T04:00:00Z'), at('2026-11-01T11:00:00Z'))).toBe(
      420,
    );
  });

  it('adds minutes across the spring-forward boundary', () => {
    // 300 min from 00:00 EST reaches 06:00 EDT (10:00Z); 301 lands 1 min into Mon 00:00 EDT (04:00Z)
    expect(iso(ny.addBusinessMinutes(at('2026-03-08T05:00:00Z'), 300))).toBe(
      '2026-03-08T10:00:00.000Z',
    );
    expect(iso(ny.addBusinessMinutes(at('2026-03-08T05:00:00Z'), 301))).toBe(
      '2026-03-09T04:01:00.000Z',
    );
  });

  it('adds minutes across the fall-back boundary', () => {
    // 420 min from 00:00 EDT reaches 06:00 EST (11:00Z); 421 lands 1 min into Mon 00:00 EST (05:00Z)
    expect(iso(ny.addBusinessMinutes(at('2026-11-01T04:00:00Z'), 420))).toBe(
      '2026-11-01T11:00:00.000Z',
    );
    expect(iso(ny.addBusinessMinutes(at('2026-11-01T04:00:00Z'), 421))).toBe(
      '2026-11-02T05:01:00.000Z',
    );
  });

  it('counts a 01:00-03:00 window on spring-forward day as 60 minutes', () => {
    const c = cal('America/New_York', [7], '01:00', '03:00');
    // Sun Mar 8: 01:00 EST = 06:00Z, 03:00 EDT = 07:00Z
    expect(c.businessMinutesBetween(at('2026-03-08T00:00:00Z'), at('2026-03-09T00:00:00Z'))).toBe(
      60,
    );
  });

  it('does not throw when an interval starts in the nonexistent hour', () => {
    const c = cal('America/New_York', ALL_DAYS, '02:00', '04:00');
    // Mar 8: 02:00 does not exist, Luxon moves it to 03:00 EDT (07:00Z); end 04:00 EDT = 08:00Z
    const next = c.nextBusinessOpen(at('2026-03-08T06:30:00Z')); // 01:30 EST
    expect(iso(next)).toBe('2026-03-08T07:00:00.000Z');
    expect(c.businessMinutesBetween(at('2026-03-08T06:30:00Z'), at('2026-03-08T12:00:00Z'))).toBe(
      60,
    );
    expect(() => c.addBusinessMinutes(at('2026-03-08T06:30:00Z'), 30)).not.toThrow();
  });

  it('spans DST in businessMinutesBetween', () => {
    // Sat Mar 7 00:00 EST (05:00Z) to Mon Mar 9 00:00 EDT (04:00Z): 360 + 300 = 660
    expect(ny.businessMinutesBetween(at('2026-03-07T05:00:00Z'), at('2026-03-09T04:00:00Z'))).toBe(
      660,
    );
  });
});

describe('half-hour zones', () => {
  it('Asia/Kolkata (+05:30) edges and rollover', () => {
    const c = cal('Asia/Kolkata', WEEKDAYS, '09:00', '17:00');
    // 09:00-17:00 IST = 03:30Z-11:30Z
    expect(c.isWithinBusinessHours(at('2026-01-05T03:29:00Z'))).toBe(false);
    expect(c.isWithinBusinessHours(at('2026-01-05T03:30:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-05T11:29:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-05T11:30:00Z'))).toBe(false);
    // Fri 16:30 IST (11:00Z) + 60: 30 to close, 30 on Mon 09:00 IST (03:30Z) -> Mon 09:30 IST (04:00Z)
    expect(iso(c.addBusinessMinutes(at('2026-01-09T11:00:00Z'), 60))).toBe(
      '2026-01-12T04:00:00.000Z',
    );
  });

  it('Australia/Lord_Howe: 30 minute DST shift', () => {
    const c = cal('Australia/Lord_Howe', ALL_DAYS, '00:00', '06:00');
    // Oct 4 2026 DST starts at 02:00 (+10:30 -> +11): 00:00 = Oct 3 13:30Z, 06:00 = Oct 3 19:00Z -> 330
    expect(c.businessMinutesBetween(at('2026-10-03T13:30:00Z'), at('2026-10-03T19:00:00Z'))).toBe(
      330,
    );
    // Apr 5 2026 DST ends at 02:00 (+11 -> +10:30): 00:00 = Apr 4 13:00Z, 06:00 = Apr 4 19:30Z -> 390
    expect(c.businessMinutesBetween(at('2026-04-04T13:00:00Z'), at('2026-04-04T19:30:00Z'))).toBe(
      390,
    );
  });
});

describe('intervals crossing midnight', () => {
  const nights = (holidays: string[] = []): BusinessCalendar =>
    cal('UTC', WEEKDAYS, '22:00', '02:00', holidays);

  it('continues past midnight into the next day', () => {
    const c = nights();
    // Mon Jan 5 22:00-Tue 02:00
    expect(c.isWithinBusinessHours(at('2026-01-05T21:59:00Z'))).toBe(false);
    expect(c.isWithinBusinessHours(at('2026-01-05T22:00:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-06T01:59:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-06T02:00:00Z'))).toBe(false);
    // Mon 23:00 + 120 -> Tue 01:00; + 180 -> Tue 02:00 (close)
    expect(iso(c.addBusinessMinutes(at('2026-01-05T23:00:00Z'), 120))).toBe(
      '2026-01-06T01:00:00.000Z',
    );
    expect(iso(c.addBusinessMinutes(at('2026-01-05T23:00:00Z'), 180))).toBe(
      '2026-01-06T02:00:00.000Z',
    );
    // + 240: 180 to close, 60 more on Tue 22:00 -> Tue 23:00
    expect(iso(c.addBusinessMinutes(at('2026-01-05T23:00:00Z'), 240))).toBe(
      '2026-01-06T23:00:00.000Z',
    );
  });

  it('spills Friday night into Saturday', () => {
    const c = nights();
    // Fri Jan 9 23:00 + 180 -> Sat 02:00; + 181 -> Mon Jan 12 22:01
    expect(iso(c.addBusinessMinutes(at('2026-01-09T23:00:00Z'), 180))).toBe(
      '2026-01-10T02:00:00.000Z',
    );
    expect(iso(c.addBusinessMinutes(at('2026-01-09T23:00:00Z'), 181))).toBe(
      '2026-01-12T22:01:00.000Z',
    );
    expect(c.isWithinBusinessHours(at('2026-01-10T01:00:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-10T03:00:00Z'))).toBe(false);
  });

  it('a holiday on the starting date closes the interval and its spill', () => {
    const c = nights(['2026-01-05']); // Mon holiday
    expect(c.isWithinBusinessHours(at('2026-01-05T23:00:00Z'))).toBe(false);
    expect(c.isWithinBusinessHours(at('2026-01-06T01:00:00Z'))).toBe(false);
    // Next open is Tue 22:00
    expect(iso(c.nextBusinessOpen(at('2026-01-05T23:00:00Z')))).toBe('2026-01-06T22:00:00.000Z');
  });

  it('a holiday on the next date keeps the previous night spill but closes its own interval', () => {
    const c = nights(['2026-01-06']); // Tue holiday
    expect(c.isWithinBusinessHours(at('2026-01-06T01:00:00Z'))).toBe(true); // Mon spill
    expect(c.isWithinBusinessHours(at('2026-01-06T22:30:00Z'))).toBe(false); // Tue own interval
    // Tue 01:30 + 60: 30 left, then Wed 22:00 + 30 -> Wed 22:30
    expect(iso(c.addBusinessMinutes(at('2026-01-06T01:30:00Z'), 60))).toBe(
      '2026-01-07T22:30:00.000Z',
    );
  });

  it('treats 18:00-00:00 as ending at midnight and 09:00-24:00 as open until the day end', () => {
    const evening = cal('UTC', WEEKDAYS, '18:00', '00:00');
    expect(evening.isWithinBusinessHours(at('2026-01-05T23:59:00Z'))).toBe(true);
    expect(evening.isWithinBusinessHours(at('2026-01-06T00:00:00Z'))).toBe(false);
    const late = cal('UTC', WEEKDAYS, '09:00', '24:00');
    expect(late.isWithinBusinessHours(at('2026-01-09T23:59:00Z'))).toBe(true);
    expect(late.isWithinBusinessHours(at('2026-01-10T00:00:00Z'))).toBe(false);
  });
});

describe('multiple and merged intervals', () => {
  const lunch = new BusinessCalendar({
    timezone: 'UTC',
    intervals: WEEKDAYS.flatMap((day) => [
      { day, start: '09:00', end: '12:00' },
      { day, start: '13:00', end: '17:00' },
    ]),
  });

  it('skips the lunch break', () => {
    // Mon 11:00 + 120: 60 until 12:00, 60 after 13:00 -> 14:00
    expect(iso(lunch.addBusinessMinutes(at('2026-01-05T11:00:00Z'), 120))).toBe(
      '2026-01-05T14:00:00.000Z',
    );
    // Mon 12:30 + 0 -> 13:00
    expect(iso(lunch.addBusinessMinutes(at('2026-01-05T12:30:00Z'), 0))).toBe(
      '2026-01-05T13:00:00.000Z',
    );
    expect(lunch.isWithinBusinessHours(at('2026-01-05T12:00:00Z'))).toBe(false);
    expect(lunch.isWithinBusinessHours(at('2026-01-05T13:00:00Z'))).toBe(true);
    expect(
      lunch.businessMinutesBetween(at('2026-01-05T09:00:00Z'), at('2026-01-05T17:00:00Z')),
    ).toBe(420);
  });

  it('merges overlapping intervals so nothing is counted twice', () => {
    const c = new BusinessCalendar({
      timezone: 'UTC',
      intervals: [
        { day: 1, start: '09:00', end: '13:00' },
        { day: 1, start: '12:00', end: '17:00' },
      ],
    });
    expect(c.businessMinutesBetween(at('2026-01-05T00:00:00Z'), at('2026-01-06T00:00:00Z'))).toBe(
      480,
    );
  });

  it('merges adjacent intervals', () => {
    const c = new BusinessCalendar({
      timezone: 'UTC',
      intervals: [
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '12:00', end: '17:00' },
      ],
    });
    expect(iso(c.addBusinessMinutes(at('2026-01-05T09:00:00Z'), 480))).toBe(
      '2026-01-05T17:00:00.000Z',
    );
  });

  it('merges a midnight spill with the next day interval', () => {
    const c = new BusinessCalendar({
      timezone: 'UTC',
      intervals: [
        { day: 1, start: '20:00', end: '02:00' },
        { day: 2, start: '00:00', end: '04:00' },
      ],
    });
    // Mon 20:00 -> Tue 04:00 = 480, not 600
    expect(c.businessMinutesBetween(at('2026-01-05T20:00:00Z'), at('2026-01-06T04:00:00Z'))).toBe(
      480,
    );
    expect(c.isWithinBusinessHours(at('2026-01-06T03:59:00Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-06T04:00:00Z'))).toBe(false);
  });
});

describe('boundaries and starts', () => {
  const c = office();

  it('moves a start before opening to opening time', () => {
    // Mon 07:00 + 30 -> 09:30
    expect(iso(c.addBusinessMinutes(at('2026-01-05T07:00:00Z'), 30))).toBe(
      '2026-01-05T09:30:00.000Z',
    );
  });

  it('moves a start after closing to the next morning', () => {
    // Mon 18:00 + 30 -> Tue 09:30
    expect(iso(c.addBusinessMinutes(at('2026-01-05T18:00:00Z'), 30))).toBe(
      '2026-01-06T09:30:00.000Z',
    );
  });

  it('starting exactly at close behaves as closed', () => {
    // Mon 17:00 + 30 -> Tue 09:30
    expect(iso(c.addBusinessMinutes(at('2026-01-05T17:00:00Z'), 30))).toBe(
      '2026-01-06T09:30:00.000Z',
    );
  });

  it('starting exactly at open counts from open', () => {
    expect(iso(c.addBusinessMinutes(at('2026-01-05T09:00:00Z'), 60))).toBe(
      '2026-01-05T10:00:00.000Z',
    );
  });

  it('0 minutes returns from when open, else next open', () => {
    expect(iso(c.addBusinessMinutes(at('2026-01-05T10:15:00Z'), 0))).toBe(
      '2026-01-05T10:15:00.000Z',
    );
    expect(iso(c.addBusinessMinutes(at('2026-01-05T20:00:00Z'), 0))).toBe(
      '2026-01-06T09:00:00.000Z',
    );
  });

  it('supports fractional minutes', () => {
    expect(iso(c.addBusinessMinutes(at('2026-01-05T09:00:00Z'), 0.5))).toBe(
      '2026-01-05T09:00:30.000Z',
    );
  });

  it('accepts Luxon DateTime inputs', () => {
    const dt = DateTime.fromISO('2026-01-05T09:00:00Z', { setZone: true });
    expect(iso(c.addBusinessMinutes(dt, 60))).toBe('2026-01-05T10:00:00.000Z');
    expect(c.isWithinBusinessHours(dt)).toBe(true);
  });
});

describe('isWithinBusinessHours', () => {
  const c = office();

  it('is start inclusive and end exclusive', () => {
    expect(c.isWithinBusinessHours(at('2026-01-05T08:59:59.999Z'))).toBe(false);
    expect(c.isWithinBusinessHours(at('2026-01-05T09:00:00.000Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-05T16:59:59.999Z'))).toBe(true);
    expect(c.isWithinBusinessHours(at('2026-01-05T17:00:00.000Z'))).toBe(false);
  });

  it('is false on weekends', () => {
    expect(c.isWithinBusinessHours(at('2026-01-10T12:00:00Z'))).toBe(false);
  });
});

describe('nextBusinessOpen', () => {
  const c = office();

  it('returns the instant itself when open', () => {
    expect(iso(c.nextBusinessOpen(at('2026-01-05T10:00:00Z')))).toBe('2026-01-05T10:00:00.000Z');
    expect(iso(c.nextBusinessOpen(at('2026-01-05T09:00:00Z')))).toBe('2026-01-05T09:00:00.000Z');
  });

  it('finds the next opening', () => {
    expect(iso(c.nextBusinessOpen(at('2026-01-05T17:00:00Z')))).toBe('2026-01-06T09:00:00.000Z');
    expect(iso(c.nextBusinessOpen(at('2026-01-09T18:00:00Z')))).toBe('2026-01-12T09:00:00.000Z');
    expect(iso(c.nextBusinessOpen(at('2026-01-05T03:00:00Z')))).toBe('2026-01-05T09:00:00.000Z');
  });
});

describe('businessMinutesBetween', () => {
  const c = office();

  it('counts within a day', () => {
    expect(c.businessMinutesBetween(at('2026-01-05T10:00:00Z'), at('2026-01-05T12:30:00Z'))).toBe(
      150,
    );
  });

  it('can be fractional', () => {
    expect(
      c.businessMinutesBetween(at('2026-01-05T09:00:00.000Z'), at('2026-01-05T09:00:30.000Z')),
    ).toBeCloseTo(0.5, 10);
  });

  it('returns 0 when reversed or equal', () => {
    expect(c.businessMinutesBetween(at('2026-01-05T12:00:00Z'), at('2026-01-05T10:00:00Z'))).toBe(
      0,
    );
    expect(c.businessMinutesBetween(at('2026-01-05T12:00:00Z'), at('2026-01-05T12:00:00Z'))).toBe(
      0,
    );
  });

  it('returns 0 entirely outside hours', () => {
    expect(c.businessMinutesBetween(at('2026-01-09T18:00:00Z'), at('2026-01-12T08:00:00Z'))).toBe(
      0,
    );
  });

  it('spans a weekend', () => {
    // Fri 09:00 -> Mon 09:00 = one day
    expect(c.businessMinutesBetween(at('2026-01-09T09:00:00Z'), at('2026-01-12T09:00:00Z'))).toBe(
      480,
    );
  });

  it('spans a holiday', () => {
    const h = office(['2026-01-12']);
    // Fri 09:00 -> Tue 10:00 with Monday closed = 480 + 60
    expect(h.businessMinutesBetween(at('2026-01-09T09:00:00Z'), at('2026-01-13T10:00:00Z'))).toBe(
      540,
    );
  });

  it('round trips with addBusinessMinutes', () => {
    const variants = [
      office(['2026-01-12']),
      cal('UTC', WEEKDAYS, '22:00', '02:00'),
      cal('America/New_York', ALL_DAYS, '00:00', '06:00'),
      cal('Asia/Kolkata', WEEKDAYS, '09:00', '17:00'),
    ];
    const amounts = [0, 1, 59, 60, 61, 239, 240, 479, 480, 481, 959, 1000, 2400, 4999, 12345];
    for (const calendar of variants) {
      const from = calendar.nextBusinessOpen(at('2026-03-06T10:17:00Z'));
      for (const n of amounts) {
        const end = calendar.addBusinessMinutes(from, n);
        expect(
          calendar.businessMinutesBetween(from, end),
          `${calendar.timezone} n=${n}`,
        ).toBeCloseTo(n, 6);
      }
    }
  });
});

describe('large additions', () => {
  it('100000 minutes terminates quickly with the exact result', () => {
    const t0 = performance.now();
    const end = office().addBusinessMinutes(at('2026-01-05T09:00:00Z'), 100_000);
    const elapsed = performance.now() - t0;
    // 208 full days (99840 min) + 160 min, on the 209th business day: Thu Oct 22 09:00 + 160 -> 11:40
    expect(iso(end)).toBe('2026-10-22T11:40:00.000Z');
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('twentyFourSeven', () => {
  it('is always open and adds clock time', () => {
    const c = twentyFourSeven();
    expect(c.timezone).toBe('UTC');
    expect(c.isWithinBusinessHours(at('2026-01-10T03:00:00Z'))).toBe(true);
    expect(iso(c.nextBusinessOpen(at('2026-01-10T03:00:00Z')))).toBe('2026-01-10T03:00:00.000Z');
    expect(iso(c.addBusinessMinutes(at('2026-01-09T23:00:00Z'), 1000))).toBe(
      '2026-01-10T15:40:00.000Z',
    );
    expect(c.businessMinutesBetween(at('2026-01-09T23:00:00Z'), at('2026-01-10T15:40:00Z'))).toBe(
      1000,
    );
  });

  it('keeps a given timezone', () => {
    expect(twentyFourSeven('America/New_York').timezone).toBe('America/New_York');
  });
});

describe('errors', () => {
  it('throws BusinessCalendarError when holidays close every open day in the horizon', () => {
    // Monday only, with every Monday for more than the scan horizon a holiday (max 1000 holidays)
    const holidays: string[] = [];
    let d = DateTime.fromISO('2025-12-29', { zone: 'UTC' }); // a Monday
    for (let i = 0; i < 560; i++) {
      holidays.push(d.toISODate()!);
      d = d.plus({ days: 7 });
    }
    expect(560 * 7).toBeGreaterThan(MAX_SCAN_DAYS);
    const c = cal('UTC', [1], '09:00', '17:00', holidays);
    expect(c.isWithinBusinessHours(at('2026-01-12T10:00:00Z'))).toBe(false);
    expect(() => c.nextBusinessOpen(at('2026-01-05T10:00:00Z'))).toThrow(BusinessCalendarError);
    expect(() => c.addBusinessMinutes(at('2026-01-05T10:00:00Z'), 10)).toThrow(
      BusinessCalendarError,
    );
    expect(() => c.addBusinessMinutes(at('2026-01-05T10:00:00Z'), 0)).toThrow(
      BusinessCalendarError,
    );
  });

  it('rejects negative and non-finite minutes with RangeError', () => {
    const c = office();
    const from = at('2026-01-05T10:00:00Z');
    expect(() => c.addBusinessMinutes(from, -1)).toThrow(RangeError);
    expect(() => c.addBusinessMinutes(from, Number.NaN)).toThrow(RangeError);
    expect(() => c.addBusinessMinutes(from, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects invalid dates with RangeError', () => {
    const c = office();
    expect(() => c.isWithinBusinessHours(new Date('nope'))).toThrow(RangeError);
    expect(() => c.nextBusinessOpen(new Date('nope'))).toThrow(RangeError);
  });
});

describe('config validation', () => {
  const base = {
    timezone: 'UTC',
    intervals: [{ day: 1, start: '09:00', end: '17:00' }],
    holidays: [],
  };
  const make = (over: Record<string, unknown>) => () => new BusinessCalendar({ ...base, ...over });

  it('accepts a valid config and defaults holidays', () => {
    expect(make({})).not.toThrow();
    expect(
      () => new BusinessCalendar({ timezone: 'UTC', intervals: base.intervals }),
    ).not.toThrow();
  });

  it('rejects an unknown timezone', () => {
    expect(make({ timezone: 'Mars/Phobos' })).toThrow();
    expect(make({ timezone: '' })).toThrow();
  });

  it.each(['9:00', '24:00', '25:00', '09:60', '0900', 'ab:cd'])(
    'rejects bad start time %s',
    (start) => {
      expect(make({ intervals: [{ day: 1, start, end: '17:00' }] })).toThrow();
    },
  );

  it.each(['9:00', '24:01', '25:00', '09:60', 'noon'])('rejects bad end time %s', (end) => {
    expect(make({ intervals: [{ day: 1, start: '09:00', end }] })).toThrow();
  });

  it('rejects start equal to end', () => {
    expect(make({ intervals: [{ day: 1, start: '09:00', end: '09:00' }] })).toThrow();
    expect(make({ intervals: [{ day: 1, start: '00:00', end: '00:00' }] })).toThrow();
  });

  it('accepts 24:00 as an end', () => {
    expect(make({ intervals: [{ day: 1, start: '00:00', end: '24:00' }] })).not.toThrow();
  });

  it.each([0, 8, 1.5, -1])('rejects bad weekday %s', (day) => {
    expect(make({ intervals: [{ day, start: '09:00', end: '17:00' }] })).toThrow();
  });

  it.each([
    '2026-02-30',
    '2026-2-3',
    '2026-13-01',
    '01/02/2026',
    'holiday',
    '2026-01-05T00:00:00Z',
  ])('rejects bad holiday date %s', (holiday) => {
    expect(make({ holidays: [holiday] })).toThrow();
  });

  it('rejects empty intervals and unknown keys', () => {
    expect(make({ intervals: [] })).toThrow();
    expect(make({ extra: true })).toThrow();
    expect(make({ intervals: [{ day: 1, start: '09:00', end: '17:00', extra: 1 }] })).toThrow();
  });
});
