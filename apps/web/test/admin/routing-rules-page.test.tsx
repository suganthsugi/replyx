import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import RoutingRulesPage from '../../src/pages/admin/routing/RoutingRulesPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { groupsFixture, makeDryRun, makeRoutingRule, tagsFixture } from './routing-fixtures';

import type { Group, ListRoutingRules200, Me, RoutingDryRun, RoutingRule, RoutingRuleInput, TagRef } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const ALL = ['routing_rule.view', 'routing_rule.create', 'routing_rule.edit', 'routing_rule.delete'];

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

function seed(initial: RoutingRule[], permissions = ALL) {
  const state = { rules: [...initial], bodies: { create: [] as unknown[], update: [] as unknown[], order: [] as unknown[], test: [] as unknown[] }, deleted: [] as string[], updatedIds: [] as string[] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me(permissions))),
    http.get(`${API}/groups`, () =>
      HttpResponse.json<{ items: Group[] }>({
        items: groupsFixture.map((g) => ({ id: g.id, name: g.name, status: g.active ? 'active' : 'inactive', openTicketCount: 0 })),
      }),
    ),
    http.get(`${API}/tags`, () => HttpResponse.json<{ items: TagRef[] }>({ items: tagsFixture })),
    http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: state.rules })),
    http.post(`${API}/routing-rules`, async ({ request }) => {
      const body = (await request.json()) as RoutingRuleInput;
      state.bodies.create.push(body);
      const created = makeRoutingRule({ ...body, id: `rule-${state.rules.length + 1}`, position: state.rules.length });
      state.rules = [...state.rules, created];
      return HttpResponse.json<RoutingRule>(created, { status: 201 });
    }),
    http.put(`${API}/routing-rules/order`, async ({ request }) => {
      const body = (await request.json()) as { ids: string[] };
      state.bodies.order.push(body);
      state.rules = body.ids.map((id, position) => ({ ...state.rules.find((r) => r.id === id)!, position }));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/routing-rules/test`, async ({ request }) => {
      state.bodies.test.push(await request.json());
      return HttpResponse.json<RoutingDryRun>(
        makeDryRun({ matchedRuleId: 'rule-1', matchedRuleName: 'Refunds to Billing', actions: { groupId: 'group-billing', priority: 'high' } }),
      );
    }),
    http.put(`${API}/routing-rules/:id`, async ({ request, params }) => {
      const body = (await request.json()) as RoutingRuleInput;
      state.bodies.update.push(body);
      state.updatedIds.push(params.id as string);
      state.rules = state.rules.map((r) => (r.id === params.id ? { ...r, ...body } : r));
      return HttpResponse.json<RoutingRule>(state.rules.find((r) => r.id === params.id) ?? state.rules[0]!);
    }),
    http.delete(`${API}/routing-rules/:id`, ({ params }) => {
      state.deleted.push(params.id as string);
      state.rules = state.rules.filter((r) => r.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const two = [
  makeRoutingRule({ id: 'rule-1', name: 'Refunds to Billing', position: 0 }),
  makeRoutingRule({ id: 'rule-2', name: 'VIP to Support', position: 1, conditions: { customerTagIds: ['tag-vip'] }, actions: { groupId: 'group-support' } }),
];

const order = () =>
  within(screen.getByRole('list', { name: /Routing rules/ }))
    .getAllByRole('switch')
    .map((s) => s.getAttribute('aria-label'));

describe('RoutingRulesPage', () => {
  it('lists the rules with group and tag names and is free of axe violations', async () => {
    seed(two);
    const { container } = renderWithProviders(<RoutingRulesPage />);
    expect(await screen.findByText('Refunds to Billing', undefined, FIND)).toBeInTheDocument();
    expect(await screen.findByText('Assign to Billing, priority High, tags vip', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('Assign to Support')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the error state when the list fails', async () => {
    seed([]);
    server.use(http.get(`${API}/routing-rules`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderWithProviders(<RoutingRulesPage />);
    expect(await screen.findByText("Couldn't load routing rules", undefined, FIND)).toBeInTheDocument();
  });

  it('hides write controls for a viewer', async () => {
    seed(two, ['routing_rule.view']);
    renderWithProviders(<RoutingRulesPage />);
    await screen.findByText('Refunds to Billing', undefined, FIND);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Refunds to Billing' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument();
  });

  it(
    'creates a rule with the form body',
    async () => {
      const state = seed(two);
      renderWithProviders(<RoutingRulesPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add rule' }, FIND));
      const dialog = await screen.findByRole('dialog', { name: 'Add routing rule' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'New rule');
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'First message contains any of' }), 'invoice{Enter}');
      await userEvent.click(within(dialog).getByRole('combobox', { name: /Assign to group/ }));
      await userEvent.click(await screen.findByRole('option', { name: 'Billing' }, FIND));
      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Set priority' }));
      await userEvent.click(await screen.findByRole('option', { name: 'High' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(state.bodies.create).toHaveLength(1));
      expect(state.bodies.create[0]).toEqual({
        name: 'New rule',
        enabled: true,
        conditions: { messageContainsAny: ['invoice'] },
        actions: { groupId: 'group-billing', priority: 'high' },
      });
      expect(await screen.findByText('New rule', { selector: 'p' }, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it('sends the new order as { ids } and shows it', async () => {
    const state = seed(two);
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Refunds to Billing down' }, FIND));
    await waitFor(() => expect(state.bodies.order).toEqual([{ ids: ['rule-2', 'rule-1'] }]));
    await waitFor(() => expect(order()).toEqual(['Enable VIP to Support', 'Enable Refunds to Billing']));
  });

  it('puts the original order back when the reorder is refused', async () => {
    seed(two);
    server.use(http.put(`${API}/routing-rules/order`, () => errorResponse(400, 'VALIDATION_FAILED', 'Stale list')));
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Refunds to Billing down' }, FIND));
    expect((await screen.findAllByText(/The new order was not saved\./, undefined, FIND)).length).toBeGreaterThan(0);
    await waitFor(() => expect(order()).toEqual(['Enable Refunds to Billing', 'Enable VIP to Support']));
  });

  it('toggles a rule by PUTting the whole rule with enabled flipped', async () => {
    const state = seed(two);
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Enable Refunds to Billing' }, FIND));
    await waitFor(() => expect(state.bodies.update).toHaveLength(1));
    expect(state.updatedIds).toEqual(['rule-1']);
    expect(state.bodies.update[0]).toEqual({ name: 'Refunds to Billing', enabled: false, conditions: two[0]!.conditions, actions: two[0]!.actions });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Refunds to Billing' })).not.toBeChecked());
  });

  it('rolls the switch back when the toggle is refused', async () => {
    seed(two);
    server.use(http.put(`${API}/routing-rules/:id`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Enable Refunds to Billing' }, FIND));
    expect((await screen.findAllByText(/Refunds to Billing was not changed\./, undefined, FIND)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Refunds to Billing' })).toBeChecked());
  });

  it('deletes a rule after confirming', async () => {
    const state = seed(two);
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete VIP to Support' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Delete VIP to Support' }, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(state.deleted).toEqual(['rule-2']));
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Enable VIP to Support' })).not.toBeInTheDocument());
  });

  it('runs a dry run with the sample message, email and tags', async () => {
    const state = seed(two);
    renderWithProviders(<RoutingRulesPage />);
    await userEvent.type(await screen.findByRole('textbox', { name: /^Message/ }, FIND), 'I want a refund');
    await userEvent.type(screen.getByRole('textbox', { name: /^Customer email/ }), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(state.bodies.test).toEqual([{ message: 'I want a refund', customerEmail: 'a@b.com' }]));
    expect(await screen.findByRole('group', { name: 'Test result' }, FIND)).toHaveTextContent('Matches rule 1: Refunds to Billing -> Billing (high)');
  });
});
