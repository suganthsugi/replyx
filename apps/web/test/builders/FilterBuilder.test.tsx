import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { defaultConditions } from '../../src/components/builders/filter-model';
import { FilterBuilder } from '../../src/components/builders/FilterBuilder';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import type { Condition, ConditionGroup } from '../../src/api/generated/model';
import type { FilterBuilderProps } from '../../src/components/builders/FilterBuilder';

const lookups = {
  groups: [{ id: 'g1', name: 'Support' }],
  users: [{ id: 'u1', name: 'Ada Agent' }],
  tags: [{ id: 't1', name: 'billing' }],
};

/** Controlled host that records the latest tree. */
function Host({ initial = defaultConditions(), onTree, ...props }: Partial<FilterBuilderProps> & { initial?: ConditionGroup; onTree?: (tree: ConditionGroup) => void }) {
  const [tree, setTree] = useState(initial);
  return (
    <FilterBuilder
      value={tree}
      lookups={lookups}
      {...props}
      onChange={(next) => {
        setTree(next);
        onTree?.(next);
      }}
    />
  );
}

const lastTree = (fn: { mock: { lastCall?: [ConditionGroup] } }): ConditionGroup => fn.mock.lastCall![0];
const lastCondition = (fn: { mock: { lastCall?: [ConditionGroup] } }, index: number): Condition => lastTree(fn).items[index] as Condition;

const live = (container: HTMLElement, mode: 'polite' | 'assertive' = 'polite') => container.ownerDocument.querySelector(`[aria-live="${mode}"]`);

describe('FilterBuilder', () => {
  it('renders the default condition with labelled controls and no axe violations', async () => {
    const { container } = renderWithProviders(<Host />);
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByRole('combobox', { name: 'Field' })).toHaveTextContent('State');
    expect(within(row).getByRole('combobox', { name: 'Operator' })).toHaveTextContent('is not');
    expect(within(row).getByText('Closed')).toBeInTheDocument();
    // The only condition cannot be removed.
    expect(screen.getByRole('button', { name: 'Remove condition 1: State is not' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'All (AND)' })).toHaveAttribute('aria-pressed', 'true');
    await expectNoAxeViolations(container);
  });

  it('adds a condition on the next unused field, focuses it and announces the total', async () => {
    const onTree = vi.fn<(tree: ConditionGroup) => void>();
    const { container } = renderWithProviders(<Host onTree={onTree} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));

    const row = screen.getByRole('group', { name: 'Condition 2' });
    expect(within(row).getByRole('combobox', { name: 'Field' })).toHaveTextContent('Priority');
    expect(within(row).getByRole('combobox', { name: 'Field' })).toHaveFocus();
    expect(live(container)).toHaveTextContent('Condition added. 2 conditions in total.');
    expect(lastTree(onTree).items).toHaveLength(2);
  });

  it('removes a condition, focuses the neighbour and announces what is left', async () => {
    const { container } = renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove condition 2: Priority is' }));

    expect(screen.queryByRole('group', { name: 'Condition 2' })).not.toBeInTheDocument();
    expect(live(container)).toHaveTextContent('Condition 2 removed. 1 condition left.');
    expect(within(screen.getByRole('group', { name: 'Condition 1' })).getByRole('combobox', { name: 'Field' })).toHaveFocus();
  });

  it('adds a nested group with the opposite match mode, and removes it', async () => {
    const onTree = vi.fn<(tree: ConditionGroup) => void>();
    const { container } = renderWithProviders(<Host onTree={onTree} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add group' }));

    const group = screen.getByRole('group', { name: 'Group 2' });
    expect(within(group).getByRole('button', { name: 'Any (OR)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('group', { name: 'Condition 1' })).toBeInTheDocument();
    expect(live(container)).toHaveTextContent('Group added, matching any of its conditions. 2 conditions in total.');
    expect(lastTree(onTree).items[1]).toMatchObject({ op: 'or' });

    await userEvent.click(within(group).getByRole('button', { name: 'All (AND)' }));
    expect(lastTree(onTree).items[1]).toMatchObject({ op: 'and' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove group 2' }));
    expect(screen.queryByRole('group', { name: 'Group 2' })).not.toBeInTheDocument();
    expect(live(container)).toHaveTextContent('Group removed. 1 condition left.');
  });

  it('stops offering groups at the nesting limit and explains why', () => {
    const deep: ConditionGroup = {
      op: 'and',
      items: [{ op: 'or', items: [{ op: 'and', items: [{ field: 'state', operator: 'is', value: ['open'] }] }] }],
    };
    renderWithProviders(<Host initial={deep} />);
    const innermost = screen.getAllByRole('button', { name: 'Add group' })[0]!;
    expect(innermost).toBeDisabled();
    expect(innermost).toHaveAccessibleDescription('Groups can be nested 3 levels deep.');
  });

  it('disables adding at the total condition limit', () => {
    const many: ConditionGroup = {
      op: 'and',
      items: Array.from({ length: 20 }, () => ({ field: 'state' as const, operator: 'is' as const, value: ['open'] })),
    };
    renderWithProviders(<Host initial={many} />);
    const add = screen.getByRole('button', { name: 'Add condition' });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription('Limit reached: a view can have 20 conditions in total.');
  });

  it('resets the operator and value when the field changes', async () => {
    const onTree = vi.fn<(tree: ConditionGroup) => void>();
    renderWithProviders(<Host onTree={onTree} />);
    const row = screen.getByRole('group', { name: 'Condition 1' });
    await userEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Created' }));

    expect(lastTree(onTree).items[0]).toEqual({ field: 'created_at', operator: 'within_last', value: 'P7D' });
    expect(within(row).getByRole('combobox', { name: 'Operator' })).toHaveTextContent('is within the last');
    expect(within(row).getByRole('spinbutton', { name: 'Amount' })).toHaveValue(1);
  });

  it('does not offer Customer without customer search', async () => {
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Field' }));
    expect(await screen.findByRole('option', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Customer' })).not.toBeInTheDocument();
  });

  it('edits a multi-select value and a relative duration', async () => {
    const onTree = vi.fn<(tree: ConditionGroup) => void>();
    renderWithProviders(
      <Host
        onTree={onTree}
        initial={{
          op: 'and',
          items: [
            { field: 'state', operator: 'is', value: [] },
            { field: 'updated_at', operator: 'within_last', value: 'P1D' },
          ],
        }}
      />,
    );
    const first = screen.getByRole('group', { name: 'Condition 1' });
    await userEvent.click(within(first).getByRole('combobox', { name: 'Value' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }));
    expect(lastCondition(onTree, 0).value).toEqual(['open']);

    const second = screen.getByRole('group', { name: 'Condition 2' });
    const amount = within(second).getByRole('spinbutton', { name: 'Amount' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '3');
    expect(lastCondition(onTree, 1).value).toBe('P3D');
    await userEvent.click(within(second).getByRole('combobox', { name: 'Unit' }));
    await userEvent.click(await screen.findByRole('option', { name: 'weeks' }));
    expect(lastCondition(onTree, 1).value).toBe('P3W');
  });

  it('is operable from the keyboard', async () => {
    const onTree = vi.fn<(tree: ConditionGroup) => void>();
    renderWithProviders(<Host onTree={onTree} />);
    const add = screen.getByRole('button', { name: 'Add condition' });
    add.focus();
    await userEvent.keyboard('{Enter}');
    expect(lastTree(onTree).items).toHaveLength(2);
    // Focus is on the new row's Field select; open it with the keyboard and choose an option.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(await screen.findByRole('option', { name: 'Group' }));
    expect(lastCondition(onTree, 1).field).toBe('group');
    // The Remove button is reachable and activates with Space.
    screen.getByRole('button', { name: 'Remove condition 2: Group is' }).focus();
    await userEvent.keyboard(' ');
    expect(lastTree(onTree).items).toHaveLength(1);
  });

  it('shows API errors on the row controls and an incomplete hint', () => {
    renderWithProviders(
      <Host
        showIncomplete
        initial={{ op: 'and', items: [{ field: 'state', operator: 'is', value: [] }, { field: 'priority', operator: 'is', value: ['high'] }] }}
        errors={{ 'conditions.items.1.operator': 'Choose one of the allowed values', 'conditions.items.1': 'Row is broken', conditions: 'Group is broken' }}
      />,
    );
    const first = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(first).getByText('Choose a value')).toBeInTheDocument();
    const second = screen.getByRole('group', { name: 'Condition 2' });
    expect(within(second).getByText('Choose one of the allowed values')).toBeInTheDocument();
    expect(second).toHaveAccessibleDescription('Row is broken');
    expect(screen.getByText('Group is broken')).toBeInTheDocument();
  });

  it('disables every control when disabled', () => {
    renderWithProviders(<Host disabled />);
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add group' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Any (OR)' })).toBeDisabled();
  });
});
