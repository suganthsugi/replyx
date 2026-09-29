import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { TriageBar } from '../../src/components/tickets/TriageBar';
import { TicketFocus } from '../../src/pages/desk/inbox/TicketFocus';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations } from '../setup';

import {
  eligibleOwnersHandler,
  groupDestinationsHandler,
  historyHandler,
  makeEligibleOwner,
  makeGroup,
  makeMe,
  makeMessage,
  makeTicket,
  meHandler,
  messagesHandler,
  tagsHandler,
  ticketHandler,
  usersHandler,
} from './fixtures';

import type { TriageTicket200 } from '../../src/api/generated/model';

/**
 * TriageBar (US5, FR-063, SC-005, T177): the one-step assignment of an ungrouped ticket to a
 * group (and optionally owner/priority/tags), shown by `TicketFocus` in place of the regular
 * Group control. Rendered standalone here for its own behavior, and through `TicketFocus` to
 * check when it does (and doesn't) show up.
 */

function triageHandler(ticketId: string, respond: (body: unknown) => TriageTicket200 | Response) {
  return http.post(`${API}/tickets/${ticketId}/triage`, async ({ request }) => {
    const body = (await request.json()) as unknown;
    const result = respond(body);
    return result instanceof Response ? result : HttpResponse.json(result);
  });
}

function setupTriageBarHandlers() {
  server.use(
    groupDestinationsHandler([makeGroup({ id: 'group-1', name: 'Support' }), makeGroup({ id: 'group-2', name: 'Billing' })]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner({ id: 'owner-1', name: 'Ada Agent' })]),
    eligibleOwnersHandler('group-2', [makeEligibleOwner({ id: 'owner-2', name: 'Bea Agent' })]),
    tagsHandler([]),
  );
}

describe('TriageBar', () => {
  it('only shows up in TicketFocus for an ungrouped ticket the caller can triage', async () => {
    const ungroupedAllowed = makeTicket({ id: 'ticket-1', group: null, allowedActions: ['change_group'] });
    server.use(
      meHandler(makeMe()),
      ticketHandler(ungroupedAllowed),
      messagesHandler(ungroupedAllowed.id, [makeMessage()]),
      historyHandler(ungroupedAllowed.id, []),
      groupDestinationsHandler([makeGroup()]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
      tagsHandler([]),
      usersHandler([]),
    );
    renderWithProviders(<TicketFocus ticketId={ungroupedAllowed.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    expect(await screen.findByRole('region', { name: 'Triage' })).toBeInTheDocument();
  });

  it('does not show up for a grouped ticket', async () => {
    const grouped = makeTicket({ id: 'ticket-2', allowedActions: ['change_group'] });
    server.use(
      meHandler(makeMe()),
      ticketHandler(grouped),
      messagesHandler(grouped.id, [makeMessage()]),
      historyHandler(grouped.id, []),
      groupDestinationsHandler([makeGroup()]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
      tagsHandler([]),
      usersHandler([]),
    );
    renderWithProviders(<TicketFocus ticketId={grouped.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: grouped.title });
    expect(screen.queryByRole('region', { name: 'Triage' })).not.toBeInTheDocument();
  });

  it('does not show up for an ungrouped ticket without change_group', async () => {
    const ungroupedNotAllowed = makeTicket({ id: 'ticket-3', group: null, allowedActions: [] });
    server.use(
      meHandler(makeMe()),
      ticketHandler(ungroupedNotAllowed),
      messagesHandler(ungroupedNotAllowed.id, [makeMessage()]),
      historyHandler(ungroupedNotAllowed.id, []),
      groupDestinationsHandler([makeGroup()]),
      tagsHandler([]),
      usersHandler([]),
    );
    renderWithProviders(<TicketFocus ticketId={ungroupedNotAllowed.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: ungroupedNotAllowed.title });
    expect(screen.queryByRole('region', { name: 'Triage' })).not.toBeInTheDocument();
  });

  it('disables Owner until a group is chosen, and loads that group\'s eligible owners', async () => {
    setupTriageBarHandlers();
    const { container } = renderWithProviders(<TriageBar ticketId="ticket-1" onClose={vi.fn()} />);
    await expectNoAxeViolations(container);

    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeDisabled();

    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Support' }));
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeEnabled();

    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    expect(await screen.findByRole('option', { name: 'Ada Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Bea Agent' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Ada Agent' }));

    // Switching groups resets the owner and refreshes the eligible-owner list.
    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Billing' }));
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveValue('');
    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    expect(await screen.findByRole('option', { name: 'Bea Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ada Agent' })).not.toBeInTheDocument();
  });

  it('focuses Group on G, focuses Owner on O once a group is chosen, and Enter assigns', async () => {
    setupTriageBarHandlers();
    let requestBody: unknown;
    server.use(
      triageHandler('ticket-1', (body) => {
        requestBody = body;
        return { visibleToCaller: true, ticket: makeTicket({ id: 'ticket-1', group: { id: 'group-1', name: 'Support' } }) };
      }),
    );
    const { container } = renderWithProviders(<TriageBar ticketId="ticket-1" onClose={vi.fn()} />);

    await userEvent.keyboard('g');
    const groupInput = screen.getByRole('combobox', { name: 'Group' });
    expect(groupInput).toHaveFocus();

    await userEvent.click(groupInput);
    await userEvent.click(await screen.findByRole('option', { name: 'Support' }));

    // Move focus away so O isn't hijacking a letter typed into a text field.
    await userEvent.click(document.body);
    await userEvent.keyboard('o');
    const ownerInput = screen.getByRole('combobox', { name: 'Owner' });
    expect(ownerInput).toHaveFocus();

    await userEvent.click(ownerInput);
    await userEvent.click(await screen.findByRole('option', { name: 'Ada Agent' }));

    // Enter outside the bar's own fields (a list row, a button elsewhere) keeps its own meaning.
    await userEvent.click(document.body);
    await userEvent.keyboard('{Enter}');
    expect(requestBody).toBeUndefined();

    ownerInput.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(requestBody).toMatchObject({ groupId: 'group-1', ownerId: 'owner-1' }));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Ticket sent to Support');
  });

  it('does not assign on Enter before a group is chosen', async () => {
    setupTriageBarHandlers();
    let called = false;
    server.use(triageHandler('ticket-1', () => { called = true; return { visibleToCaller: true }; }));
    renderWithProviders(<TriageBar ticketId="ticket-1" onClose={vi.fn()} />);

    await userEvent.keyboard('{Enter}');
    expect(called).toBe(false);
  });

  it('closes the focus when the triaged ticket is no longer visible to the caller', async () => {
    setupTriageBarHandlers();
    server.use(triageHandler('ticket-1', () => ({ visibleToCaller: false })));
    const onClose = vi.fn();
    renderWithProviders(<TriageBar ticketId="ticket-1" onClose={onClose} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Support' }));
    await userEvent.click(screen.getByRole('button', { name: /Assign/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an inline alert when the ticket was already triaged', async () => {
    setupTriageBarHandlers();
    server.use(
      triageHandler('ticket-1', () => errorResponse(409, 'ALREADY_TRIAGED', 'Already triaged')),
      http.get(`${API}/tickets/ticket-1`, () => HttpResponse.json(makeTicket({ id: 'ticket-1', group: { id: 'group-2', name: 'Billing' } }))),
    );
    renderWithProviders(<TriageBar ticketId="ticket-1" onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Support' }));
    await userEvent.click(screen.getByRole('button', { name: /Assign/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else already triaged this ticket.');
  });
});
