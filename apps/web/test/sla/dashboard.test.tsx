import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import DashboardPage from '../../src/pages/desk/dashboard/DashboardPage';
import { DashboardView, type DashboardData } from '../../src/pages/desk/dashboard/DashboardView';
import { FakeSocket } from '../chat/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Dashboard, ErrorResponse } from '../../src/api/generated/model';
import type { Envelope } from '../../src/data/socket';

const FIND = { timeout: 10_000 };

const full: DashboardData = {
  counts: { open: 42, ungrouped: 3, unassigned: 7, waitingOnCustomer: 11, waitingOnSupport: 31, urgent: 2, slaBreached: 5 },
  today: { created: 14, resolved: 9 },
  averages: { firstResponseMinutes: 125, resolutionMinutes: 2880, window: 'P7D' },
  satisfaction: { average: 4.25, responses: 8 },
};

/** The figure shown under a tile label (the `dd` that follows its `dt`). */
function figure(label: string): string | null {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

function view(data?: DashboardData, extra: Partial<Parameters<typeof DashboardView>[0]> = {}) {
  return renderWithProviders(<DashboardView status="ready" onRetry={() => undefined} data={data} {...extra} />);
}

describe('DashboardView', () => {
  it('shows every FR-086 figure with its label and is free of axe violations', async () => {
    const { container } = view(full);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(figure('Open')).toBe('42');
    expect(figure('Unassigned')).toBe('7');
    expect(figure('Ungrouped')).toBe('3');
    expect(figure('Waiting on customer')).toBe('11');
    expect(figure('Waiting on support')).toBe('31');
    expect(figure('Urgent')).toBe('2');
    expect(figure('SLA breached')).toBe('5');
    expect(figure('Created today')).toBe('14');
    expect(figure('Resolved today')).toBe('9');
    expect(figure('First response time')).toBe('2h 5m');
    expect(figure('Resolution time')).toBe('2d');
    expect(figure('Average rating')).toBe('4.3');
    expect(screen.getByText('8 responses')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Averages, last 7 days' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing is open right now.')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows a dash, not zero, for averages with nothing behind them', () => {
    view({ ...full, averages: { firstResponseMinutes: null, resolutionMinutes: null, window: 'P7D' } });
    expect(figure('First response time')).toBe('—');
    expect(figure('Resolution time')).toBe('—');
    expect(screen.getByText('No replies yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing resolved yet')).toBeInTheDocument();
  });

  it('shows satisfaction as unavailable until there are ratings', () => {
    view({ ...full, satisfaction: { average: null, responses: 0 } });
    expect(figure('Average rating')).toBe('—');
    expect(screen.getByText('Not yet available')).toBeInTheDocument();
  });

  it('copes with a response that has no satisfaction block', () => {
    const { satisfaction: _omitted, ...without } = full;
    view(without);
    expect(figure('Average rating')).toBe('—');
    expect(screen.getByText('Not yet available')).toBeInTheDocument();
  });

  it('says so when nothing is open, and shows zero counts as zeros', () => {
    view({ ...full, counts: { open: 0, ungrouped: 0, unassigned: 0, waitingOnCustomer: 0, waitingOnSupport: 0, urgent: 0, slaBreached: 0 } });
    expect(screen.getByText('Nothing is open right now.')).toBeInTheDocument();
    expect(figure('Open')).toBe('0');
    expect(figure('SLA breached')).toBe('0');
  });

  it('shows a loading status while the figures load', async () => {
    const { container } = renderWithProviders(<DashboardView status="pending" onRetry={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent(/dashboard/i);
    expect(screen.queryByText('Open', { selector: 'dt' })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows an error with a working Retry', async () => {
    const onRetry = vi.fn();
    const { container } = renderWithProviders(<DashboardView status="error" errorMessage="Boom" onRetry={onRetry} />);
    expect(screen.getByText("Couldn't load the dashboard")).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });

  it('says there are no figures when ready without data', () => {
    view(undefined);
    expect(screen.getByText('No figures yet')).toBeInTheDocument();
  });
});

describe('DashboardPage', () => {
  function dashboard(open: number): Dashboard {
    return {
      counts: { ...full.counts, open },
      today: full.today,
      averages: { firstResponseMinutes: null, resolutionMinutes: null, window: 'P7D' },
      satisfaction: { average: null, responses: 0 },
    };
  }

  function renderPage(options: { fetches: { n: number }; open?: () => number }) {
    server.use(
      http.get(`${API}/dashboard`, () => {
        options.fetches.n += 1;
        return HttpResponse.json<Dashboard>(dashboard(options.open?.() ?? 42));
      }),
    );
    const socket = new FakeSocket();
    renderWithProviders(
      <RealtimeProvider namespace="/" userId="dash-user" createSocket={() => socket}>
        <DashboardPage />
      </RealtimeProvider>,
    );
    return socket;
  }

  let seq = 100;
  const hint = (socket: FakeSocket, type: string, stream = 'views') => {
    seq += 1;
    const envelope: Envelope = { id: `evt-${seq}`, seq, stream, type, occurredAt: new Date().toISOString(), actor: { kind: 'system' }, data: {} };
    act(() => socket.fire('event', envelope));
  };

  it('loads the figures from the API', async () => {
    renderPage({ fetches: { n: 0 } });
    expect(screen.getByRole('status')).toBeInTheDocument();
    await waitFor(() => expect(figure('Open')).toBe('42'), FIND);
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('shows the error state when the API fails, then recovers on Retry', async () => {
    let fail = true;
    server.use(
      http.get<never, never, Dashboard | ErrorResponse>(`${API}/dashboard`, () => (fail ? errorResponse(500, 'INTERNAL', 'Boom') : HttpResponse.json<Dashboard>(dashboard(5)))),
    );
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText("Couldn't load the dashboard", undefined, FIND)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(figure('Open')).toBe('5'), FIND);
  });

  it('refetches when a views.counts_changed hint arrives', async () => {
    const fetches = { n: 0 };
    let open = 42;
    const socket = renderPage({ fetches, open: () => open });
    await waitFor(() => expect(figure('Open')).toBe('42'), FIND);
    expect(fetches.n).toBe(1);
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    act(() => socket.open());

    open = 43;
    hint(socket, 'views.counts_changed');
    await waitFor(() => expect(figure('Open')).toBe('43'), FIND);
    expect(fetches.n).toBe(2);
  });

  it('refetches on sla.breached and ticket.created too, once per burst', async () => {
    const fetches = { n: 0 };
    const socket = renderPage({ fetches });
    await waitFor(() => expect(figure('Open')).toBe('42'), FIND);
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    act(() => socket.open());

    // Three hints inside the 2 s guard make one refetch.
    hint(socket, 'sla.breached', 'tickets');
    hint(socket, 'ticket.created', 'tickets');
    hint(socket, 'views.counts_changed');
    await waitFor(() => expect(fetches.n).toBe(2), FIND);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetches.n).toBe(2);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });
});
