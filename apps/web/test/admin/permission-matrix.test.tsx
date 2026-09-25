import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionList } from '../../src/components/builders/PermissionList';
import { PermissionMatrix, toggleEntry, type MatrixEntry } from '../../src/components/builders/PermissionMatrix';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

/**
 * The role editor's builders (T097): the groups × actions grid is operable from the keyboard
 * alone (one tab stop, arrows, Space), keeps View as the gate, and is read-only for Admin; the
 * permission list groups keys by module with the "New" badge.
 */

const GROUPS = [
  { id: 'g-support', name: 'Support' },
  { id: 'g-billing', name: 'Billing', status: 'inactive' as const },
];

function Harness({ initial = [], locked = false, onChange }: { initial?: MatrixEntry[]; locked?: boolean; onChange?: (next: MatrixEntry[]) => void }) {
  const [value, setValue] = useState<MatrixEntry[]>(initial);
  return (
    <PermissionMatrix
      label="Group access for Support Agent"
      groups={GROUPS}
      value={value}
      locked={locked}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const cell = (action: string, group: string) => screen.getByRole('checkbox', { name: `${action} tickets in ${group}` });

describe('PermissionMatrix', () => {
  it('shows Ungrouped first, then each group, with View/Create/Edit/Delete columns, and is free of axe violations', async () => {
    const { container } = renderWithProviders(<Harness />);
    const grid = screen.getByRole('grid', { name: 'Group access for Support Agent' });
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Group', 'View', 'Create', 'Edit', 'Delete']);
    expect(within(grid).getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      expect.stringContaining('Ungrouped'),
      'Support',
      expect.stringContaining('Billing'),
    ]);
    expect(within(grid).getByText('Inactive')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('has a single tab stop and moves with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button">Before</button>
        <Harness />
      </>,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.filter((box) => box.tabIndex === 0)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Before' }));
    await user.tab();
    expect(cell('View', 'Ungrouped')).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(cell('Edit', 'Ungrouped')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(cell('Edit', 'Support')).toHaveFocus();
    await user.keyboard('{End}');
    expect(cell('Delete', 'Support')).toHaveFocus();
    await user.keyboard('{Home}{ArrowUp}{ArrowUp}');
    expect(cell('View', 'Ungrouped')).toHaveFocus();
    // The last focused cell is the tab stop when coming back.
    await user.keyboard('{ArrowDown}');
    expect(cell('View', 'Support').tabIndex).toBe(0);
  });

  it('toggles the focused cell with Space; any action grants View, removing View clears the row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    cell('Edit', 'Support').focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith([{ groupId: 'g-support', view: true, create: false, edit: true, delete: false }]);
    expect(cell('View', 'Support')).toBeChecked();

    await user.click(cell('View', 'Support'));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(cell('Edit', 'Support')).not.toBeChecked();
  });

  it('is read-only for Admin', () => {
    renderWithProviders(<Harness locked initial={[{ groupId: null, view: true, create: true, edit: true, delete: true }]} />);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(cell('Delete', 'Ungrouped')).toBeChecked();
  });

  it('toggleEntry applies the View rule', () => {
    const none = { groupId: null, view: false, create: false, edit: false, delete: false };
    expect(toggleEntry(none, 'delete')).toEqual({ ...none, view: true, delete: true });
    expect(toggleEntry({ ...none, view: true, edit: true }, 'edit')).toEqual({ ...none, view: true });
    expect(toggleEntry({ ...none, view: true, edit: true }, 'view')).toEqual(none);
  });
});

describe('PermissionList', () => {
  const permissions = [
    { key: 'role.view', module: 'authorization', description: 'View roles', groupScoped: false },
    { key: 'ticket.view', module: 'tickets', description: 'View tickets', groupScoped: true },
    { key: 'ticket.edit', module: 'tickets', description: 'Edit tickets', groupScoped: true },
  ];

  it('groups by module with tickets first, marks group-scoped and new keys, and toggles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderWithProviders(
      <PermissionList permissions={permissions} value={new Set(['ticket.view'])} onChange={onChange} newKeys={new Set(['role.view'])} />,
    );
    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toEqual(['permission-module-tickets', 'permission-module-authorization']);
    expect(within(groups[0] as HTMLElement).getAllByText('needs group access')).toHaveLength(2);
    expect(within(groups[1] as HTMLElement).getByText('New')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Edit tickets' }));
    expect(onChange).toHaveBeenCalledWith(new Set(['ticket.view', 'ticket.edit']));
    await expectNoAxeViolations(container);
  });

  it('is read-only when locked', () => {
    renderWithProviders(<PermissionList permissions={permissions} value={new Set()} locked />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });
});
