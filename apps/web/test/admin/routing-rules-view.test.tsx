import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../src/data/http';
import { RoutingRulesView, type RoutingRulesViewProps } from '../../src/pages/admin/routing/RoutingRulesView';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import { groupsFixture, makeDryRun, makeRoutingRule, tagsFixture } from './routing-fixtures';

import type { RoutingRule } from '../../src/api/generated/model';

const SLOW = 60_000;
const FIND = { timeout: 10_000 };

const rules: RoutingRule[] = [
  makeRoutingRule({ id: 'rule-1', name: 'Refunds to Billing', position: 0 }),
  makeRoutingRule({
    id: 'rule-2',
    name: 'VIP to Support',
    position: 1,
    enabled: false,
    conditions: { customerTagIds: ['tag-vip'], emailDomains: ['big.com'] },
    actions: { groupId: 'group-support' },
  }),
  makeRoutingRule({ id: 'rule-3', name: 'Stale rule', position: 2, conditions: { messageContainsAll: ['old'] }, actions: { groupId: 'group-old' } }),
];

function setup(props: Partial<RoutingRulesViewProps> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onRetryLookups: vi.fn(),
    onSave: vi.fn<RoutingRulesViewProps['onSave']>().mockResolvedValue(undefined),
    onToggle: vi.fn<RoutingRulesViewProps['onToggle']>().mockResolvedValue(undefined),
    onReorder: vi.fn<RoutingRulesViewProps['onReorder']>().mockResolvedValue(undefined),
    onDelete: vi.fn<RoutingRulesViewProps['onDelete']>().mockResolvedValue(undefined),
    onTest: vi.fn<RoutingRulesViewProps['onTest']>().mockResolvedValue(makeDryRun()),
  };
  const utils = renderWithProviders(
    <RoutingRulesView
      status="ready"
      rules={rules}
      groups={groupsFixture}
      tags={tagsFixture}
      lookupsLoading={false}
      lookupsFailed={false}
      canCreate
      canEdit
      canDelete
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...utils };
}

const live = (container: HTMLElement, mode: 'polite' | 'assertive' = 'polite') => container.ownerDocument.querySelector(`[aria-live="${mode}"]`);

describe('RoutingRulesView states', () => {
  it('shows a loading status while pending', () => {
    setup({ status: 'pending', rules: [] });
    expect(screen.getByRole('heading', { name: 'Routing rules', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });

  it('shows the error with a working retry', async () => {
    const { onRetry } = setup({ status: 'error', errorMessage: 'Server exploded', rules: [] });
    expect(screen.getByText("Couldn't load routing rules")).toBeInTheDocument();
    expect(screen.getByText('Server exploded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the empty state with an Add rule action, and the test panel', async () => {
    const { container } = setup({ rules: [] });
    expect(screen.getByText('No routing rules yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add rule' })).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Try a message' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('hides Add rule in the empty state without create permission', () => {
    setup({ rules: [], canCreate: false });
    expect(screen.getByText('No routing rules yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });

  it('warns when the group or tag lists failed, with retry', async () => {
    const { onRetryLookups } = setup({ lookupsFailed: true });
    expect(screen.getByText(/Couldn't load the groups or tags/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryLookups).toHaveBeenCalled();
    expect(screen.queryByText(/Group inactive/)).not.toBeInTheDocument();
  });
});

describe('RoutingRulesView list', () => {
  it('lists rules in order with summaries, a disabled chip and an inactive-group warning', async () => {
    const { container } = setup();
    const list = screen.getByRole('list', { name: 'Routing rules, in evaluation order' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => within(li).getByText(/^(Refunds to Billing|VIP to Support|Stale rule)$/).textContent)).toEqual([
      'Refunds to Billing',
      'VIP to Support',
      'Stale rule',
    ]);
    expect(within(items[0]!).getByText('Message contains any of "refund", "invoice"')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Assign to Billing, priority High, tags vip')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Customer has any of the tags vip; customer email domain is big.com')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Disabled')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Group inactive - skipped')).toBeInTheDocument();
    expect(within(items[0]!).queryByText(/skipped/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable Refunds to Billing' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Enable VIP to Support' })).not.toBeChecked();
    await expectNoAxeViolations(container);
  });

  it('flags a rule whose group was deleted', () => {
    setup({ rules: [makeRoutingRule({ actions: { groupId: 'gone' } })] });
    expect(screen.getByText('Group deleted - skipped')).toBeInTheDocument();
    expect(screen.getByText(/^Assign to an unknown group/)).toBeInTheDocument();
  });

  it('calls onToggle from the enable switch and announces it', async () => {
    const { onToggle, container } = setup();
    await userEvent.click(screen.getByRole('switch', { name: 'Enable Refunds to Billing' }));
    expect(onToggle).toHaveBeenCalledWith(rules[0], false);
    await waitFor(() => expect(live(container)).toHaveTextContent('Refunds to Billing disabled.'));
  });

  it('toasts when enabling a rule with an inactive group is refused, and leaves the switch off', async () => {
    const disabledStale = makeRoutingRule({ id: 'rule-9', name: 'Old rule', position: 0, enabled: false, actions: { groupId: 'group-old' } });
    const { onToggle } = setup({ rules: [disabledStale] });
    onToggle.mockRejectedValueOnce(new HttpError(400, { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'actions.groupId', issue: 'invalid_value' }] }));
    const toggle = screen.getByRole('switch', { name: 'Enable Old rule' });
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(disabledStale, true);
    const message = 'Old rule was not enabled. Its group is not active: edit the rule to choose an active group.';
    expect((await screen.findAllByText(message, undefined, FIND)).length).toBeGreaterThan(0);
    expect(toggle).not.toBeChecked();
  });

  it('toasts a generic failure for a toggle', async () => {
    const { onToggle } = setup();
    onToggle.mockRejectedValueOnce(new HttpError(500, { code: 'INTERNAL', message: 'Boom' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Enable Refunds to Billing' }));
    expect((await screen.findAllByText(/Refunds to Billing was not changed\./, undefined, FIND)).length).toBeGreaterThan(0);
  });

  it('moves a rule down and up, disabled at the ends, with an announcement', async () => {
    const { onReorder, container } = setup();
    expect(screen.getByRole('button', { name: 'Move Refunds to Billing up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Stale rule down' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Move Refunds to Billing down' }));
    expect(onReorder).toHaveBeenLastCalledWith(['rule-2', 'rule-1', 'rule-3']);
    await waitFor(() => expect(live(container)).toHaveTextContent('Refunds to Billing moved to position 2 of 3.'));
    const names = within(screen.getByRole('list', { name: /Routing rules/ }))
      .getAllByRole('switch')
      .map((s) => s.getAttribute('aria-label'));
    expect(names).toEqual(['Enable VIP to Support', 'Enable Refunds to Billing', 'Enable Stale rule']);

    await userEvent.click(screen.getByRole('button', { name: 'Move Stale rule up' }));
    expect(onReorder).toHaveBeenLastCalledWith(['rule-2', 'rule-3', 'rule-1']);
  });

  it('puts the old order back and toasts when the reorder fails', async () => {
    const { onReorder } = setup();
    onReorder.mockRejectedValueOnce(new HttpError(500, { code: 'INTERNAL', message: 'Boom' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move Refunds to Billing down' }));
    expect((await screen.findAllByText(/The new order was not saved\./, undefined, FIND)).length).toBeGreaterThan(0);
    const names = within(screen.getByRole('list', { name: /Routing rules/ }))
      .getAllByRole('switch')
      .map((s) => s.getAttribute('aria-label'));
    expect(names[0]).toBe('Enable Refunds to Billing');
  });

  it('respects edit and delete permissions', () => {
    setup({ canEdit: false, canDelete: false, canCreate: false });
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable Refunds to Billing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Refunds to Billing down' })).toBeDisabled();
  });

  it('allows delete without edit', () => {
    setup({ canEdit: false, canDelete: true });
    expect(screen.getByRole('button', { name: 'Delete Refunds to Billing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Refunds to Billing' })).not.toBeInTheDocument();
  });

  it('disables Add rule at the 100 rule limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => makeRoutingRule({ id: `r${i}`, name: `Rule ${i}`, position: i }));
    setup({ rules: many });
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it('deletes after confirmation', async () => {
    const { onDelete } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete VIP to Support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete VIP to Support' }, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(rules[1]));
    expect(await screen.findByText('VIP to Support deleted', undefined, FIND)).toBeInTheDocument();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const { onDelete } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete VIP to Support' }));
    const dialog = await screen.findByRole('dialog', undefined, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('RoutingRulesView editor', () => {
  it(
    'adds a rule: validates, then saves the body',
    async () => {
      const { onSave } = setup();
      await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add routing rule' }, FIND);

      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      expect(onSave).not.toHaveBeenCalled();
      expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAccessibleDescription('Enter a name for the routing rule.');
      expect(within(dialog).getByText('Fill in at least one condition.')).toBeInTheDocument();
      expect(within(dialog).getByRole('combobox', { name: /Assign to group/ })).toHaveAccessibleDescription('Choose the group that gets these tickets.');

      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Invoices');
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'First message contains any of' }), 'invoice{Enter}');
      await userEvent.click(within(dialog).getByRole('combobox', { name: /Assign to group/ }));
      expect(await screen.findByRole('option', { name: 'Legacy (inactive)' })).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(screen.getByRole('option', { name: 'Billing' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(
          { name: 'Invoices', enabled: true, conditions: { messageContainsAny: ['invoice'] }, actions: { groupId: 'group-billing' } },
          undefined,
        ),
      );
      await waitForElementToBeRemoved(() => screen.queryByRole('dialog', { name: 'Add routing rule' }), FIND);
      expect(await screen.findByText('Rule "Invoices" added at the end of the list.', undefined, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'edits a rule prefilled from it and saves with its id',
    async () => {
      const { onSave } = setup();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Refunds to Billing' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit routing rule' }, FIND);
      const name = within(dialog).getByRole('textbox', { name: /^Name/ });
      expect(name).toHaveValue('Refunds to Billing');
      await userEvent.clear(name);
      await userEvent.type(name, 'Renamed');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(
          {
            name: 'Renamed',
            enabled: true,
            conditions: { messageContainsAny: ['refund', 'invoice'] },
            actions: { groupId: 'group-billing', priority: 'high', tagIds: ['tag-vip'] },
          },
          'rule-1',
        ),
      );
    },
    SLOW,
  );

  it(
    'maps a 400 VALIDATION_FAILED onto its fields and keeps the drawer open',
    async () => {
      const { onSave, container } = setup();
      onSave.mockRejectedValueOnce(
        new HttpError(400, {
          code: 'VALIDATION_FAILED',
          message: 'Invalid',
          details: [
            { path: 'actions.groupId', issue: 'invalid_value' },
            { path: 'name', issue: 'too_long' },
          ],
        }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Edit Refunds to Billing' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit routing rule' }, FIND);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAccessibleDescription('This is too long.'));
      expect(within(dialog).getByRole('combobox', { name: /Assign to group/ })).toHaveAccessibleDescription('Pick one of the available options.');
      expect(dialog).toBeInTheDocument();
      expect(live(container, 'assertive')).toHaveTextContent('The rule was not saved.');
    },
    SLOW,
  );

  it(
    'shows a non-field failure as a form alert',
    async () => {
      const { onSave } = setup();
      onSave.mockRejectedValueOnce(new HttpError(500, { code: 'INTERNAL', message: 'Boom' }));
      await userEvent.click(screen.getByRole('button', { name: 'Edit Refunds to Billing' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit routing rule' }, FIND);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      expect(await within(dialog).findByRole('alert', undefined, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'closes a clean editor without asking, and asks before discarding changes',
    async () => {
      setup();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Refunds to Billing' }));
      let dialog = await screen.findByRole('dialog', { name: 'Edit routing rule' }, FIND);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitForElementToBeRemoved(() => screen.queryByRole('dialog', { name: 'Edit routing rule' }), FIND);

      await userEvent.click(screen.getByRole('button', { name: 'Edit Refunds to Billing' }));
      dialog = await screen.findByRole('dialog', { name: 'Edit routing rule' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), ' more');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      const prompt = await screen.findByRole('dialog', { name: 'Discard your changes?' }, FIND);
      await userEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Edit routing rule' })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      const again = await screen.findByRole('dialog', { name: 'Discard your changes?' }, FIND);
      await userEvent.click(within(again).getByRole('button', { name: 'Discard changes' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), FIND);
    },
    SLOW,
  );
});

describe('RoutingRulesView test panel', () => {
  async function run(message: string) {
    await userEvent.type(screen.getByRole('textbox', { name: /^Message/ }), message);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
  }

  it('disables Run until there is a message', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('sends the sample and names the winning rule, group, priority and tags', async () => {
    const { onTest, container } = setup();
    onTest.mockResolvedValue(
      makeDryRun({ matchedRuleId: 'rule-2', matchedRuleName: 'VIP to Support', actions: { groupId: 'group-support', priority: 'urgent', tagIds: ['tag-vip'] } }),
    );
    await userEvent.type(screen.getByRole('textbox', { name: /^Customer email/ }), 'a@big.com');
    await userEvent.click(screen.getByRole('combobox', { name: 'Customer tags' }));
    await userEvent.click(await screen.findByRole('option', { name: 'vip' }));
    await run('  my invoice  ');
    expect(onTest).toHaveBeenCalledWith({ message: 'my invoice', customerEmail: 'a@big.com', customerTagIds: ['tag-vip'] });
    const result = await screen.findByRole('group', { name: 'Test result' }, FIND);
    expect(result).toHaveTextContent('Matches rule 2: VIP to Support -> Support (urgent, tags vip)');
    await waitFor(() => expect(live(container)).toHaveTextContent('Matches rule 2'));
  });

  it('says so when no rule matches', async () => {
    setup();
    await run('hello');
    expect(await screen.findByRole('group', { name: 'Test result' }, FIND)).toHaveTextContent('No rule matches: the ticket would stay in Needs Triage.');
  });

  it('lists rules skipped because of their group', async () => {
    const { onTest } = setup();
    onTest.mockResolvedValue(
      makeDryRun({
        matchedRuleId: 'rule-1',
        matchedRuleName: 'Refunds to Billing',
        actions: { groupId: 'group-billing' },
        skipped: [
          { ruleId: 'rule-3', ruleName: 'Stale rule', reason: 'group_inactive' },
          { ruleId: 'rule-9', ruleName: 'Ghost', reason: 'group_missing' },
        ],
      }),
    );
    await run('old');
    const result = await screen.findByRole('group', { name: 'Test result' }, FIND);
    expect(result).toHaveTextContent('Skipped because their group is inactive: Stale rule.');
    expect(result).toHaveTextContent('Skipped because their group no longer exists: Ghost.');
  });

  it('shows field errors and general failures', async () => {
    const { onTest, container } = setup();
    onTest.mockRejectedValueOnce(new HttpError(400, { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'customerEmail', issue: 'invalid_format' }] }));
    await run('hello');
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Customer email/ })).toHaveAccessibleDescription('This value is not valid.'));
    expect(live(container, 'assertive')).toHaveTextContent('The test did not run.');

    onTest.mockRejectedValueOnce(new HttpError(500, { code: 'INTERNAL', message: 'Boom' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert', undefined, FIND)).toBeInTheDocument();
  });
});
