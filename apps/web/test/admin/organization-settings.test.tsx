import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import OrganizationSettingsPage from '../../src/pages/admin/settings/OrganizationSettingsPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Me, TenantSettings } from '../../src/api/generated/model';

/**
 * Organization settings (T187, FR-005): the form shows the saved values, checks the brand color's
 * contrast live and offers a passing shade, sends only changed fields, shows the API's field
 * errors, and is read-only without `tenant_settings.edit`.
 */

const settings: TenantSettings = {
  name: 'Acme',
  logoAttachmentId: null,
  brandColors: { primary: '#1d4ed8' },
  welcomeMessage: 'Welcome to Acme',
  timezone: 'Europe/London',
  selfRegistration: true,
  gracePeriodHours: 72,
  afterCloseBehavior: 'new_follow_up',
  offlineCustomerNotification: 'email',
  outOfHoursMessage: null,
  retentionPeriod: 'forever',
  auditRetention: 'forever',
};

function meWith(permissions: string[]): Me {
  return { id: 'u1', email: 'ada@acme.test', name: 'Ada', kind: 'staff', roles: [], permissions, groupAccess: [], accessVersion: 1 };
}

const EDITOR = ['tenant_settings.view', 'tenant_settings.edit'];

function renderPage(permissions: string[] = EDITOR) {
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(meWith(permissions))),
    http.get(`${API}/settings`, () => HttpResponse.json(settings)),
  );
  return renderWithProviders(
    <Routes>
      <Route path="/desk/admin/settings" element={<OrganizationSettingsPage />} />
    </Routes>,
    { route: '/desk/admin/settings' },
  );
}

async function replaceText(field: HTMLElement, text: string) {
  const user = userEvent.setup();
  await user.clear(field);
  if (text !== '') await user.type(field, text);
  return user;
}

describe('OrganizationSettingsPage', () => {
  it('shows the saved values with a passing contrast check and no axe violations', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Organization settings' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Organization name/)).toHaveValue('Acme');
    expect(screen.getByLabelText('Primary color')).toHaveValue('#1d4ed8');
    expect(screen.getByLabelText('Welcome message')).toHaveValue('Welcome to Acme');
    expect(screen.getByLabelText('Time zone')).toHaveValue('Europe/London');
    expect(screen.getByLabelText('Grace period (hours)')).toHaveValue(72);
    expect(screen.getByRole('switch', { name: 'Let customers sign up themselves' })).toBeChecked();
    expect(screen.getByText('Passes AA')).toBeInTheDocument();
    expect(screen.getByText(/Contrast \d+\.\d\d:1 with white text/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await expectNoAxeViolations(container);
  });

  it('flags a failing color as it is typed and offers the closest passing shade', async () => {
    renderPage();
    const field = await screen.findByLabelText('Primary color');
    const user = await replaceText(field, '#aaaaaa');
    expect(screen.getByText('Fails AA')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/is the closest color that passes/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use suggested color' }));
    expect(screen.getByText('Passes AA')).toBeInTheDocument();
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
    expect((field as HTMLInputElement).value).not.toBe('#aaaaaa');
  });

  it('rejects a color that is not a six-digit hex and blocks saving', async () => {
    renderPage();
    const field = await screen.findByLabelText('Primary color');
    await replaceText(field, '#12');
    expect(screen.getByText('Use a six-digit hex color like #1D4ED8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('sends only the changed fields and confirms the save', async () => {
    let body: unknown;
    renderPage();
    server.use(
      http.patch(`${API}/settings`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...settings, name: 'Acme Inc', gracePeriodHours: 48 });
      }),
    );
    const name = await screen.findByLabelText(/Organization name/);
    const user = await replaceText(name, 'Acme Inc');
    await user.clear(screen.getByLabelText('Grace period (hours)'));
    await user.type(screen.getByLabelText('Grace period (hours)'), '48');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(body).toEqual({ name: 'Acme Inc', gracePeriodHours: 48 }));
    expect((await screen.findAllByText('Organization settings saved')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('clears the welcome message by sending null', async () => {
    let body: unknown;
    renderPage();
    server.use(
      http.patch(`${API}/settings`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...settings, welcomeMessage: null });
      }),
    );
    const user = await replaceText(await screen.findByLabelText('Welcome message'), '');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toEqual({ welcomeMessage: null }));
  });

  it('checks the grace period range before saving', async () => {
    renderPage();
    await replaceText(await screen.findByLabelText('Grace period (hours)'), '721');
    expect(screen.getByText('Enter a whole number of hours from 1 to 720')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it("shows the API's contrast error and its suggested color, and applies it", async () => {
    // The API stays the authority: it may disagree with the live check by a rounding step.
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              details: [{ path: 'brandColors.primary', issue: 'insufficient_contrast', suggestion: '#767676' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderPage();
    const field = await screen.findByLabelText('Primary color');
    const user = await replaceText(field, '#777777');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('#767676 is the closest color that passes.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Use suggested color' }));
    expect(field).toHaveValue('#767676');
  });

  it('shows other field errors from the API on the field', async () => {
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: [{ path: 'timezone', issue: 'invalid_timezone' }] } },
          { status: 400 },
        ),
      ),
    );
    renderPage();
    const user = await replaceText(await screen.findByLabelText(/Organization name/), 'Acme Two');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Choose a valid time zone')).toBeInTheDocument();
    expect(screen.getByLabelText('Time zone')).toBeInvalid();
  });

  it('is read-only without the edit permission', async () => {
    renderPage(['tenant_settings.view']);
    expect(await screen.findByText('You can view these settings but not change them.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Organization name/)).toBeDisabled();
    expect(screen.getByLabelText('Primary color')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('explains a load failure and retries', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/me`, () => HttpResponse.json(meWith(EDITOR))),
      http.get(`${API}/settings`, () => {
        calls += 1;
        return calls === 1 ? errorResponse(500, 'INTERNAL', 'boom') : HttpResponse.json(settings);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/desk/admin/settings" element={<OrganizationSettingsPage />} />
      </Routes>,
      { route: '/desk/admin/settings' },
    );
    expect(await screen.findByRole('heading', { name: "Couldn't load organization settings" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/Organization name/)).toHaveValue('Acme');
  });
});
