import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import OrganizationSettingsPage from '../../src/pages/admin/settings/OrganizationSettingsPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { calendarNight, calendarOffice, makeMe } from './fixtures';

import type { ListBusinessHours200, TenantSettings } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const baseSettings: TenantSettings = {
  name: 'Acme',
  logoAttachmentId: null,
  brandColors: { primary: '#1d4ed8' },
  welcomeMessage: null,
  timezone: 'Europe/London',
  selfRegistration: true,
  gracePeriodHours: 72,
  afterCloseBehavior: 'new_follow_up',
  offlineCustomerNotification: 'email',
  outOfHoursMessage: 'We are away.',
  businessHoursId: null,
  retentionPeriod: 'forever',
  auditRetention: 'forever',
};

const EDITOR = ['tenant_settings.view', 'tenant_settings.edit', 'sla_policy.view'];

interface Options {
  settings?: Partial<TenantSettings>;
  permissions?: string[];
  calendars?: ListBusinessHours200 | 'error' | 'slow';
}

function renderPage({ settings = {}, permissions = EDITOR, calendars = { items: [calendarOffice, calendarNight] } }: Options = {}) {
  const patches: unknown[] = [];
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))),
    http.get(`${API}/settings`, () => HttpResponse.json({ ...baseSettings, ...settings })),
    http.get(`${API}/business-hours`, () => (calendars === 'error' ? errorResponse(403, 'FORBIDDEN', 'Not allowed') : HttpResponse.json(calendars === 'slow' ? { items: [] } : calendars))),
    http.patch(`${API}/settings`, async ({ request }) => {
      const body = (await request.json()) as Partial<TenantSettings>;
      patches.push(body);
      return HttpResponse.json({ ...baseSettings, ...settings, ...body });
    }),
  );
  const view = renderWithProviders(
    <Routes>
      <Route path="/desk/admin/settings" element={<OrganizationSettingsPage />} />
      <Route path="/desk/admin/business-hours" element={<p>Business hours page</p>} />
    </Routes>,
    { route: '/desk/admin/settings' },
  );
  return { patches, ...view };
}

const select = () => screen.findByRole('combobox', { name: 'Business hours' }, FIND);

describe('OrganizationSettingsPage business hours', () => {
  it('offers None and every calendar, with the saved choice selected, and is free of axe violations', async () => {
    const { container } = renderPage({ settings: { businessHoursId: calendarNight.id } });
    const field = await select();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
    expect(within(field).getAllByRole('option').map((option) => option.textContent)).toEqual(['None', 'Night desk', 'Office hours']);
    expect(field).toHaveValue(calendarNight.id);
    expect(screen.getByText(/The out-of-hours message above shows outside these hours/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  }, SLOW);

  it('sends nothing for the calendar when it did not change', async () => {
    const { patches } = renderPage({ settings: { businessHoursId: calendarOffice.id } });
    const field = await select();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
    const message = screen.getByLabelText(/Out-of-hours message/);
    await userEvent.clear(message);
    await userEvent.type(message, 'Back Monday');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1), FIND);
    expect(patches[0]).toEqual({ outOfHoursMessage: 'Back Monday' });
  }, SLOW);

  it('PATCHes the chosen calendar id', async () => {
    const { patches } = renderPage();
    const field = await select();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
    await userEvent.selectOptions(field, 'Office hours');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1), FIND);
    expect(patches[0]).toEqual({ businessHoursId: calendarOffice.id });
  }, SLOW);

  it('PATCHes null when None is chosen', async () => {
    const { patches } = renderPage({ settings: { businessHoursId: calendarOffice.id } });
    const field = await select();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
    await userEvent.selectOptions(field, 'None');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1), FIND);
    expect(patches[0]).toEqual({ businessHoursId: null });
  }, SLOW);

  it('links to Business hours when there are no calendars yet', async () => {
    renderPage({ calendars: { items: [] } });
    const link = await screen.findByRole('link', { name: 'Add one under Admin, Business hours' }, FIND);
    expect(link).toHaveAttribute('href', '/desk/admin/business-hours');
    expect(await select()).toBeEnabled();
  });

  it('is disabled with a note when the calendars cannot be listed, and keeps the saved one as "Current calendar"', async () => {
    const { patches } = renderPage({ calendars: 'error', permissions: ['tenant_settings.view', 'tenant_settings.edit'], settings: { businessHoursId: calendarOffice.id } });
    const field = await select();
    expect(await screen.findByText(/Business hours can't be listed with your permissions/, undefined, FIND)).toBeInTheDocument();
    expect(field).toBeDisabled();
    expect(field).toHaveValue(calendarOffice.id);
    expect(within(field).getByRole('option', { name: 'Current calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add one under Admin/ })).not.toBeInTheDocument();
    // The rest of the form still saves, without touching the calendar.
    await userEvent.type(screen.getByLabelText(/Out-of-hours message/), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1), FIND);
    expect(patches[0]).toEqual({ outOfHoursMessage: 'We are away.!' });
  }, SLOW);

  it('is disabled while the calendars load', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPage();
    server.use(
      http.get(`${API}/business-hours`, async () => {
        await gate;
        return HttpResponse.json<ListBusinessHours200>({ items: [calendarOffice] });
      }),
    );
    const field = await select();
    expect(field).toBeDisabled();
    expect(screen.getByText('Loading business hours…')).toBeInTheDocument();
    release();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
  }, SLOW);

  it('is read-only without tenant_settings.edit', async () => {
    renderPage({ permissions: ['tenant_settings.view', 'sla_policy.view'] });
    const field = await select();
    await waitFor(() => expect(screen.getByText('You can view these settings but not change them.')).toBeInTheDocument(), FIND);
    expect(field).toBeDisabled();
  }, SLOW);

  it('shows the API error when the calendar is refused', async () => {
    renderPage();
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: [{ path: 'businessHoursId', issue: 'invalid_value' }] } },
          { status: 400 },
        ),
      ),
    );
    const field = await select();
    await waitFor(() => expect(field).toBeEnabled(), FIND);
    await userEvent.selectOptions(field, 'Night desk');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'), FIND);
    expect(field).toHaveAccessibleDescription('Choose one of the allowed values');
  }, SLOW);
});
