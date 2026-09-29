import { fireEvent, screen, waitFor } from '@testing-library/react';
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

/** Records each announcement the polite live region receives (every one replaces the region's span). */
function watchPoliteAnnouncements(): { texts: string[]; stop: () => void } {
  const region = document.querySelector('[aria-live="polite"]');
  if (region === null) throw new Error('no polite live region');
  const texts: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        const text = node.textContent ?? '';
        if (text !== '') texts.push(text);
      });
    }
  });
  observer.observe(region, { childList: true, subtree: true });
  return { texts, stop: () => observer.disconnect() };
}

const ENOUGH = 'This color has enough contrast with white text.';
const NOT_ENOUGH = 'This color does not have enough contrast with white text.';

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

  it('announces the contrast verdict once per flip: pass, fail, pass', async () => {
    renderPage();
    const field = await screen.findByLabelText('Primary color');
    const announcements = watchPoliteAnnouncements();

    const user = await replaceText(field, '#aaaaaa');
    await waitFor(() => expect(announcements.texts).toEqual([NOT_ENOUGH]));

    await user.click(screen.getByRole('button', { name: 'Use suggested color' }));
    await waitFor(() => expect(announcements.texts).toEqual([NOT_ENOUGH, ENOUGH]));
    announcements.stop();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(ENOUGH);
  });

  it('does not announce when typing leaves the contrast verdict unchanged', async () => {
    renderPage();
    const field = await screen.findByLabelText('Primary color');
    const announcements = watchPoliteAnnouncements();

    // A pass stays a pass, including through the half-typed values in between.
    await replaceText(field, '#1d4ed9');
    expect(screen.getByText('Passes AA')).toBeInTheDocument();
    expect(announcements.texts).toEqual([]);

    // A fail stays a fail across further edits: one announcement, for the flip itself.
    await replaceText(field, '#aaaaaa');
    await replaceText(field, '#bbbbbb');
    fireEvent.change(field, { target: { value: '#cccccc' } });
    expect(screen.getByText('Fails AA')).toBeInTheDocument();
    await waitFor(() => expect(announcements.texts).toEqual([NOT_ENOUGH]));
    announcements.stop();
  });

  it('shows a failing color as a visible warning without a second alert announcement', async () => {
    renderPage();
    await replaceText(await screen.findByLabelText('Primary color'), '#aaaaaa');
    expect(screen.getByRole('note')).toHaveTextContent(/is the closest color that passes/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the loading skeleton, not a read-only form, until the permissions have loaded', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API}/me`, async () => {
        await gate;
        return HttpResponse.json(meWith(EDITOR));
      }),
      http.get(`${API}/settings`, () => HttpResponse.json(settings)),
    );
    renderWithProviders(
      <Routes>
        <Route path="/desk/admin/settings" element={<OrganizationSettingsPage />} />
      </Routes>,
      { route: '/desk/admin/settings' },
    );
    // Give the settings request time to settle while /me is still pending.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByRole('status')).toHaveTextContent(/Loading organization settings/);
    expect(screen.queryByText('You can view these settings but not change them.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Organization name/)).not.toBeInTheDocument();

    release();
    expect(await screen.findByLabelText(/Organization name/)).toBeEnabled();
    expect(screen.queryByText('You can view these settings but not change them.')).not.toBeInTheDocument();
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

  it('is not dirty again after the API normalizes what was sent', async () => {
    let body: unknown;
    renderPage();
    server.use(
      http.patch(`${API}/settings`, async ({ request }) => {
        body = await request.json();
        // The API trims the message; the color comes back as sent (lower-case).
        return HttpResponse.json({ ...settings, welcomeMessage: 'Hello there', brandColors: { primary: '#1d4ed9' } });
      }),
    );
    const welcome = await screen.findByLabelText('Welcome message');
    await replaceText(welcome, 'Hello there  ');
    const user = await replaceText(screen.getByLabelText('Primary color'), '#1D4ED9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(body).toEqual({ welcomeMessage: 'Hello there', brandColors: { primary: '#1d4ed9' } }));
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
          { error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: [{ path: 'timezone', issue: 'invalid' }] } },
          { status: 400 },
        ),
      ),
    );
    renderPage();
    const user = await replaceText(await screen.findByLabelText(/Organization name/), 'Acme Two');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    // `invalid` is the API's code for a custom refine, such as an unknown time zone.
    expect(await screen.findByText('This value is not valid')).toBeInTheDocument();
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
