import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../src/data/http';
import { mapViewSubmitError, useCreateView, usePreviewViewCount, useUpdateView, useViewBuilderLookups } from '../../src/data/view-builder';
import { viewCountKeys } from '../../src/data/view-counts';
import { viewKeys } from '../../src/data/views';
import { eligibleOwnersHandler, groupDestinationsHandler, makeEligibleOwner, makeTag, makeView, tagsHandler } from '../desk/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { ConditionGroup, PreviewViewCount200, Role, View } from '../../src/api/generated/model';
import type { ReactNode } from 'react';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, Wrapper };
}

const conditions: ConditionGroup = { op: 'and', items: [{ field: 'state', operator: 'is', value: ['open'] }] };
const input = { name: 'V', visibility: 'personal' as const, conditions, sort: [], columns: ['title' as const] };

describe('mapViewSubmitError', () => {
  it('maps validation issues onto their field paths with plain messages', () => {
    const error = new HttpError(400, {
      code: 'VALIDATION_FAILED',
      message: 'Invalid',
      details: [
        { path: 'name', issue: 'too_small' },
        { path: 'description', issue: 'too_long' },
        { path: 'columns', issue: 'too_big' },
        { path: 'conditions.items.1.operator', issue: 'unsupported_operator' },
        { path: 'sharedRoleIds.0', issue: 'invalid_value' },
        { path: 'weird', issue: 'some_new_issue' },
      ],
    });
    expect(mapViewSubmitError(error)).toEqual({
      name: 'This field is required.',
      description: 'This is too long.',
      columns: 'There are too many entries.',
      'conditions.items.1.operator': 'This operator does not work with that field.',
      'sharedRoleIds.0': 'Pick one of the available options.',
      weird: 'Some new issue.',
    });
  });

  it('turns 403 into a share-permission message and 404 into a missing-view message', () => {
    expect(mapViewSubmitError(new HttpError(403, { code: 'PERMISSION_DENIED', message: 'no' }))).toEqual({
      '': "You don't have permission to share views.",
    });
    expect(mapViewSubmitError(new HttpError(404, { code: 'VIEW_NOT_FOUND', message: 'gone' }))).toEqual({ '': 'This view no longer exists.' });
    expect(mapViewSubmitError(new HttpError(404, { code: 'NOT_FOUND', message: 'gone' }))).toEqual({ '': 'This view no longer exists.' });
  });

  it('falls back to the error message under the form-level path', () => {
    expect(mapViewSubmitError(new HttpError(500, { code: 'INTERNAL', message: 'Boom' }))).toEqual({ '': expect.stringContaining('Try again') as string });
    expect(mapViewSubmitError(new Error('offline'))['']).toEqual(expect.any(String));
  });
});

describe('view mutations', () => {
  it('creating a view seeds the detail cache and refreshes the lists and counts', async () => {
    const saved = makeView({ id: 'view-9' });
    server.use(http.post(`${API}/views`, () => HttpResponse.json<View>(saved, { status: 201 })));
    const { queryClient, Wrapper } = wrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateView(), { wrapper: Wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(input)).resolves.toEqual(saved);
    });

    expect(queryClient.getQueryData(viewKeys.detail('view-9'))).toEqual(saved);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: viewKeys.list() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: viewCountKeys.all });
  });

  it('updating a view PUTs to its id and refreshes the same caches', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${API}/views/view-3`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json<View>(makeView({ id: 'view-3', name: 'Renamed' }));
      }),
    );
    const { queryClient, Wrapper } = wrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateView(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'view-3', ...input });
    });

    expect(bodies[0]).toEqual(input);
    expect(queryClient.getQueryData<View>(viewKeys.detail('view-3'))?.name).toBe('Renamed');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: viewKeys.list() });
  });
});

describe('usePreviewViewCount', () => {
  it('is idle until asked, then loads, then reports the count', async () => {
    server.use(http.post(`${API}/views/preview-count`, () => HttpResponse.json<PreviewViewCount200>({ count: 4 })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePreviewViewCount(), { wrapper: Wrapper });
    expect(result.current.status).toBe('idle');

    act(() => result.current.request(conditions));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', count: 4 }));
  });

  it('stays idle when disabled', () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePreviewViewCount({ enabled: false }), { wrapper: Wrapper });
    act(() => result.current.request(conditions));
    expect(result.current.status).toBe('idle');
  });

  it('reports an error status when the preview is rejected', async () => {
    server.use(http.post(`${API}/views/preview-count`, () => errorResponse(400, 'VALIDATION_FAILED')));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePreviewViewCount(), { wrapper: Wrapper });
    act(() => result.current.request(conditions));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.count).toBeUndefined();
  });

  it('keeps the previous count (status loading) while the next tree loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${API}/views/preview-count`, async ({ request }) => {
        const body = (await request.json()) as { conditions: ConditionGroup };
        if (body.conditions.items.length === 2) {
          await gate;
          return HttpResponse.json<PreviewViewCount200>({ count: 9 });
        }
        return HttpResponse.json<PreviewViewCount200>({ count: 4 });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePreviewViewCount(), { wrapper: Wrapper });
    act(() => result.current.request(conditions));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', count: 4 }));

    act(() => result.current.request({ op: 'and', items: [...conditions.items, { field: 'priority', operator: 'is', value: ['high'] }] }));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'loading', count: 4 }));
    release();
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', count: 9 }));
  });
});

describe('useViewBuilderLookups', () => {
  const role: Role = { id: 'role-1', name: 'Agent', system: null, permissions: [], groupAccess: [], userCount: 1 };

  it('loads roles (when allowed), groups, tags and de-duplicated eligible owners', async () => {
    server.use(
      groupDestinationsHandler([
        { id: 'group-1', name: 'Support' },
        { id: 'group-2', name: 'Sales' },
      ]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner({ id: 'a1', name: 'Ada' })]),
      eligibleOwnersHandler('group-2', [makeEligibleOwner({ id: 'a1', name: 'Ada' }), makeEligibleOwner({ id: 'a2', name: 'Bob' })]),
      tagsHandler([makeTag()]),
      http.get(`${API}/roles`, () => HttpResponse.json<{ items: Role[] }>({ items: [role] })),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useViewBuilderLookups({ canShare: true }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.owners).toHaveLength(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.roles).toEqual([role]);
    expect(result.current.groups.map((group) => group.name)).toEqual(['Support', 'Sales']);
    expect(result.current.tags).toHaveLength(1);
    expect(result.current.isError).toBe(false);
  });

  it('does not ask for roles without sharing rights, and degrades on failure with a refetch', async () => {
    let failing = true;
    const roles = vi.fn();
    server.use(
      groupDestinationsHandler([]),
      http.get(`${API}/roles`, () => (roles(), HttpResponse.json({ items: [role] }))),
      http.get(`${API}/tags`, () => (failing ? errorResponse(500, 'INTERNAL') : HttpResponse.json({ items: [makeTag()] }))),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useViewBuilderLookups({ canShare: false }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.tags).toEqual([]);
    expect(result.current.roles).toEqual([]);
    expect(roles).not.toHaveBeenCalled();

    failing = false;
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.isError).toBe(false));
    expect(result.current.tags).toHaveLength(1);
  });
});
