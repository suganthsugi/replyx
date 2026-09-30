import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DURATION,
  FIELD_ORDER,
  availableFields,
  countConditions,
  defaultConditions,
  defaultOperator,
  defaultValue,
  describeCondition,
  errorPath,
  formatDuration,
  fromLocalInput,
  isConditionComplete,
  isGroup,
  isTreeComplete,
  newCondition,
  nextUnusedField,
  nodeAt,
  operatorsFor,
  parseDuration,
  pathKey,
  removeAt,
  replaceAt,
  toLocalInput,
  valueList,
  withOperator,
} from '../../src/components/builders/filter-model';

import type { Condition, ConditionGroup } from '../../src/api/generated/model';

describe('filter-model defaults', () => {
  it('pre-fills a new view with "State is not Closed"', () => {
    expect(defaultConditions()).toEqual({ op: 'and', items: [{ field: 'state', operator: 'is_not', value: ['closed'] }] });
  });

  it('builds a new condition with the field default operator and an empty or default value', () => {
    expect(newCondition('state')).toEqual({ field: 'state', operator: 'is', value: [] });
    expect(newCondition('tags')).toEqual({ field: 'tags', operator: 'contains', value: [] });
    expect(newCondition('created_at')).toEqual({ field: 'created_at', operator: 'within_last', value: DEFAULT_DURATION });
    expect(newCondition('sla_status')).toEqual({ field: 'sla_status', operator: 'is', value: '' });
    expect(defaultOperator('pending_until')).toBe('within_last');
    expect(defaultValue('updated_at', 'before')).toBe('now');
  });

  it('offers Customer only when customer search is wired or a condition already uses it', () => {
    expect(availableFields({})).not.toContain('customer');
    expect(availableFields({ onCustomerSearch: () => undefined })).toEqual(FIELD_ORDER);
    expect(availableFields({}, 'customer')).toContain('customer');
  });

  it('lists the offered operators and keeps an existing API-valid one', () => {
    expect(operatorsFor('state')).toEqual(['is', 'is_not']);
    expect(operatorsFor('tags')).toEqual(['contains', 'is_not']);
    expect(operatorsFor('tags', 'is')).toEqual(['contains', 'is_not', 'is']);
    expect(operatorsFor('sla_status', 'before')).toEqual(['is', 'is_not', 'before']);
    // An operator the API does not accept for the field is never added.
    expect(operatorsFor('state', 'before')).toEqual(['is', 'is_not']);
  });

  it('resets the value only when a date operator changes the value shape', () => {
    const relative: Condition = { field: 'created_at', operator: 'within_last', value: 'P3D' };
    expect(withOperator(relative, 'before')).toEqual({ field: 'created_at', operator: 'before', value: 'now' });
    const absolute: Condition = { field: 'created_at', operator: 'before', value: '2026-01-01T00:00:00.000Z' };
    expect(withOperator(absolute, 'after')).toEqual({ ...absolute, operator: 'after' });
    expect(withOperator(absolute, 'within_last').value).toBe(DEFAULT_DURATION);
    const state: Condition = { field: 'state', operator: 'is', value: ['open'] };
    expect(withOperator(state, 'is_not')).toEqual({ field: 'state', operator: 'is_not', value: ['open'] });
  });
});

describe('filter-model durations and dates', () => {
  it('formats durations per unit', () => {
    expect(formatDuration(30, 'minutes')).toBe('PT30M');
    expect(formatDuration(2, 'hours')).toBe('PT2H');
    expect(formatDuration(3, 'days')).toBe('P3D');
    expect(formatDuration(1, 'weeks')).toBe('P1W');
  });

  it('parses durations into the largest whole unit', () => {
    expect(parseDuration('PT30M')).toEqual({ amount: 30, unit: 'minutes' });
    expect(parseDuration('PT120M')).toEqual({ amount: 2, unit: 'hours' });
    expect(parseDuration('P3D')).toEqual({ amount: 3, unit: 'days' });
    expect(parseDuration('P14D')).toEqual({ amount: 2, unit: 'weeks' });
    expect(parseDuration('P1DT12H')).toEqual({ amount: 36, unit: 'hours' });
    expect(parseDuration('PT90M')).toEqual({ amount: 90, unit: 'minutes' });
  });

  it('parses a zero duration as amount 0 in its own unit and rejects garbage', () => {
    expect(parseDuration('P0D')).toEqual({ amount: 0, unit: 'days' });
    expect(parseDuration('P0W')).toEqual({ amount: 0, unit: 'weeks' });
    expect(parseDuration('PT0H')).toEqual({ amount: 0, unit: 'hours' });
    expect(parseDuration('PT0M')).toEqual({ amount: 0, unit: 'minutes' });
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('P1DT')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration(5)).toBeNull();
  });

  it('round-trips local input values', () => {
    const iso = '2026-09-01T10:30:00.000Z';
    const local = toLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe(iso);
    expect(toLocalInput('now')).toBe('');
    expect(toLocalInput('nope')).toBe('');
    expect(toLocalInput(undefined)).toBe('');
    expect(fromLocalInput('')).toBe('');
    expect(fromLocalInput('garbage')).toBe('');
  });
});

describe('filter-model completeness', () => {
  it('lists only non-empty string values', () => {
    expect(valueList(['a', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(valueList('x')).toEqual(['x']);
    expect(valueList('')).toEqual([]);
    expect(valueList(null)).toEqual([]);
  });

  it('judges conditions complete per value shape', () => {
    expect(isConditionComplete({ field: 'state', operator: 'is', value: [] })).toBe(false);
    expect(isConditionComplete({ field: 'state', operator: 'is', value: ['open'] })).toBe(true);
    expect(isConditionComplete({ field: 'sla_status', operator: 'is', value: '' })).toBe(false);
    expect(isConditionComplete({ field: 'sla_status', operator: 'is', value: 'breached' })).toBe(true);
    expect(isConditionComplete({ field: 'created_at', operator: 'within_last', value: 'P0D' })).toBe(false);
    expect(isConditionComplete({ field: 'created_at', operator: 'within_last', value: 'bad' })).toBe(false);
    expect(isConditionComplete({ field: 'created_at', operator: 'within_last', value: 'P2D' })).toBe(true);
    expect(isConditionComplete({ field: 'created_at', operator: 'before', value: 'now' })).toBe(true);
    expect(isConditionComplete({ field: 'created_at', operator: 'before', value: '' })).toBe(false);
    expect(isConditionComplete({ field: 'created_at', operator: 'before', value: 'not a date' })).toBe(false);
    expect(isConditionComplete({ field: 'created_at', operator: 'before', value: '2026-09-01T10:00:00.000Z' })).toBe(true);
  });

  it('needs every condition complete and no empty group', () => {
    const done: Condition = { field: 'state', operator: 'is', value: ['open'] };
    const blank: Condition = { field: 'state', operator: 'is', value: [] };
    expect(isTreeComplete({ op: 'and', items: [] })).toBe(false);
    expect(isTreeComplete({ op: 'and', items: [done] })).toBe(true);
    expect(isTreeComplete({ op: 'and', items: [done, { op: 'or', items: [blank] }] })).toBe(false);
    expect(isTreeComplete({ op: 'and', items: [done, { op: 'or', items: [] }] })).toBe(false);
    expect(isTreeComplete({ op: 'and', items: [done, { op: 'or', items: [done] }] })).toBe(true);
  });

  it('counts conditions across nested groups and describes one', () => {
    const tree: ConditionGroup = {
      op: 'and',
      items: [
        { field: 'state', operator: 'is', value: ['open'] },
        { op: 'or', items: [{ field: 'priority', operator: 'is', value: ['high'] }, { op: 'and', items: [{ field: 'tags', operator: 'contains', value: ['t'] }] }] },
      ],
    };
    expect(countConditions(tree)).toBe(3);
    expect(isGroup(tree)).toBe(true);
    expect(isGroup(tree.items[0]!)).toBe(false);
    expect(describeCondition({ field: 'state', operator: 'is_not', value: [] })).toBe('State is not');
    expect(describeCondition({ field: 'created_at', operator: 'within_last', value: 'P1D' })).toBe('Created is within the last');
  });

  it('picks the first field not yet used, falling back to state', () => {
    expect(nextUnusedField(defaultConditions())).toBe('priority');
    const all: ConditionGroup = { op: 'and', items: FIELD_ORDER.map((field) => newCondition(field)) };
    expect(nextUnusedField(all)).toBe('state');
    expect(nextUnusedField(defaultConditions(), ['state', 'group'])).toBe('group');
  });
});

describe('filter-model tree edits and nesting', () => {
  const a: Condition = { field: 'state', operator: 'is', value: ['open'] };
  const b: Condition = { field: 'priority', operator: 'is', value: ['high'] };
  const c: Condition = { field: 'group', operator: 'is', value: ['g1'] };
  const tree: ConditionGroup = { op: 'and', items: [a, { op: 'or', items: [b, c] }] };

  it('finds nodes by path', () => {
    expect(nodeAt(tree, [])).toBe(tree);
    expect(nodeAt(tree, [0])).toBe(a);
    expect(nodeAt(tree, [1, 1])).toBe(c);
    expect(nodeAt(tree, [5])).toBeUndefined();
    expect(nodeAt(tree, [0, 0])).toBeUndefined();
  });

  it('replaces immutably', () => {
    const next = replaceAt(tree, [1, 0], { ...b, value: ['low'] });
    expect(nodeAt(next, [1, 0])).toEqual({ ...b, value: ['low'] });
    expect(nodeAt(tree, [1, 0])).toBe(b);
    expect(replaceAt(tree, [], { op: 'or', items: [a] })).toEqual({ op: 'or', items: [a] });
    expect(replaceAt(tree, [], a)).toBe(tree);
    // Descending through a condition is a no-op.
    expect(replaceAt(tree, [0, 0], b)).toEqual(tree);
  });

  it('removes immutably', () => {
    expect(removeAt(tree, [0]).items).toHaveLength(1);
    expect(nodeAt(removeAt(tree, [1, 0]), [1, 0])).toBe(c);
    expect(removeAt(tree, [])).toBe(tree);
    expect(removeAt(tree, [0, 0])).toEqual(tree);
    expect(tree.items).toHaveLength(2);
  });

  it('builds keys and API error paths', () => {
    expect(pathKey([])).toBe('r');
    expect(pathKey([1, 2])).toBe('r-1-2');
    expect(errorPath('conditions', [])).toBe('conditions');
    expect(errorPath('conditions', [1, 0])).toBe('conditions.items.1.items.0');
  });
});
