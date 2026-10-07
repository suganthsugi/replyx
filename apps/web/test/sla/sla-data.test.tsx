import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { slaKeys, useCreateBusinessHours, useCreateSlaPolicy, useDeleteBusinessHours, useDeleteSlaPolicy, useSlaPolicies, useBusinessHoursList, useUpdateBusinessHours, useUpdateSlaPolicy } from '../../src/data/sla';
import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { ticketKeys, useTicketListEvents } from '../../src/data/tickets';
import { API } from '../msw/handlers';
import { server } from '../setup';

import { calendarNight, calendarOffice, makePolicy } from './fixtures';

import type { ReactNode } from 'react';

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('SLA queries', () => {
  it('sorts policies by position and calendars by name', async () => {
    server.use(
      http.get(`${API}/sla-policies`, () => HttpResponse.json({ items: [makePolicy({ id: 'b', position: 1 }), makePolicy({ id: 'a', position: 0 })] })),
      http.get(`${API}/business-hours`, () => HttpResponse.json({ items: [calendarOffice, calendarNight] })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const policies = renderHook(() => useSlaPolicies(), { wrapper: wrapper(queryClient) });
    const calendars = renderHook(() => useBusinessHoursList(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(policies.result.current.data?.items.map((p) => p.id)).toEqual(['a', 'b']));
    await waitFor(() => expect(calendars.result.current.data?.items.map((c) => c.name)).toEqual(['Night desk', 'Office hours']));
  });
});

describe('SLA mutations invalidate SLA and ticket queries', () => {
  function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const keys = () => spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    return { queryClient, keys, w: wrapper(queryClient) };
  }

  const input = { name: 'X', conditions: makePolicy().conditions, businessHoursId: 'cal-office' };
  const hoursInput = { name: 'X', timezone: 'UTC', intervals: { mon: [{ from: '09:00', to: '17:00' }] } };

  it.each([
    ['create policy', () => useCreateSlaPolicy(), (m: ReturnType<typeof useCreateSlaPolicy>) => m.mutateAsync(input), 'post', '/sla-policies'],
    ['update policy', () => useUpdateSlaPolicy(), (m: ReturnType<typeof useUpdateSlaPolicy>) => m.mutateAsync({ id: 'p1', body: input }), 'put', '/sla-policies/p1'],
    ['delete policy', () => useDeleteSlaPolicy(), (m: ReturnType<typeof useDeleteSlaPolicy>) => m.mutateAsync('p1'), 'delete', '/sla-policies/p1'],
    ['create calendar', () => useCreateBusinessHours(), (m: ReturnType<typeof useCreateBusinessHours>) => m.mutateAsync(hoursInput), 'post', '/business-hours'],
    ['update calendar', () => useUpdateBusinessHours(), (m: ReturnType<typeof useUpdateBusinessHours>) => m.mutateAsync({ id: 'c1', body: hoursInput }), 'put', '/business-hours/c1'],
    ['delete calendar', () => useDeleteBusinessHours(), (m: ReturnType<typeof useDeleteBusinessHours>) => m.mutateAsync('c1'), 'delete', '/business-hours/c1'],
  ] as const)('%s', async (_name, useHook, run, method, path) => {
    const { keys, w } = setup();
    server.use(
      http[method](`${API}${path}`, () => (method === 'delete' ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(path.startsWith('/sla') ? makePolicy() : calendarOffice, { status: method === 'post' ? 201 : 200 }))),
    );
    const { result } = renderHook(() => useHook(), { wrapper: w });
    // The overloaded `run` accepts the hook result it was paired with above.
    await act(async () => {
      await (run as (m: unknown) => Promise<unknown>)(result.current);
    });
    await waitFor(() => expect(keys()).toEqual(expect.arrayContaining([JSON.stringify(slaKeys.all), JSON.stringify(ticketKeys.all)])));
  });

  it('rejects with the raw error so a form can map it', async () => {
    const { w } = setup();
    server.use(http.post(`${API}/business-hours`, () => HttpResponse.json({ error: { code: 'BUSINESS_HOURS_NAME_TAKEN', message: 'taken' } }, { status: 409 })));
    const { result } = renderHook(() => useCreateBusinessHours(), { wrapper: w });
    await expect(result.current.mutateAsync(hoursInput)).rejects.toMatchObject({ status: 409 });
  });
});

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  disconnect = vi.fn();
  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout() {
    return { emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 0, resyncRequired: [] }) };
  }
  connect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

describe('sla.* realtime events', () => {
  let seq = 1;
  const envelope = (type: string, data: unknown): Envelope => ({
    id: `evt-${seq}`,
    seq: seq++,
    stream: 'tickets',
    type,
    occurredAt: '2026-10-07T10:00:00.000Z',
    actor: { kind: 'system' },
    data,
  });

  it.each(['sla.updated', 'sla.warning', 'sla.breached'])('%s invalidates the ticket detail and the lists, not other tickets', (type) => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: `sla-${type}`, queryClient, createSocket: () => socket });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useTicketListEvents(client), { wrapper: wrapper(queryClient) });

    socket.fire('event', envelope(type, { ticketId: 't7' }));

    const filters = spy.mock.calls.map(([f]) => f?.queryKey);
    expect(filters).toContainEqual(ticketKeys.detail('t7'));
    expect(filters).toContainEqual([...ticketKeys.all, 'list']);
    expect(filters).not.toContainEqual(ticketKeys.detail('t8'));
  });
});
