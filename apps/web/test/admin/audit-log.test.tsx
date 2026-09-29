import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import AuditLogPage from '../../src/pages/admin/audit/AuditLogPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AuditLog, ListAuditLogs200 } from '../../src/api/generated/model';

/**
 * The audit log page (T197, FR-092): rows, filters that reset the list, load more, the detail
 * drawer, keyboard use and axe.
 */

const ACTOR_ID = '3f2c9a10-1111-4222-8333-444455556666';
const RESOURCE_ID = '9b1d7c20-aaaa-4bbb-8ccc-ddddeeeeffff';

function entry(n: number, overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: `log-${n}`,
    occurredAt: new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - n * 60_000).toISOString(),
    actor: { kind: 'user', id: ACTOR_ID, name: 'Ada Admin' },
    action: 'user.deactivated',
    resourceType: 'user',
    resourceId: RESOURCE_ID,
    details: { reason: 'left the team' },
    ip: '203.0.113.7',
    ...overrides,
  };
}

interface Seen {
  params: URLSearchParams[];
}

/** Serves `first` (and `second` for `cursor=next`) and records each request's query. */
function serve(first: AuditLog[], second?: AuditLog[]): Seen {
  const seen: Seen = { params: [] };
  server.use(
    http.get(`${API}/audit-logs`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      seen.params.push(params);
      if (params.get('cursor') === 'next') return HttpResponse.json<ListAuditLogs200>({ items: second ?? [], nextCursor: null });
      return HttpResponse.json<ListAuditLogs200>({ items: first, nextCursor: second === undefined ? null : 'next' });
    }),
  );
  return seen;
}

describe('AuditLogPage', () => {
  it('lists entries newest first with a readable action, its raw code and system actors', async () => {
    serve([
      entry(1),
      entry(2, { actor: { kind: 'system', id: null }, action: 'ticket.auto_closed', resourceType: 'ticket', resourceId: null }),
      entry(3, { actor: { kind: 'automation', id: null }, action: 'ticket.assigned' }),
      entry(4, { actor: { kind: 'operator', id: null }, action: 'support_access.granted' }),
    ]);
    const { container } = renderWithProviders(<AuditLogPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Ada Admin')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('User deactivated')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('user.deactivated')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(`user · ${RESOURCE_ID}`)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('System')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('ticket.auto_closed')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Automation')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Operator')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the loading, empty and error states', async () => {
    serve([]);
    const { unmount } = renderWithProviders(<AuditLogPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading audit log');
    expect(await screen.findByRole('heading', { name: 'No audit entries yet' })).toBeInTheDocument();
    unmount();

    server.use(http.get(`${API}/audit-logs`, () => errorResponse(403, 'FORBIDDEN', 'Not allowed')));
    renderWithProviders(<AuditLogPage />);
    expect(await screen.findByRole('heading', { name: "Couldn't load the audit log" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('applies filters as typed query values and resets the list, then clears them', async () => {
    const user = userEvent.setup();
    const seen = serve([entry(1), entry(2)]);
    renderWithProviders(<AuditLogPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    expect(seen.params[0]?.get('action')).toBeNull();

    server.use(
      http.get(`${API}/audit-logs`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        seen.params.push(params);
        return HttpResponse.json<ListAuditLogs200>({
          items: params.get('action') === 'role.updated' ? [entry(9, { action: 'role.updated', resourceType: 'role' })] : [entry(1), entry(2)],
          nextCursor: null,
        });
      }),
    );
    await user.type(screen.getByRole('textbox', { name: 'Action' }), 'role.updated');
    await user.type(screen.getByRole('textbox', { name: 'Resource type' }), 'role');
    await user.type(screen.getByRole('textbox', { name: 'Actor ID' }), ACTOR_ID);
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('Role updated')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Audit log' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    const applied = seen.params.at(-1);
    expect(applied?.get('action')).toBe('role.updated');
    expect(applied?.get('resourceType')).toBe('role');
    expect(applied?.get('actorId')).toBe(ACTOR_ID);
    expect(applied?.get('cursor')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitForRows(2);
    await vi.waitFor(() => expect(seen.params.at(-1)?.get('action')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Action' })).toHaveValue('');
  });

  it('sends the time range as ISO timestamps and rejects malformed ids and a reversed range', async () => {
    const user = userEvent.setup();
    const seen = serve([entry(1)]);
    renderWithProviders(<AuditLogPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    const calls = seen.params.length;

    await user.type(screen.getByRole('textbox', { name: 'Actor ID' }), 'not-an-id');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('textbox', { name: 'Actor ID' })).toHaveAccessibleDescription('Enter the actor’s ID, like 3f2c…');
    expect(screen.getByRole('textbox', { name: 'Actor ID' })).toBeInvalid();
    expect(seen.params).toHaveLength(calls);
    await user.clear(screen.getByRole('textbox', { name: 'Actor ID' }));

    await user.type(screen.getByLabelText('From'), '2026-09-02T10:00');
    await user.type(screen.getByLabelText('To'), '2026-09-01T10:00');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByLabelText('To')).toHaveAccessibleDescription('Choose a time after From');
    expect(seen.params).toHaveLength(calls);

    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-09-03T10:00');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByRole('table', { name: 'Audit log' });
    const applied = seen.params.at(-1);
    expect(applied?.get('from')).toBe(new Date('2026-09-02T10:00').toISOString());
    expect(applied?.get('to')).toBe(new Date('2026-09-03T10:00').toISOString());
  });

  it('says so when a filter matches nothing', async () => {
    const user = userEvent.setup();
    serve([entry(1)]);
    renderWithProviders(<AuditLogPage />);
    await screen.findByRole('table', { name: 'Audit log' });
    serve([]);
    await user.type(screen.getByRole('textbox', { name: 'Action' }), 'nothing.here');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('heading', { name: 'No entries match these filters' })).toBeInTheDocument();
  });

  it('loads the next page with the button and keeps the first page', async () => {
    const user = userEvent.setup();
    const seen = serve([entry(1), entry(2)], [entry(3, { action: 'group.created', resourceType: 'group' })]);
    renderWithProviders(<AuditLogPage />);
    await screen.findByRole('table', { name: 'Audit log' });

    screen.getByRole('button', { name: 'Load more' }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Group created')).toBeInTheDocument();
    expect(seen.params.at(-1)?.get('cursor')).toBe('next');
    expect(within(screen.getByRole('table', { name: 'Audit log' })).getAllByRole('row').slice(1)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('More entries loaded');
  });

  it('opens the detail drawer from a row click and shows details as text only', async () => {
    const user = userEvent.setup();
    serve([
      entry(1, {
        details: { note: '<img src=x onerror=alert(1)>', count: 3, nested: { a: 1 }, missing: null },
      }),
    ]);
    const { container } = renderWithProviders(<AuditLogPage />);
    const table = await screen.findByRole('table', { name: 'Audit log' });

    await user.click(within(table).getByText('Ada Admin'));

    const drawer = await screen.findByRole('dialog', { name: 'Audit entry' });
    expect(within(drawer).getByText('user.deactivated')).toBeInTheDocument();
    expect(within(drawer).getByText('203.0.113.7')).toBeInTheDocument();
    expect(within(drawer).getByText(ACTOR_ID)).toBeInTheDocument();
    expect(within(drawer).getByText('note')).toBeInTheDocument();
    expect(within(drawer).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(drawer.querySelector('img')).toBeNull();
    expect(within(drawer).getByText('3')).toBeInTheDocument();
    expect(within(drawer).getByText(/"a": 1/)).toBeInTheDocument();
    await expectNoAxeViolations(container.ownerDocument.body);
  });

  it('opens the drawer with Enter on a row, closes it with Escape and returns focus', async () => {
    const user = userEvent.setup();
    serve([entry(1, { details: {}, ip: null, resourceId: null, actor: { kind: 'system', id: null } })]);
    renderWithProviders(<AuditLogPage />);
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const opener = within(table).getByRole('button', { name: /view details of User deactivated/ });

    opener.focus();
    await user.keyboard('{Enter}');

    const drawer = await screen.findByRole('dialog', { name: 'Audit entry' });
    expect(within(drawer).getByText('No further details were recorded.')).toBeInTheDocument();
    expect(within(drawer).getByText('System')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitForClosed();
    expect(opener).toHaveFocus();
  });
});

async function waitForRows(count: number) {
  await screen.findByRole('table', { name: 'Audit log' });
  await vi.waitFor(() => {
    expect(within(screen.getByRole('table', { name: 'Audit log' })).getAllByRole('row').slice(1)).toHaveLength(count);
  });
}

async function waitForClosed() {
  await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Audit entry' })).not.toBeInTheDocument());
}
