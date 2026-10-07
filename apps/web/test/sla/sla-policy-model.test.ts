import { describe, expect, it } from 'vitest';

import {
  buildSlaConditions,
  emptySlaPolicyForm,
  formToSlaPolicyBody,
  parseSlaConditions,
  positionChanges,
  slaIssuesFromApi,
  slaPolicyToBody,
  slaPolicyToForm,
  summarizeSlaConditions,
  summarizeTargets,
  validateSlaPolicyForm,
  type SlaPolicyRecord,
} from '../../src/components/builders/sla-policy-model';

import type { ConditionGroup } from '../../src/api/generated/model';

const ALL_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const calendars = [{ id: 'cal-1', name: 'Office' }];

function record(overrides: Partial<SlaPolicyRecord> = {}): SlaPolicyRecord {
  return {
    id: 'p1',
    name: 'Urgent',
    position: 0,
    conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['urgent'] }] },
    businessHoursId: 'cal-1',
    firstResponseMinutes: 60,
    nextResponseMinutes: null,
    resolutionMinutes: 1440,
    warningPercent: 80,
    ...overrides,
  };
}

describe('conditions', () => {
  it('"every ticket" is sent as priority is any of the four and read back as no condition', () => {
    const tree = buildSlaConditions({ operator: 'is', values: [] }, { operator: 'is', values: [] });
    expect(tree).toEqual({ op: 'and', items: [{ field: 'priority', operator: 'is', value: ALL_PRIORITIES }] });
    expect(parseSlaConditions(tree)).toEqual({ supported: true, priority: { operator: 'is', values: [] }, group: { operator: 'is', values: [] } });
    expect(summarizeSlaConditions(tree, new Map())).toBe('Every ticket');
  });

  it('round-trips priority and group clauses', () => {
    const priority = { operator: 'is_not' as const, values: ['low'] };
    const group = { operator: 'is' as const, values: ['g1', 'ungrouped'] };
    const tree = buildSlaConditions(priority, group);
    expect(tree).toEqual({
      op: 'and',
      items: [
        { field: 'priority', operator: 'is_not', value: ['low'] },
        { field: 'group', operator: 'is', value: ['g1', 'ungrouped'] },
      ],
    });
    expect(parseSlaConditions(tree)).toEqual({ supported: true, priority, group });
    expect(summarizeSlaConditions(tree, new Map([['g1', 'Billing']]))).toBe('Priority is not Low, Group is Billing or Ungrouped');
  });

  it('accepts a single string value and names a deleted group', () => {
    const tree: ConditionGroup = { op: 'and', items: [{ field: 'group', operator: 'is', value: 'gone' }] };
    expect(parseSlaConditions(tree)).toMatchObject({ supported: true, group: { values: ['gone'] } });
    expect(summarizeSlaConditions(tree, new Map())).toBe('Group is a deleted group');
  });

  it.each<[string, ConditionGroup]>([
    ['an or group', { op: 'or', items: [{ field: 'priority', operator: 'is', value: ['low'] }] }],
    ['a nested group', { op: 'and', items: [{ op: 'or', items: [] }] }],
    ['another operator', { op: 'and', items: [{ field: 'priority', operator: 'contains', value: ['low'] }] }],
    ['another field', { op: 'and', items: [{ field: 'tags', operator: 'is', value: ['x'] }] }],
    [
      'a repeated field',
      {
        op: 'and',
        items: [
          { field: 'priority', operator: 'is', value: ['low'] },
          { field: 'priority', operator: 'is', value: ['high'] },
        ],
      },
    ],
  ])('does not claim to support %s, and sends it back unchanged', (_name, tree) => {
    expect(parseSlaConditions(tree)).toEqual({ supported: false });
    expect(summarizeSlaConditions(tree, new Map())).toBe('Custom conditions');
    const form = slaPolicyToForm(record({ conditions: tree }));
    expect(form.foreignConditions).toEqual(tree);
    expect(formToSlaPolicyBody(form).conditions).toEqual(tree);
  });
});

describe('form <-> record', () => {
  it('blank targets become null and filled ones numbers', () => {
    const form = { ...emptySlaPolicyForm('cal-1'), name: '  Urgent  ', firstResponseMinutes: ' 30 ', nextResponseMinutes: '', resolutionMinutes: '' };
    expect(formToSlaPolicyBody(form)).toEqual({
      name: 'Urgent',
      conditions: buildSlaConditions({ operator: 'is', values: [] }, { operator: 'is', values: [] }),
      businessHoursId: 'cal-1',
      firstResponseMinutes: 30,
      nextResponseMinutes: null,
      resolutionMinutes: null,
      warningPercent: 80,
    });
  });

  it('shows stored targets as text and keeps the position out of an edit body', () => {
    const form = slaPolicyToForm(record());
    expect(form).toMatchObject({ firstResponseMinutes: '60', nextResponseMinutes: '', resolutionMinutes: '1440', warningPercent: '80' });
    expect(formToSlaPolicyBody(form)).not.toHaveProperty('position');
    expect(slaPolicyToBody(record(), 3)).toMatchObject({ position: 3, name: 'Urgent' });
  });

  it('summarizes targets', () => {
    expect(summarizeTargets(record())).toBe('First response 1h, Resolution 1d');
    expect(summarizeTargets(record({ firstResponseMinutes: null, resolutionMinutes: null }))).toBe('No targets');
  });
});

describe('positionChanges', () => {
  it('writes 0..n-1 only where the stored position differs', () => {
    const a = record({ id: 'a', position: 0 });
    const b = record({ id: 'b', position: 1 });
    const c = record({ id: 'c', position: 2 });
    expect(positionChanges([b, a, c]).map((change) => [change.policy.id, change.position])).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
    expect(positionChanges([a, b, c])).toEqual([]);
  });

  it('repairs gaps and duplicates in stored positions', () => {
    const a = record({ id: 'a', position: 0 });
    const b = record({ id: 'b', position: 0 });
    const c = record({ id: 'c', position: 7 });
    expect(positionChanges([a, b, c]).map((change) => [change.policy.id, change.position])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
  });
});

describe('validateSlaPolicyForm', () => {
  const valid = { ...emptySlaPolicyForm('cal-1'), name: 'Urgent' };

  it('accepts a minimal form', () => {
    expect(validateSlaPolicyForm(valid, calendars)).toEqual({});
  });

  it('needs a name of at most 80 characters', () => {
    expect(validateSlaPolicyForm({ ...valid, name: '  ' }, calendars)['name']).toBe('Enter a name.');
    expect(validateSlaPolicyForm({ ...valid, name: 'x'.repeat(81) }, calendars)['name']).toMatch(/80 characters/);
    expect(validateSlaPolicyForm({ ...valid, name: 'x'.repeat(80) }, calendars)['name']).toBeUndefined();
  });

  it('needs a calendar that exists', () => {
    expect(validateSlaPolicyForm({ ...valid, businessHoursId: '' }, calendars)['businessHoursId']).toBe('Choose a business-hours calendar.');
    expect(validateSlaPolicyForm({ ...valid, businessHoursId: 'gone' }, calendars)['businessHoursId']).toMatch(/no longer exists/);
  });

  it.each(['0', '-5', '1.5', 'abc', '525601'])('rejects the target %s', (text) => {
    expect(validateSlaPolicyForm({ ...valid, firstResponseMinutes: text }, calendars)['firstResponseMinutes']).toMatch(/whole number of minutes from 1 to 525,600/);
  });

  it.each(['1', '525600', ''])('accepts the target %j', (text) => {
    expect(validateSlaPolicyForm({ ...valid, resolutionMinutes: text }, calendars)['resolutionMinutes']).toBeUndefined();
  });

  it.each([
    ['49', true],
    ['50', false],
    ['99', false],
    ['100', true],
    ['', true],
    ['80.5', true],
  ])('warning percent %j invalid=%s', (text, invalid) => {
    const found = validateSlaPolicyForm({ ...valid, warningPercent: text }, calendars)['warningPercent'];
    expect(found !== undefined).toBe(invalid);
    if (invalid) expect(found).toBe('Enter a whole number from 50 to 99.');
  });
});

describe('slaIssuesFromApi', () => {
  it('folds condition paths onto "conditions" and words the common issues', () => {
    expect(
      slaIssuesFromApi({ 'conditions.items.0.value': 'invalid_value', name: 'too_long', warningPercent: 'too_small', firstResponseMinutes: 'too_big' }),
    ).toEqual({
      conditions: 'A condition names a group that no longer exists, or one this editor cannot use.',
      name: 'This is too long.',
      warningPercent: 'This value is too small.',
      firstResponseMinutes: 'This value is too large.',
    });
  });

  it('falls back to a readable sentence for an unknown issue code', () => {
    expect(slaIssuesFromApi({ businessHoursId: 'not_found' })).toEqual({ businessHoursId: 'Not found.' });
  });
});
