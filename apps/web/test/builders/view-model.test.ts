import { describe, expect, it } from 'vitest';

import { defaultConditions } from '../../src/components/builders/filter-model';
import {
  COLUMN_OPTIONS,
  DEFAULT_COLUMNS,
  DEFAULT_SORT,
  columnLabel,
  initialFormState,
  sortLabel,
  toViewInput,
} from '../../src/components/builders/view-model';
import { makeView } from '../desk/fixtures';

describe('view-model', () => {
  it('starts a new view personal with the default conditions, sort and columns', () => {
    const state = initialFormState(undefined);
    expect(state).toEqual({
      name: '',
      description: '',
      visibility: 'personal',
      roleIds: [],
      groupIds: [],
      conditions: defaultConditions(),
      sort: DEFAULT_SORT,
      columns: DEFAULT_COLUMNS,
    });
    // Copies, so editing the form never mutates the shared defaults.
    expect(state.columns).not.toBe(DEFAULT_COLUMNS);
    expect(state.sort).not.toBe(DEFAULT_SORT);
  });

  it('seeds an existing view and drops sort fields and columns the builder does not know', () => {
    const state = initialFormState(
      makeView({
        name: 'Urgent',
        description: 'Fast lane',
        visibility: 'roles',
        sharedRoleIds: ['role-1'],
        sharedGroupIds: ['group-1'],
        sort: [
          { field: 'priority', direction: 'asc' },
          { field: 'mystery', direction: 'desc' },
        ] as never,
        columns: ['title', 'mystery', 'sla'],
      }),
    );
    expect(state).toMatchObject({ name: 'Urgent', description: 'Fast lane', visibility: 'roles', roleIds: ['role-1'], groupIds: ['group-1'] });
    expect(state.sort).toEqual([{ field: 'priority', direction: 'asc' }]);
    expect(state.columns).toEqual(['title', 'sla']);
    expect(initialFormState(makeView({ description: null })).description).toBe('');
  });

  it('converts the form to an API body, trimming and sending only the relevant shares', () => {
    const base = initialFormState(undefined);
    expect(toViewInput({ ...base, name: '  Mine  ', description: '   ' })).toEqual({
      name: 'Mine',
      visibility: 'personal',
      conditions: base.conditions,
      sort: base.sort,
      columns: base.columns,
    });
    const roles = toViewInput({ ...base, name: 'R', description: ' d ', visibility: 'roles', roleIds: ['r1'], groupIds: ['g1'] });
    expect(roles).toMatchObject({ description: 'd', sharedRoleIds: ['r1'] });
    expect(roles).not.toHaveProperty('sharedGroupIds');
    const groups = toViewInput({ ...base, name: 'G', visibility: 'groups', roleIds: ['r1'], groupIds: ['g1'] });
    expect(groups).toMatchObject({ sharedGroupIds: ['g1'] });
    expect(groups).not.toHaveProperty('sharedRoleIds');
  });

  it('labels sort fields and columns, falling back to the raw value', () => {
    expect(sortLabel('sla_due_at')).toBe('SLA due');
    expect(sortLabel('other')).toBe('other');
    expect(columnLabel('waiting_on')).toBe('Waiting on');
    expect(columnLabel('other')).toBe('other');
    expect(COLUMN_OPTIONS.map((o) => o.value)).toEqual(expect.arrayContaining([...DEFAULT_COLUMNS]));
  });
});
