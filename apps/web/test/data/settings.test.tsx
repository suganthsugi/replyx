import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { brandingKeys } from '../../src/data/branding';
import { mapError } from '../../src/data/errors';
import { settingsKeys, useTenantSettings, useUpdateTenantSettings } from '../../src/data/settings';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { ErrorResponse, TenantSettings } from '../../src/api/generated/model';

/**
 * `settings.ts`: the organization settings load, the PATCH cache write and branding invalidation
 * (FR-005), and the contrast validation error surfaced through `mapError`.
 */

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    name: 'Acme',
    logoAttachmentId: null,
    brandColors: { primary: '#123456', accent: '#abcdef' },
    welcomeMessage: 'Welcome!',
    timezone: 'Europe/London',
    selfRegistration: true,
    gracePeriodHours: 24,
    afterCloseBehavior: 'new_follow_up',
    offlineCustomerNotification: 'email',
    outOfHoursMessage: 'We are away.',
    retentionPeriod: 'forever',
    auditRetention: 'forever',
    ...overrides,
  };
}

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

describe('useTenantSettings', () => {
  it('loads the tenant settings', async () => {
    server.use(http.get(`${API}/settings`, () => HttpResponse.json(makeSettings())));

    const { result } = renderWithClient(() => useTenantSettings());

    await waitFor(() => expect(result.current.data).toEqual(makeSettings()));
    expect(result.current.error).toBeUndefined();
  });
});

describe('useUpdateTenantSettings', () => {
  it('writes the response into the settings cache and invalidates branding', async () => {
    const updated = makeSettings({ name: 'New name' });
    server.use(http.patch(`${API}/settings`, () => HttpResponse.json(updated)));

    const { result, queryClient } = renderWithClient(() => useUpdateTenantSettings());
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await result.current.mutateAsync({ name: 'New name' });

    expect(queryClient.getQueryData(settingsKeys.all)).toEqual(updated);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: brandingKeys.all });
  });

  it('exposes the contrast suggestion for an insufficient_contrast brandColors.primary error', async () => {
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json<ErrorResponse>(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              details: [{ path: 'brandColors.primary', issue: 'insufficient_contrast', suggestion: '#0b5fa5' }],
            },
          },
          { status: 400 },
        ),
      ),
    );

    const { result } = renderWithClient(() => useUpdateTenantSettings());

    let caught: unknown;
    try {
      await result.current.mutateAsync({ brandColors: { primary: '#ffee00' } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeTruthy();
    // The raw error is thrown for the form's `mapError` to read (data-hooks rule 6); the shape
    // it produces is what the page reads its "use suggested color" action from.
    const mapped = mapError(caught);
    expect(mapped.code).toBe('VALIDATION_FAILED');
    expect(mapped.fieldErrors?.['brandColors.primary']).toBe('insufficient_contrast');
    expect(mapped.fieldSuggestions?.['brandColors.primary']).toBe('#0b5fa5');
  });

  it('maps other validation field errors without a suggestion', async () => {
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json<ErrorResponse>(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              details: [{ path: 'gracePeriodHours', issue: 'too_large' }],
            },
          },
          { status: 400 },
        ),
      ),
    );

    const { result } = renderWithClient(() => useUpdateTenantSettings());

    let caught: unknown;
    try {
      await result.current.mutateAsync({ gracePeriodHours: 10_000 });
    } catch (error) {
      caught = error;
    }

    const mapped = mapError(caught);
    expect(mapped.fieldErrors?.gracePeriodHours).toBe('too_large');
    expect(mapped.fieldSuggestions).toBeUndefined();
  });
});


describe('retention confirmation', () => {
  it('maps RETENTION_CONFIRMATION_REQUIRED to retentionConfirmation and surfaces a new count on a stale retry', async () => {
    const counts = [7, 9];
    let call = 0;
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json<ErrorResponse>(
          {
            error: {
              code: 'RETENTION_CONFIRMATION_REQUIRED',
              message: 'Confirm',
              details: [{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount: counts[call++] }],
            },
          },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderWithClient(() => useUpdateTenantSettings());

    const attempt = async (data: Parameters<typeof result.current.mutateAsync>[0]) => {
      try {
        await result.current.mutateAsync(data);
      } catch (error) {
        return mapError(error);
      }
      return undefined;
    };

    const first = await attempt({ retentionPeriod: 'P1Y' });
    expect(first?.retentionConfirmation).toEqual({ purgeCount: 7 });
    const retry = await attempt({ retentionPeriod: 'P1Y', confirmPurgeCount: 7 });
    expect(retry?.retentionConfirmation).toEqual({ purgeCount: 9 });
  });

  it('maps AUDIT_RETENTION_CONFIRMATION_REQUIRED to auditRetentionConfirmation, and a stale retry to a fresh count', async () => {
    const counts = [30, 44];
    let call = 0;
    server.use(
      http.patch(`${API}/settings`, () =>
        HttpResponse.json<ErrorResponse>(
          {
            error: {
              code: 'AUDIT_RETENTION_CONFIRMATION_REQUIRED',
              message: 'Confirm',
              details: [{ path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount: counts[call++] }],
            },
          },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderWithClient(() => useUpdateTenantSettings());

    const attempt = async (data: Parameters<typeof result.current.mutateAsync>[0]) => {
      try {
        await result.current.mutateAsync(data);
      } catch (error) {
        return mapError(error);
      }
      return undefined;
    };

    const first = await attempt({ auditRetention: 'P1Y' });
    expect(first?.auditRetentionConfirmation).toEqual({ purgeCount: 30 });
    expect(first?.retentionConfirmation).toBeUndefined();
    const retry = await attempt({ auditRetention: 'P1Y', confirmAuditPurgeCount: 30 });
    expect(retry?.auditRetentionConfirmation).toEqual({ purgeCount: 44 });
  });

  it('keeps the two confirmations apart and ignores a detail on the wrong path', () => {
    const wrongPath = mapError({
      error: {
        code: 'AUDIT_RETENTION_CONFIRMATION_REQUIRED',
        message: 'Confirm',
        details: [{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount: 3 }],
      },
    });
    expect(wrongPath.auditRetentionConfirmation).toBeUndefined();
    expect(wrongPath.retentionConfirmation).toBeUndefined();
  });
});
