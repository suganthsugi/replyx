import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ROUTING_RULE_CONFIG, emptyRuleForm, type RuleFormValue } from '../../src/components/builders/rule-model';
import { RuleBuilder, type RuleBuilderProps } from '../../src/components/builders/RuleBuilder';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

const lookups = {
  tags: [
    { id: 'tag-vip', name: 'vip' },
    { id: 'tag-refund', name: 'refund' },
  ],
  groups: [
    { id: 'group-billing', name: 'Billing' },
    { id: 'group-old', name: 'Legacy (inactive)', disabled: true },
  ],
};

function Harness({ initial, onValue, ...props }: Partial<RuleBuilderProps> & { initial?: RuleFormValue; onValue?: (v: RuleFormValue) => void }) {
  const [value, setValue] = useState(initial ?? emptyRuleForm(ROUTING_RULE_CONFIG));
  return (
    <RuleBuilder
      config={ROUTING_RULE_CONFIG}
      lookups={lookups}
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

describe('RuleBuilder', () => {
  it('renders labelled fields and is free of axe violations', async () => {
    const { container } = renderWithProviders(<Harness />);
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    for (const name of ['First message contains any of', 'First message contains all of', 'Customer has any of the tags', 'Customer email domain is', 'Add tags']) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('combobox', { name: /Assign to group/ })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('adds phrase chips with Enter, drops duplicates, and removes them', async () => {
    const onValue = vi.fn<(v: RuleFormValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    const input = screen.getByRole('combobox', { name: 'First message contains any of' });
    await userEvent.type(input, 'refund{Enter}');
    await userEvent.type(input, 'refund{Enter}');
    // A duplicate adds nothing (the typed text stays in the box until cleared).
    expect(onValue.mock.lastCall?.[0].conditions.messageContainsAny).toEqual(['refund']);
    await userEvent.clear(input);
    await userEvent.type(input, 'invoice{Enter}');
    expect(onValue.mock.lastCall?.[0].conditions.messageContainsAny).toEqual(['refund', 'invoice']);
    const chip = screen.getByText('refund').closest('.MuiChip-root') as HTMLElement;
    await userEvent.click(within(chip).getByTestId('CancelIcon'));
    expect(onValue.mock.lastCall?.[0].conditions.messageContainsAny).toEqual(['invoice']);
  });

  it('lower-cases email domains and strips a leading @', async () => {
    const onValue = vi.fn<(v: RuleFormValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Customer email domain is' }), '@Example.COM{Enter}');
    expect(onValue.mock.lastCall?.[0].conditions.emailDomains).toEqual(['example.com']);
  });

  it('picks tags and a group, and cannot pick a disabled group', async () => {
    const onValue = vi.fn<(v: RuleFormValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Add tags' }));
    await userEvent.click(await screen.findByRole('option', { name: 'vip' }));
    expect(onValue.mock.lastCall?.[0].actions.tagIds).toEqual(['tag-vip']);

    await userEvent.click(screen.getByRole('combobox', { name: /Assign to group/ }));
    expect(await screen.findByRole('option', { name: 'Legacy (inactive)' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('option', { name: 'Billing' }));
    expect(onValue.mock.lastCall?.[0].actions.groupId).toEqual(['group-billing']);
  });

  it('sets and clears the priority', async () => {
    const onValue = vi.fn<(v: RuleFormValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Set priority' }));
    await userEvent.click(await screen.findByRole('option', { name: 'High' }));
    expect(onValue.mock.lastCall?.[0].actions.priority).toEqual(['high']);
    await userEvent.click(screen.getByRole('combobox', { name: 'Set priority' }));
    await userEvent.click(await screen.findByRole('option', { name: 'None' }));
    expect(onValue.mock.lastCall?.[0].actions.priority).toEqual([]);
  });

  it('toggles enabled and edits the name', async () => {
    const onValue = vi.fn<(v: RuleFormValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('switch', { name: /Enabled/ }));
    expect(onValue.mock.lastCall?.[0].enabled).toBe(false);
    expect(screen.getByRole('switch', { name: /Disabled/ })).not.toBeChecked();
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Mine');
    expect(onValue.mock.lastCall?.[0].name).toBe('Mine');
  });

  it('shows issues on their fields', async () => {
    const { container } = renderWithProviders(
      <Harness
        issues={{
          name: 'Enter a name for the routing rule.',
          conditions: 'Fill in at least one condition.',
          'actions.groupId': 'Choose the group that gets these tickets.',
          'conditions.messageContainsAny.1': 'This value is not valid.',
        }}
      />,
    );
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveAccessibleDescription('Enter a name for the routing rule.');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeInvalid();
    expect(screen.getByText('Fill in at least one condition.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Assign to group/ })).toHaveAccessibleDescription('Choose the group that gets these tickets.');
    expect(screen.getByRole('combobox', { name: 'First message contains any of' })).toBeInvalid();
    expect(screen.getByText('This value is not valid.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('disables every control', () => {
    renderWithProviders(<Harness disabled />);
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'First message contains any of' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Add tags' })).toBeDisabled();
  });

  it('keeps a deleted group visible as unknown', () => {
    const initial = { ...emptyRuleForm(ROUTING_RULE_CONFIG), actions: { groupId: ['gone'], priority: [], tagIds: [] } };
    renderWithProviders(<Harness initial={initial} />);
    expect(screen.getByRole('combobox', { name: /Assign to group/ })).toHaveTextContent('Unknown group');
  });
});
