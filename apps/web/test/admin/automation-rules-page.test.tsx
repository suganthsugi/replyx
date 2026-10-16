import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { summarizeAutomationActions, summarizeTrigger } from '../../src/components/builders/automation-rule-model';
import AutomationRulesPage from '../../src/pages/admin/automation/AutomationRulesPage';
import { eligibleOwnersHandler, groupDestinationsHandler, makeEligibleOwner, tagsHandler } from '../desk/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AutomationRule, AutomationRuleInput, ListAutomationRules200, Me } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const ALL = ['automation_rule.view', 'automation_rule.create', 'automation_rule.edit', 'automation_rule.delete'];

const me = (permissions: string[]): Me => ({
  id: 'u1',
  email: 'ada@acme.test',
  name: 'Ada',
  kind: 'staff',
  roles: [],
  permissions,
  groupAccess: [],
  accessVersion: 1,
});

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    name: 'Nudge quiet customers',
    enabled: true,
    position: 0,
    trigger: { event: 'time.elapsed', after: 'P2D', since: 'last_customer_message_at' },
    conditions: { op: 'and', items: [{ field: 'waiting_on', operator: 'is', value: 'customer' }] },
    actions: { autoReply: 'Any news?', state: 'pending_close', pendingInHours: 48 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const two = [
  makeRule(),
  makeRule({ id: 'rule-2', name: 'VIP to Billing', position: 1, trigger: { event: 'ticket.created' }, conditions: null, actions: { groupId: 'group-billing', addTagIds: ['tag-vip'] } }),
];

function seed(initial: AutomationRule[], permissions = ALL) {
  const state = { rules: [...initial], create: [] as AutomationRuleInput[], update: [] as AutomationRuleInput[], updatedIds: [] as string[], deleted: [] as string[] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me(permissions))),
    groupDestinationsHandler([{ id: 'group-billing', name: 'Billing' }]),
    eligibleOwnersHandler('group-billing', [makeEligibleOwner({ id: 'agent-1', name: 'Ada Agent' })]),
    tagsHandler([{ id: 'tag-vip', name: 'vip' }]),
    http.get(`${API}/automation-rules`, () => HttpResponse.json<ListAutomationRules200>({ items: state.rules })),
    http.post(`${API}/automation-rules`, async ({ request }) => {
      const body = (await request.json()) as AutomationRuleInput;
      state.create.push(body);
      const created = makeRule({ ...body, conditions: body.conditions, id: `rule-${state.rules.length + 1}`, position: state.rules.length });
      state.rules = [...state.rules, created];
      return HttpResponse.json<AutomationRule>(created, { status: 201 });
    }),
    http.put(`${API}/automation-rules/:id`, async ({ request, params }) => {
      const body = (await request.json()) as AutomationRuleInput;
      state.update.push(body);
      state.updatedIds.push(params.id as string);
      state.rules = state.rules.map((r) => (r.id === params.id ? { ...r, ...body } : r));
      return HttpResponse.json<AutomationRule>(state.rules.find((r) => r.id === params.id) ?? state.rules[0]!);
    }),
    http.delete(`${API}/automation-rules/:id`, ({ params }) => {
      state.deleted.push(params.id as string);
      state.rules = state.rules.filter((r) => r.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

describe('automation rule summaries', () => {
  it('describes triggers and actions in plain words', () => {
    expect(summarizeTrigger({ event: 'time.elapsed', after: 'P2D', since: 'last_customer_message_at' })).toBe("2 days after the customer's last message");
    expect(summarizeTrigger({ event: 'time.elapsed', after: 'PT1H', since: 'created_at' })).toBe('1 hour after the ticket was created');
    expect(summarizeTrigger({ event: 'message.created' })).toBe('When the customer sends a message');
    const names = { groups: new Map([['g', 'Billing']]), people: new Map([['p', 'Ada']]), tags: new Map([['t', 'vip']]) };
    expect(summarizeAutomationActions({ autoReply: 'x', state: 'pending_close', pendingInHours: 48, notifyUserIds: ['p'] }, names)).toBe(
      'Reply to the customer, state Pending (close) for 48 hours, notify Ada',
    );
    expect(summarizeAutomationActions({ ownerId: null, groupId: 'g', addTagIds: ['t', 'gone'] }, names)).toBe('Move to Billing, unassign, add tags vip, unknown tag');
  });
});

describe('AutomationRulesPage', () => {
  it('lists the rules with their summaries and is free of axe violations', async () => {
    seed(two);
    const { container } = renderWithProviders(<AutomationRulesPage />);
    expect(await screen.findByText('Nudge quiet customers', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText("2 days after the customer's last message · Tickets matching 1 condition")).toBeInTheDocument();
    expect(screen.getByText('Reply to the customer, state Pending (close) for 48 hours')).toBeInTheDocument();
    expect(screen.getByText('When a ticket is created · Every ticket')).toBeInTheDocument();
    expect(await screen.findByText('Move to Billing, add tags vip', undefined, FIND)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the empty state with an Add action', async () => {
    seed([]);
    renderWithProviders(<AutomationRulesPage />);
    expect(await screen.findByText('No automation rules yet', undefined, FIND)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add rule' }).length).toBeGreaterThan(0);
  });

  it('shows the error state when the list fails', async () => {
    seed([]);
    server.use(http.get(`${API}/automation-rules`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderWithProviders(<AutomationRulesPage />);
    expect(await screen.findByText("Couldn't load automation rules", undefined, FIND)).toBeInTheDocument();
  });

  it('hides write controls for a viewer', async () => {
    seed(two, ['automation_rule.view']);
    renderWithProviders(<AutomationRulesPage />);
    await screen.findByText('Nudge quiet customers', undefined, FIND);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Nudge quiet customers' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument();
  });

  it(
    'creates "waiting 2 days -> auto-reply and pending close" with the form body',
    async () => {
      const state = seed([]);
      renderWithProviders(<AutomationRulesPage />);
      await userEvent.click((await screen.findAllByRole('button', { name: 'Add rule' }, FIND))[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Add automation rule' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Close quiet tickets');

      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Trigger' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Time passes' }));
      // Default wait: 2 days since the customer's last message.
      expect(within(dialog).getByRole('spinbutton', { name: 'Wait' })).toHaveValue(2);

      await userEvent.type(within(dialog).getByRole('textbox', { name: 'Send a reply to the customer' }), 'Is there anything else?');
      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Set state' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Pending (close)' }));

      // Pending hours are required once a pending state is chosen.
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      expect(await within(dialog).findByText('Enter how many hours the ticket stays pending.', undefined, FIND)).toBeInTheDocument();
      expect(state.create).toHaveLength(0);

      await userEvent.type(within(dialog).getByRole('spinbutton', { name: /Pending for/ }), '48');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(state.create).toHaveLength(1));
      expect(state.create[0]).toEqual({
        name: 'Close quiet tickets',
        enabled: true,
        trigger: { event: 'time.elapsed', after: 'P2D', since: 'last_customer_message_at' },
        conditions: null,
        actions: { autoReply: 'Is there anything else?', state: 'pending_close', pendingInHours: 48 },
      });
      expect(await screen.findByText('Close quiet tickets', { selector: 'p' }, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'asks for an action and a valid wait before saving',
    async () => {
      const state = seed([]);
      renderWithProviders(<AutomationRulesPage />);
      await userEvent.click((await screen.findAllByRole('button', { name: 'Add rule' }, FIND))[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Add automation rule' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Too quick');
      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Trigger' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Time passes' }));
      const wait = within(dialog).getByRole('spinbutton', { name: 'Wait' });
      await userEvent.clear(wait);
      await userEvent.type(wait, '91');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      expect(await within(dialog).findByText('Choose at least one action.', undefined, FIND)).toBeInTheDocument();
      expect(within(dialog).getByText('Choose a wait between 5 minutes and 90 days.')).toBeInTheDocument();
      expect(state.create).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'puts API field errors on the matching field',
    async () => {
      seed(two);
      server.use(
        http.put(`${API}/automation-rules/:id`, () =>
          HttpResponse.json(
            { error: { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'actions.addTagIds.0', issue: 'invalid_value' }] } },
            { status: 400 },
          ),
        ),
      );
      renderWithProviders(<AutomationRulesPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit VIP to Billing' }, FIND));
      const dialog = await screen.findByRole('dialog', { name: 'Edit automation rule' }, FIND);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      expect(await within(dialog).findByText('Pick one of the available options.', undefined, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it('toggles a rule by PUTting the whole rule with enabled flipped', async () => {
    const state = seed(two);
    renderWithProviders(<AutomationRulesPage />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Enable Nudge quiet customers' }, FIND));
    await waitFor(() => expect(state.update).toHaveLength(1));
    expect(state.updatedIds).toEqual(['rule-1']);
    const rule = two[0]!;
    expect(state.update[0]).toEqual({ name: rule.name, enabled: false, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Nudge quiet customers' })).not.toBeChecked());
  });

  it('deletes a rule after confirming', async () => {
    const state = seed(two);
    renderWithProviders(<AutomationRulesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete VIP to Billing' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Delete VIP to Billing' }, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(state.deleted).toEqual(['rule-2']));
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Enable VIP to Billing' })).not.toBeInTheDocument());
  });
});
