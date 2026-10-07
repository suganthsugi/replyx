import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { summarizeIntervals } from '../../src/components/builders/business-hours-summary';
import BusinessHoursPage from '../../src/pages/admin/sla/BusinessHoursPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { calendarNight, calendarOffice, makeMe } from './fixtures';

import type { BusinessHours, BusinessHoursInput, ErrorResponse, ListBusinessHours200 } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;
const ALL = ['sla_policy.view', 'sla_policy.create', 'sla_policy.edit', 'sla_policy.delete'];

interface State {
  calendars: BusinessHours[];
  created: BusinessHoursInput[];
  puts: { id: string; body: BusinessHoursInput }[];
  deleted: string[];
}

function seed(initial: BusinessHours[], permissions = ALL): State {
  const state: State = { calendars: [...initial], created: [], puts: [], deleted: [] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))),
    http.get(`${API}/business-hours`, () => HttpResponse.json<ListBusinessHours200>({ items: state.calendars })),
    http.post(`${API}/business-hours`, async ({ request }) => {
      const body = (await request.json()) as BusinessHoursInput;
      state.created.push(body);
      const created: BusinessHours = { id: `cal-${state.calendars.length + 1}`, name: body.name, timezone: body.timezone, intervals: body.intervals, holidays: body.holidays ?? [] };
      state.calendars = [...state.calendars, created];
      return HttpResponse.json<BusinessHours>(created, { status: 201 });
    }),
    http.put(`${API}/business-hours/:id`, async ({ request, params }) => {
      const body = (await request.json()) as BusinessHoursInput;
      const id = params['id'] as string;
      state.puts.push({ id, body });
      state.calendars = state.calendars.map((calendar) => (calendar.id === id ? { id, name: body.name, timezone: body.timezone, intervals: body.intervals, holidays: body.holidays ?? [] } : calendar));
      return HttpResponse.json<BusinessHours>(state.calendars.find((calendar) => calendar.id === id) ?? state.calendars[0]!);
    }),
    http.delete(`${API}/business-hours/:id`, ({ params }) => {
      state.deleted.push(params['id'] as string);
      state.calendars = state.calendars.filter((calendar) => calendar.id !== params['id']);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const names = () =>
  within(screen.getByRole('list', { name: 'Business-hours calendars' }))
    .getAllByRole('listitem')
    .map((item) => within(item).getByText(/Office hours|Night desk|Weekend cover|Support/).textContent);

describe('BusinessHoursPage', () => {
  it('lists calendars by name with hours, zone and holiday count, free of axe violations', async () => {
    seed([calendarOffice, calendarNight]);
    const { container } = renderWithProviders(<BusinessHoursPage />);
    expect(await screen.findByText('Office hours', { selector: 'p' }, FIND)).toBeInTheDocument();
    expect(names()).toEqual(['Night desk', 'Office hours']);
    expect(screen.getByText(`${summarizeIntervals({ ...calendarOffice.intervals })} (Europe/London)`)).toBeInTheDocument();
    expect(screen.getByText('2 holidays')).toBeInTheDocument();
    expect(screen.getByText('No holidays')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  }, SLOW);

  it('shows loading, then the error state with Retry', async () => {
    let fail = true;
    server.use(http.get<never, never, ListBusinessHours200 | ErrorResponse>(`${API}/business-hours`, () => (fail ? errorResponse(500, 'INTERNAL', 'Boom') : HttpResponse.json<ListBusinessHours200>({ items: [calendarOffice] }))));
    renderWithProviders(<BusinessHoursPage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load business hours", undefined, FIND)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Office hours', { selector: 'p' }, FIND)).toBeInTheDocument();
  });

  it('shows the empty state with an Add calendar action', async () => {
    seed([]);
    renderWithProviders(<BusinessHoursPage />);
    expect(await screen.findByText('No business-hours calendars yet', undefined, FIND)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add calendar' }).length).toBeGreaterThan(0);
  });

  it('hides write controls from a viewer', async () => {
    seed([calendarOffice], ['sla_policy.view']);
    renderWithProviders(<BusinessHoursPage />);
    await screen.findByText('Office hours', { selector: 'p' }, FIND);
    expect(screen.queryByRole('button', { name: 'Add calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument();
  });

  it(
    'adds a calendar through the editor drawer, sending only open days',
    async () => {
      const state = seed([calendarOffice]);
      renderWithProviders(<BusinessHoursPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add calendar' }, FIND));
      const dialog = await screen.findByRole('dialog', { name: 'Add business hours' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Weekend cover');
      await userEvent.click(within(dialog).getByRole('switch', { name: 'Saturday open' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add calendar' }));

      await waitFor(() => expect(state.created).toHaveLength(1), FIND);
      const body = state.created[0]!;
      expect(body.name).toBe('Weekend cover');
      expect(Object.keys(body.intervals).sort()).toEqual(['fri', 'mon', 'sat', 'thu', 'tue', 'wed']);
      expect(body.intervals.sat).toEqual([{ from: '09:00', to: '17:00' }]);
      expect(body.intervals).not.toHaveProperty('sun');
      expect(body.holidays).toEqual([]);
      expect(await screen.findByText('Weekend cover', { selector: 'p' }, FIND)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add business hours' })).not.toBeInTheDocument());
    },
    SLOW,
  );

  it('needs a name', async () => {
    const state = seed([calendarOffice]);
    renderWithProviders(<BusinessHoursPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add calendar' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add business hours' }, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add calendar' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAttribute('aria-invalid', 'true');
    expect(state.created).toHaveLength(0);
  });

  it(
    'edits a calendar: the drawer starts from its values and saves a replace',
    async () => {
      const state = seed([calendarOffice, calendarNight]);
      renderWithProviders(<BusinessHoursPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Office hours' }, FIND));
      const dialog = await screen.findByRole('dialog', { name: 'Edit business hours' }, FIND);
      const name = within(dialog).getByRole('textbox', { name: /^Name/ });
      expect(name).toHaveValue('Office hours');
      expect(within(dialog).getByRole('switch', { name: 'Monday open' })).toBeChecked();
      expect(within(dialog).getByRole('switch', { name: 'Saturday open' })).not.toBeChecked();
      await userEvent.clear(name);
      await userEvent.type(name, 'Support');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(state.puts).toHaveLength(1), FIND);
      expect(state.puts[0]?.id).toBe('cal-office');
      expect(state.puts[0]?.body).toMatchObject({ name: 'Support', timezone: 'Europe/London', holidays: ['2026-12-25', '2026-12-26'] });
      expect(await screen.findByText('Support', { selector: 'p' }, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it('puts a taken name on the name field and keeps the drawer open', async () => {
    seed([calendarOffice]);
    server.use(http.post(`${API}/business-hours`, () => errorResponse(409, 'BUSINESS_HOURS_NAME_TAKEN', 'Name taken')));
    renderWithProviders(<BusinessHoursPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add calendar' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add business hours' }, FIND);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Office hours');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add calendar' }));
    const field = within(dialog).getByRole('textbox', { name: /^Name/ });
    expect(await within(dialog).findByText('Another calendar already has this name. Choose a different one.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveFocus();
    expect(dialog).toBeInTheDocument();
  }, SLOW);

  it('maps API validation details onto the zone and schedule', async () => {
    seed([calendarOffice]);
    server.use(
      http.post(`${API}/business-hours`, () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: [{ path: 'timezone', issue: 'invalid_value' }] } },
          { status: 400 },
        ),
      ),
    );
    renderWithProviders(<BusinessHoursPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add calendar' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Add business hours' }, FIND);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Zoned');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add calendar' }));
    expect(await within(dialog).findByText('Choose a time zone from the list.')).toBeInTheDocument();
  }, SLOW);

  it('confirms before deleting, then removes the calendar', async () => {
    const state = seed([calendarOffice, calendarNight]);
    renderWithProviders(<BusinessHoursPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Night desk' }, FIND));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Night desk' });
    expect(state.deleted).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete calendar' }));
    await waitFor(() => expect(state.deleted).toEqual(['cal-night']));
    await waitFor(() => expect(screen.queryByText('Night desk', { selector: 'p' })).not.toBeInTheDocument());
    expect((await screen.findAllByText('Night desk deleted')).length).toBeGreaterThan(0);
  }, SLOW);

  it('explains a calendar that is still in use, and keeps it', async () => {
    seed([calendarOffice]);
    server.use(http.delete(`${API}/business-hours/:id`, () => errorResponse(409, 'IN_USE', 'Referenced by sla_policy')));
    renderWithProviders(<BusinessHoursPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Office hours' }, FIND));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Office hours' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete calendar' }));
    expect(await within(confirm).findByText(/still used by an SLA policy or by the workspace settings/)).toBeInTheDocument();
    expect(screen.getByText('Office hours', { selector: 'p' })).toBeInTheDocument();
  }, SLOW);
});
