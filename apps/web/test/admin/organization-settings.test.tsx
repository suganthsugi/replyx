import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  return {
    id: 'u1',
    email: 'ada@acme.test',
    name: 'Ada',
    kind: 'staff',
    roles: [],
    permissions,
    groupAccess: [],
    accessVersion: 1,
  };
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
    expect(
      screen.getByRole('heading', { level: 1, name: 'Organization settings' }),
    ).toBeInTheDocument();
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
    // The first render of the page loads MUI and the form on a cold module cache, and axe walks the
    // whole form: this can pass 20 s on a cold or loaded machine (the global timeout is unchanged).
  }, 60_000);

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
    expect(
      screen.queryByText('You can view these settings but not change them.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Organization name/)).not.toBeInTheDocument();

    release();
    expect(await screen.findByLabelText(/Organization name/)).toBeEnabled();
    expect(
      screen.queryByText('You can view these settings but not change them.'),
    ).not.toBeInTheDocument();
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
        return HttpResponse.json({
          ...settings,
          welcomeMessage: 'Hello there',
          brandColors: { primary: '#1d4ed9' },
        });
      }),
    );
    const welcome = await screen.findByLabelText('Welcome message');
    await replaceText(welcome, 'Hello there  ');
    const user = await replaceText(screen.getByLabelText('Primary color'), '#1D4ED9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(body).toEqual({ welcomeMessage: 'Hello there', brandColors: { primary: '#1d4ed9' } }),
    );
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
              details: [
                {
                  path: 'brandColors.primary',
                  issue: 'insufficient_contrast',
                  suggestion: '#767676',
                },
              ],
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

    expect(
      await screen.findByText('#767676 is the closest color that passes.'),
    ).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Use suggested color' }));
    expect(field).toHaveValue('#767676');
  });

  it('shows other field errors from the API on the field', async () => {
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              details: [{ path: 'timezone', issue: 'invalid' }],
            },
          },
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
    expect(
      await screen.findByText('You can view these settings but not change them.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Organization name/)).toBeDisabled();
    expect(screen.getByLabelText('Primary color')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  describe('data retention', () => {
    function confirmationRequired(purgeCount: number) {
      return HttpResponse.json(
        {
          error: {
            code: 'RETENTION_CONFIRMATION_REQUIRED',
            message: 'Confirm',
            details: [{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount }],
          },
        },
        { status: 409 },
      );
    }

    it('shows both periods with readable labels and helper text', async () => {
      renderPage();
      const tickets = await screen.findByLabelText('Keep closed tickets');
      expect(tickets).toHaveValue('forever');
      expect(within(tickets).getByRole('option', { name: 'Forever' })).toBeInTheDocument();
      expect(within(tickets).getByRole('option', { name: '1 year' })).toBeInTheDocument();
      expect(within(tickets).getByRole('option', { name: '7 years' })).toBeInTheDocument();
      expect(tickets).toHaveAccessibleDescription(/deleted daily once they have been closed/);
      const audit = screen.getByLabelText('Keep audit log');
      expect(within(audit).getByRole('option', { name: '10 years' })).toBeInTheDocument();
      expect(within(audit).queryByRole('option', { name: '4 years' })).not.toBeInTheDocument();
      expect(audit).toHaveAccessibleDescription(/at least 1 year/);
    });

    it('saves a lengthened period, or the first save, without a dialog', async () => {
      const bodies: unknown[] = [];
      server.use(
        http.patch(`${API}/settings`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          bodies.push(body);
          return HttpResponse.json({ ...settings, ...body });
        }),
      );
      renderPage();
      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P3Y');
      await user.selectOptions(screen.getByLabelText('Keep audit log'), 'P5Y');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(bodies).toEqual([{ retentionPeriod: 'P3Y', auditRetention: 'P5Y' }]),
      );
      expect((await screen.findAllByText('Organization settings saved')).length).toBeGreaterThan(0);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('asks before deleting, then resends the same patch with the confirmed count', async () => {
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.patch(`${API}/settings`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          bodies.push(body);
          if (body.confirmPurgeCount === undefined) return confirmationRequired(12);
          const { confirmPurgeCount: _confirmed, ...saved } = body;
          return HttpResponse.json({ ...settings, ...saved });
        }),
      );
      renderPage();
      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P1Y');
      const save = screen.getByRole('button', { name: 'Save changes' });
      await user.click(save);

      const dialog = await screen.findByRole('dialog', { name: 'Delete closed tickets?' });
      expect(dialog).toHaveTextContent(
        "Shortening retention permanently deletes at least 12 closed tickets (messages, attachments and history) older than 1 year at the next daily run. This can't be undone.",
      );
      expect(bodies).toEqual([{ retentionPeriod: 'P1Y' }]);
      await expectNoAxeViolations(dialog);
      // Focus is inside the dialog.
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

      await user.click(
        within(dialog).getByRole('button', { name: 'Delete 12 closed tickets and save' }),
      );
      await waitFor(() =>
        expect(bodies).toEqual([
          { retentionPeriod: 'P1Y' },
          { retentionPeriod: 'P1Y', confirmPurgeCount: 12 },
        ]),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect((await screen.findAllByText('Organization settings saved')).length).toBeGreaterThan(0);
      // Save is disabled now, so focus lands on the section heading instead of dropping to the body.
      const heading = screen.getByRole('heading', { level: 2, name: 'Data retention' });
      await waitFor(() => expect(heading).toHaveFocus());
      // ...and stays there once the dialog's exit transition has finished.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(heading).toHaveFocus();
      expect(screen.getByLabelText('Keep closed tickets')).toHaveValue('P1Y');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('saves nothing on cancel, keeps the form dirty and returns focus to Save', async () => {
      const bodies: unknown[] = [];
      server.use(
        http.patch(`${API}/settings`, async ({ request }) => {
          bodies.push(await request.json());
          return confirmationRequired(3);
        }),
      );
      renderPage();
      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P2Y');
      const save = screen.getByRole('button', { name: 'Save changes' });
      await user.click(save);
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('permanently deletes at least 3 closed tickets');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(bodies).toHaveLength(1);
      expect(screen.getByLabelText('Keep closed tickets')).toHaveValue('P2Y');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
      await waitFor(() => expect(save).toHaveFocus());
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'Nothing was deleted or saved.',
      );
    });

    it('asks again when the count changed, and sends the new count once confirmed', async () => {
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.patch(`${API}/settings`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          bodies.push(body);
          if (body.confirmPurgeCount === undefined) return confirmationRequired(1);
          if (body.confirmPurgeCount === 1) return confirmationRequired(5);
          return HttpResponse.json({ ...settings, retentionPeriod: 'P1Y' });
        }),
      );
      renderPage();
      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P1Y');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      let dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('permanently deletes at least 1 closed ticket ');
      await user.click(
        within(dialog).getByRole('button', { name: 'Delete 1 closed ticket and save' }),
      );

      const again = await within(dialog).findByRole('button', {
        name: 'Delete 5 closed tickets and save',
      });
      dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('permanently deletes at least 5 closed tickets');
      expect(dialog).toHaveTextContent('The number changed from 1 since you last looked.');
      expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent('changed to 5');
      expect(bodies).toHaveLength(2);

      await user.click(again);
      await waitFor(() =>
        expect(bodies[2]).toEqual({ retentionPeriod: 'P1Y', confirmPurgeCount: 5 }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('keeps the dialog open and explains a failure while confirming', async () => {
      server.use(
        http.patch(`${API}/settings`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          return body.confirmPurgeCount === undefined
            ? confirmationRequired(2)
            : errorResponse(500, 'INTERNAL', 'Something broke');
        }),
      );
      renderPage();
      const user = userEvent.setup();
      await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P1Y');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Delete 2 closed tickets and save' }),
      );
      expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    describe('audit log', () => {
      function auditConfirmationRequired(purgeCount: number) {
        return HttpResponse.json(
          {
            error: {
              code: 'AUDIT_RETENTION_CONFIRMATION_REQUIRED',
              message: 'Confirm',
              details: [
                { path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount },
              ],
            },
          },
          { status: 409 },
        );
      }

      const settingsWithPeriods: TenantSettings = {
        ...settings,
        retentionPeriod: 'P5Y',
        auditRetention: 'P10Y',
      };

      function renderWithPeriods() {
        server.use(
          http.get(`${API}/me`, () => HttpResponse.json(meWith(EDITOR))),
          http.get(`${API}/settings`, () => HttpResponse.json(settingsWithPeriods)),
        );
        return renderWithProviders(
          <Routes>
            <Route path="/desk/admin/settings" element={<OrganizationSettingsPage />} />
          </Routes>,
          { route: '/desk/admin/settings' },
        );
      }

      it('asks before deleting audit entries, then resends with confirmAuditPurgeCount', async () => {
        const bodies: Record<string, unknown>[] = [];
        server.use(
          http.patch(`${API}/settings`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            bodies.push(body);
            if (body.confirmAuditPurgeCount === undefined) return auditConfirmationRequired(40);
            const { confirmAuditPurgeCount: _confirmed, ...saved } = body;
            return HttpResponse.json({ ...settingsWithPeriods, ...saved });
          }),
        );
        renderWithPeriods();
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Keep audit log'), 'P3Y');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        const dialog = await screen.findByRole('dialog', { name: 'Delete audit log entries?' });
        expect(dialog).toHaveTextContent(
          "Shortening the audit log period permanently deletes at least 40 audit entries older than 3 years at the next daily run. This can't be undone.",
        );
        expect(bodies).toEqual([{ auditRetention: 'P3Y' }]);
        await expectNoAxeViolations(dialog);

        await user.click(
          within(dialog).getByRole('button', { name: 'Delete 40 audit entries and save' }),
        );
        await waitFor(() =>
          expect(bodies).toEqual([
            { auditRetention: 'P3Y' },
            { auditRetention: 'P3Y', confirmAuditPurgeCount: 40 },
          ]),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect((await screen.findAllByText('Organization settings saved')).length).toBeGreaterThan(
          0,
        );
        expect(screen.getByLabelText('Keep audit log')).toHaveValue('P3Y');
      });

      it('asks again with the new count when the audit count went stale', async () => {
        const bodies: Record<string, unknown>[] = [];
        server.use(
          http.patch(`${API}/settings`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            bodies.push(body);
            if (body.confirmAuditPurgeCount === undefined) return auditConfirmationRequired(1);
            if (body.confirmAuditPurgeCount === 1) return auditConfirmationRequired(6);
            return HttpResponse.json({ ...settingsWithPeriods, auditRetention: 'P3Y' });
          }),
        );
        renderWithPeriods();
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Keep audit log'), 'P3Y');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('deletes at least 1 audit entry older');
        await user.click(
          within(dialog).getByRole('button', { name: 'Delete 1 audit entry and save' }),
        );

        const again = await within(dialog).findByRole('button', {
          name: 'Delete 6 audit entries and save',
        });
        expect(screen.getByRole('dialog')).toHaveTextContent('deletes at least 6 audit entries');
        expect(screen.getByRole('dialog')).toHaveTextContent(
          'The number changed from 1 since you last looked.',
        );
        expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent(
          'audit entries to delete changed to 6',
        );

        await user.click(again);
        await waitFor(() =>
          expect(bodies[2]).toEqual({ auditRetention: 'P3Y', confirmAuditPurgeCount: 6 }),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      });

      it('saves nothing when the audit dialog is cancelled', async () => {
        const bodies: unknown[] = [];
        server.use(
          http.patch(`${API}/settings`, async ({ request }) => {
            bodies.push(await request.json());
            return auditConfirmationRequired(9);
          }),
        );
        renderWithPeriods();
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Keep audit log'), 'P2Y');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(bodies).toHaveLength(1);
        expect(screen.getByLabelText('Keep audit log')).toHaveValue('P2Y');
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
      });

      describe('when both periods shorten', () => {
        /** The API asks for the tickets count first, then (once it is confirmed) the audit count. */
        function chainedHandler(bodies: Record<string, unknown>[]) {
          return http.patch(`${API}/settings`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            bodies.push(body);
            if (body.confirmPurgeCount !== 12) return confirmationRequired(12);
            if (body.confirmAuditPurgeCount !== 40) return auditConfirmationRequired(40);
            return HttpResponse.json({
              ...settingsWithPeriods,
              retentionPeriod: 'P1Y',
              auditRetention: 'P3Y',
            });
          });
        }

        async function shortenBoth() {
          renderWithPeriods();
          const user = userEvent.setup();
          await user.selectOptions(await screen.findByLabelText('Keep closed tickets'), 'P1Y');
          await user.selectOptions(screen.getByLabelText('Keep audit log'), 'P3Y');
          await user.click(screen.getByRole('button', { name: 'Save changes' }));
          return user;
        }

        it('walks tickets dialog, then audit dialog, then saves with both counts', async () => {
          const bodies: Record<string, unknown>[] = [];
          server.use(chainedHandler(bodies));
          const user = await shortenBoth();

          const ticketsDialog = await screen.findByRole('dialog', {
            name: 'Delete closed tickets?',
          });
          expect(ticketsDialog).toHaveTextContent('deletes at least 12 closed tickets');
          await user.click(
            within(ticketsDialog).getByRole('button', {
              name: 'Delete 12 closed tickets and save',
            }),
          );

          const auditDialog = await screen.findByRole('dialog', {
            name: 'Delete audit log entries?',
          });
          expect(auditDialog).toHaveTextContent(
            'Shortening the audit log period permanently deletes at least 40 audit entries older than 3 years',
          );
          expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent(
            'Closed tickets confirmed',
          );
          // Nothing has been saved yet (the form sits behind the modal, so it is aria-hidden).
          expect(screen.getByRole('button', { name: 'Save changes', hidden: true })).toBeEnabled();
          await user.click(
            within(auditDialog).getByRole('button', {
              name: 'Delete 40 audit entries and save',
            }),
          );

          await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
          expect(bodies).toEqual([
            { retentionPeriod: 'P1Y', auditRetention: 'P3Y' },
            { retentionPeriod: 'P1Y', auditRetention: 'P3Y', confirmPurgeCount: 12 },
            {
              retentionPeriod: 'P1Y',
              auditRetention: 'P3Y',
              confirmPurgeCount: 12,
              confirmAuditPurgeCount: 40,
            },
          ]);
          expect((await screen.findAllByText('Organization settings saved')).length).toBeGreaterThan(
            0,
          );
        });

        it('saves nothing when the tickets dialog is cancelled', async () => {
          const bodies: Record<string, unknown>[] = [];
          server.use(chainedHandler(bodies));
          const user = await shortenBoth();
          const dialog = await screen.findByRole('dialog', { name: 'Delete closed tickets?' });
          await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
          await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
          expect(bodies).toHaveLength(1);
          expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        });

        it('saves nothing when the audit dialog is cancelled after the tickets confirm', async () => {
          const bodies: Record<string, unknown>[] = [];
          server.use(chainedHandler(bodies));
          const user = await shortenBoth();
          const ticketsDialog = await screen.findByRole('dialog', {
            name: 'Delete closed tickets?',
          });
          await user.click(
            within(ticketsDialog).getByRole('button', {
              name: 'Delete 12 closed tickets and save',
            }),
          );
          const auditDialog = await screen.findByRole('dialog', {
            name: 'Delete audit log entries?',
          });
          await user.click(within(auditDialog).getByRole('button', { name: 'Cancel' }));
          await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
          // Two requests, both refused; none carried the audit confirmation.
          expect(bodies).toHaveLength(2);
          expect(bodies.some((body) => body.confirmAuditPurgeCount !== undefined)).toBe(false);
          expect(screen.getByLabelText('Keep closed tickets')).toHaveValue('P1Y');
          expect(screen.getByLabelText('Keep audit log')).toHaveValue('P3Y');
          expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        });
      });
    });


    it('is read-only without the edit permission', async () => {
      renderPage(['tenant_settings.view']);
      expect(await screen.findByLabelText('Keep closed tickets')).toBeDisabled();
      expect(screen.getByLabelText('Keep audit log')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    });
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
    expect(
      await screen.findByRole('heading', { name: "Couldn't load organization settings" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/Organization name/)).toHaveValue('Acme');
  });
});
