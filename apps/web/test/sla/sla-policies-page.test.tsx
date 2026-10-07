import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import SlaPoliciesPage from '../../src/pages/admin/sla/SlaPoliciesPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { calendarOffice, calendarNight, makeMe, makePolicy } from './fixtures';

import type { BusinessHours, ErrorResponse, Group, ListBusinessHours200, ListSlaPolicies200, SlaPolicy, SlaPolicyInput } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const ALL = ['sla_policy.view', 'sla_policy.create', 'sla_policy.edit', 'sla_policy.delete'];

const groups: Group[] = [
  { id: 'g-billing', name: 'Billing', status: 'active', openTicketCount: 0 },
  { id: 'g-old', name: 'Legacy', status: 'inactive', openTicketCount: 0 },
];

interface State {
  policies: SlaPolicy[];
  calendars: BusinessHours[];
  created: SlaPolicyInput[];
  puts: { id: string; body: SlaPolicyInput }[];
  deleted: string[];
}

function seed(initial: SlaPolicy[], permissions = ALL, calendars: BusinessHours[] = [calendarOffice, calendarNight]): State {
  const state: State = { policies: [...initial], calendars, created: [], puts: [], deleted: [] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))),
    http.get(`${API}/groups`, () => HttpResponse.json<{ items: Group[] }>({ items: groups })),
    http.get(`${API}/sla-policies`, () => HttpResponse.json<ListSlaPolicies200>({ items: state.policies })),
    http.get(`${API}/business-hours`, () => HttpResponse.json<ListBusinessHours200>({ items: state.calendars })),
    http.post(`${API}/sla-policies`, async ({ request }) => {
      const body = (await request.json()) as SlaPolicyInput;
      state.created.push(body);
      const created = makePolicy({ ...(body as Partial<SlaPolicy>), id: `p-${state.policies.length + 1}`, position: state.policies.length });
      state.policies = [...state.policies, created];
      return HttpResponse.json<SlaPolicy>(created, { status: 201 });
    }),
    http.put(`${API}/sla-policies/:id`, async ({ request, params }) => {
      const body = (await request.json()) as SlaPolicyInput;
      const id = params['id'] as string;
      state.puts.push({ id, body });
      state.policies = state.policies.map((policy) => (policy.id === id ? ({ ...policy, ...body }) : policy));
      return HttpResponse.json<SlaPolicy>(state.policies.find((policy) => policy.id === id) ?? state.policies[0]!);
    }),
    http.delete(`${API}/sla-policies/:id`, ({ params }) => {
      state.deleted.push(params['id'] as string);
      state.policies = state.policies.filter((policy) => policy.id !== params['id']);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const urgent = makePolicy({ id: 'p-urgent', name: 'Urgent first response', position: 0, firstResponseMinutes: 15, resolutionMinutes: null });
const normal = makePolicy({
  id: 'p-normal',
  name: 'Everything else',
  position: 1,
  conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['low', 'normal', 'high', 'urgent'] }] },
  firstResponseMinutes: 120,
  resolutionMinutes: 2880,
});
const billing = makePolicy({
  id: 'p-billing',
  name: 'Billing group',
  position: 2,
  conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: ['g-billing'] }] },
  firstResponseMinutes: null,
  nextResponseMinutes: 30,
  resolutionMinutes: null,
});

const three = [urgent, normal, billing];

const order = () =>
  within(screen.getByRole('list', { name: /SLA policies, in evaluation order/ }))
    .getAllByRole('listitem')
    .map((item) => within(item).getByText(/Urgent first response|Everything else|Billing group/).textContent);

describe('SlaPoliciesPage', () => {
  it('lists the policies in evaluation order with conditions, targets and calendar, free of axe violations', async () => {
    seed([billing, urgent, normal]);
    const { container } = renderWithProviders(<SlaPoliciesPage />);
    expect(await screen.findByText('Urgent first response', undefined, FIND)).toBeInTheDocument();
    expect(order()).toEqual(['Urgent first response', 'Everything else', 'Billing group']);
    expect(screen.getByText('Priority is Urgent')).toBeInTheDocument();
    expect(screen.getByText('Every ticket')).toBeInTheDocument();
    expect(await screen.findByText('Group is Billing', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('First response 15m, Office hours hours')).toBeInTheDocument();
    expect(screen.getByText('First response 2h, Resolution 2d, Office hours hours')).toBeInTheDocument();
    expect(screen.getByText('Next response 30m, Office hours hours')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  }, SLOW);

  it('shows the loading status, then the error state with Retry', async () => {
    seed([]);
    let fail = true;
    server.use(http.get<never, never, ListSlaPolicies200 | ErrorResponse>(`${API}/sla-policies`, () => (fail ? errorResponse(500, 'INTERNAL', 'Boom') : HttpResponse.json<ListSlaPolicies200>({ items: [urgent] }))));
    renderWithProviders(<SlaPoliciesPage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load SLA policies", undefined, FIND)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Urgent first response', undefined, FIND)).toBeInTheDocument();
  });

  it('shows the empty state with an Add policy action', async () => {
    seed([]);
    renderWithProviders(<SlaPoliciesPage />);
    expect(await screen.findByText('No SLA policies yet', undefined, FIND)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add policy' }).length).toBeGreaterThan(0);
  });

  it('hides every write control from a viewer and disables reordering', async () => {
    seed(three, ['sla_policy.view']);
    renderWithProviders(<SlaPoliciesPage />);
    await screen.findByText('Urgent first response', undefined, FIND);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Everything else down' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Add policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument();
  });

  it('warns when the calendars or groups cannot be loaded, and still lists the policies', async () => {
    seed(three);
    server.use(http.get(`${API}/business-hours`, () => errorResponse(403, 'FORBIDDEN', 'No')));
    renderWithProviders(<SlaPoliciesPage />);
    expect(await screen.findByText(/Couldn't load the groups or calendars/, undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('Urgent first response')).toBeInTheDocument();
  });

  it(
    'adds a policy: blank targets are null, "every ticket" is sent as all four priorities, and it lands at the end',
    async () => {
      const state = seed([urgent], ALL, [calendarOffice]);
      renderWithProviders(<SlaPoliciesPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }, FIND));
      const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Catch all');
      // The only calendar is preselected.
      expect(within(dialog).getByRole('combobox', { name: /^Calendar/ })).toHaveTextContent('Office hours');
      await userEvent.type(within(dialog).getByRole('spinbutton', { name: /^First response target/ }), '90');
      expect(within(dialog).getByText(/1 hour 30 minutes\./)).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));

      await waitFor(() => expect(state.created).toHaveLength(1));
      expect(state.created[0]).toEqual({
        name: 'Catch all',
        conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['low', 'normal', 'high', 'urgent'] }] },
        businessHoursId: calendarOffice.id,
        firstResponseMinutes: 90,
        nextResponseMinutes: null,
        resolutionMinutes: null,
        warningPercent: 80,
      });
      expect(await screen.findByText('Catch all', { selector: 'p' }, FIND)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add SLA policy' })).not.toBeInTheDocument());
    },
    SLOW,
  );

  it(
    'adds a policy with a priority condition and a chosen calendar',
    async () => {
      const state = seed([], ALL);
      renderWithProviders(<SlaPoliciesPage />);
      await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Urgent only');
      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Priority values' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Urgent' }));
      await userEvent.keyboard('{Escape}');
      await userEvent.click(within(dialog).getByRole('combobox', { name: /^Calendar/ }));
      await userEvent.click(await screen.findByRole('option', { name: 'Night desk' }));
      await userEvent.type(within(dialog).getByRole('spinbutton', { name: /^Resolution target/ }), '480');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));
      await waitFor(() => expect(state.created).toHaveLength(1), FIND);
      expect(state.created[0]).toMatchObject({
        name: 'Urgent only',
        conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['urgent'] }] },
        businessHoursId: calendarNight.id,
        firstResponseMinutes: null,
        resolutionMinutes: 480,
      });
    },
    SLOW,
  );

  it('validates before sending: a missing name, calendar and an out-of-range warning percent block the save', async () => {
    const state = seed([urgent]);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
    const warn = within(dialog).getByRole('spinbutton', { name: /^Warn at/ });
    await userEvent.clear(warn);
    await userEvent.type(warn, '120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a business-hours calendar.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a whole number from 50 to 99.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveFocus();
    expect(warn).toHaveAttribute('aria-invalid', 'true');
    expect(state.created).toHaveLength(0);
  });

  it('shows "Add a business-hours calendar first." when there are no calendars', async () => {
    seed([urgent], ALL, []);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
    expect(await within(dialog).findByText('Add a business-hours calendar first.')).toBeInTheDocument();
  });

  it('maps the API field errors onto the fields and keeps the drawer open', async () => {
    const state = seed([urgent]);
    server.use(
      http.post(`${API}/sla-policies`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              details: [
                { path: 'name', issue: 'too_long' },
                { path: 'conditions.items.0.value', issue: 'invalid_value' },
                { path: 'warningPercent', issue: 'too_big' },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Whatever');
    await userEvent.click(within(dialog).getByRole('combobox', { name: /^Calendar/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Office hours' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));

    expect(await within(dialog).findByText('This is too long.')).toBeInTheDocument();
    expect(within(dialog).getByText('A condition names a group that no longer exists, or one this editor cannot use.')).toBeInTheDocument();
    expect(within(dialog).getByText('This value is too large.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAttribute('aria-invalid', 'true');
    expect(dialog).toBeInTheDocument();
    expect(state.policies).toHaveLength(1);
    const assertive = document.querySelector('[aria-live="assertive"]');
    await waitFor(() => expect(assertive).toHaveTextContent(/The policy was not saved\./));
  }, SLOW);

  it('shows a non-field error in the drawer', async () => {
    seed([urgent]);
    server.use(http.post(`${API}/sla-policies`, () => errorResponse(500, 'INTERNAL', 'Server exploded')));
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add SLA policy' }, FIND);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'X');
    await userEvent.click(within(dialog).getByRole('combobox', { name: /^Calendar/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Office hours' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  }, SLOW);

  it('edits a policy with a replace that keeps its place (no position)', async () => {
    const state = seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Urgent first response' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Edit SLA policy' }, FIND);
    const name = within(dialog).getByRole('textbox', { name: /^Name/ });
    expect(name).toHaveValue('Urgent first response');
    expect(within(dialog).getByRole('spinbutton', { name: /^First response target/ })).toHaveValue(15);
    expect(within(dialog).getByRole('spinbutton', { name: /^Resolution target/ })).toHaveValue(null);
    await userEvent.clear(name);
    await userEvent.type(name, 'Urgent, fast');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.puts).toHaveLength(1), FIND);
    expect(state.puts[0]?.id).toBe('p-urgent');
    expect(state.puts[0]?.body).toMatchObject({ name: 'Urgent, fast', firstResponseMinutes: 15, resolutionMinutes: null, conditions: urgent.conditions });
    expect(state.puts[0]?.body).not.toHaveProperty('position');
    expect(await screen.findByText('Urgent, fast', { selector: 'p' }, FIND)).toBeInTheDocument();
  }, SLOW);

  it('asks before discarding unsaved edits', async () => {
    seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Urgent first response' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Edit SLA policy' }, FIND);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), '!');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit SLA policy' })).not.toBeInTheDocument());
  }, SLOW);

  it('keeps a policy with conditions the form cannot show, and offers to replace them', async () => {
    const custom = makePolicy({ id: 'p-custom', name: 'Custom', conditions: { op: 'or', items: [{ field: 'priority', operator: 'is', value: ['low'] }] } });
    const state = seed([custom]);
    renderWithProviders(<SlaPoliciesPage />);
    expect(await screen.findByText('Custom conditions', undefined, FIND)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Custom' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit SLA policy' }, FIND);
    expect(within(dialog).getByText(/more detailed than this editor can show/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.puts).toHaveLength(1), FIND);
    expect(state.puts[0]?.body.conditions).toEqual(custom.conditions);
  }, SLOW);

  it('asks for confirmation before deleting, then removes the policy', async () => {
    const state = seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Everything else' }, FIND));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Everything else' });
    expect(state.deleted).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete policy' }));
    await waitFor(() => expect(state.deleted).toEqual(['p-normal']));
    await waitFor(() => expect(screen.queryByText('Everything else', { selector: 'p' })).not.toBeInTheDocument());
    expect(order()).toEqual(['Urgent first response', 'Billing group']);
    expect((await screen.findAllByText('Everything else deleted')).length).toBeGreaterThan(0);
  }, SLOW);

  it('cancelling the delete confirmation deletes nothing', async () => {
    const state = seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Everything else' }, FIND));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Everything else' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(state.deleted).toEqual([]);
    expect(order()).toEqual(['Urgent first response', 'Everything else', 'Billing group']);
  });

  it('Move down issues position PUTs for the two policies that changed place and shows the new order', async () => {
    const state = seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Urgent first response down' }, FIND));
    await waitFor(() => expect(state.puts).toHaveLength(2), FIND);
    expect(state.puts.map((put) => [put.id, put.body.position])).toEqual([
      ['p-normal', 0],
      ['p-urgent', 1],
    ]);
    // The rest of the policy is resent unchanged.
    expect(state.puts[1]?.body).toMatchObject({ name: 'Urgent first response', firstResponseMinutes: 15, businessHoursId: calendarOffice.id });
    await waitFor(() => expect(order()).toEqual(['Everything else', 'Urgent first response', 'Billing group']));
  }, SLOW);

  it('Move up on the last policy swaps it with the one above', async () => {
    const state = seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Billing group up' }, FIND));
    await waitFor(() => expect(state.puts).toHaveLength(2), FIND);
    expect(state.puts.map((put) => [put.id, put.body.position])).toEqual([
      ['p-billing', 1],
      ['p-normal', 2],
    ]);
    await waitFor(() => expect(order()).toEqual(['Urgent first response', 'Billing group', 'Everything else']));
  }, SLOW);

  it('cannot move the first policy up or the last one down', async () => {
    seed(three);
    renderWithProviders(<SlaPoliciesPage />);
    expect(await screen.findByRole('button', { name: 'Move Urgent first response up' }, FIND)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Billing group down' })).toBeDisabled();
  });

  it('puts the original order back and says so when saving the order fails', async () => {
    seed(three);
    server.use(http.put(`${API}/sla-policies/:id`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderWithProviders(<SlaPoliciesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Urgent first response down' }, FIND));
    expect((await screen.findAllByText(/The new order was not saved\./, undefined, FIND)).length).toBeGreaterThan(0);
    await waitFor(() => expect(order()).toEqual(['Urgent first response', 'Everything else', 'Billing group']));
  }, SLOW);
});
