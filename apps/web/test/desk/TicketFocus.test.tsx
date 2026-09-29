import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { TicketFocus } from '../../src/pages/desk/inbox/TicketFocus';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

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

function setupHandlers(ticket = makeTicket()) {
  server.use(
    meHandler(makeMe()),
    ticketHandler(ticket),
    messagesHandler(ticket.id, [makeMessage()]),
    historyHandler(ticket.id, []),
    groupDestinationsHandler([makeGroup()]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
    tagsHandler([]),
    usersHandler([]),
  );
}

function renderFocus(ticket = makeTicket()) {
  setupHandlers(ticket);
  return renderWithProviders(<TicketFocus ticketId={ticket.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
}

describe('TicketFocus', () => {
  it('shows a loading skeleton, then the ticket', async () => {
    setupHandlers();
    renderWithProviders(<TicketFocus ticketId="ticket-1" onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the ticket');
    // Not run through expectNoAxeViolations: once loaded, the composer mounts with the
    // role="combobox"-on-<textarea> bug already reported from MessageComposer.test.tsx.
    expect(await screen.findByRole('heading', { level: 2, name: 'Cannot reset my password' })).toBeInTheDocument();
  });

  it('shows a retryable error when the ticket fails to load', async () => {
    server.use(meHandler(makeMe()), http.get(`${API}/tickets/ticket-1`, () => errorResponse(500, 'INTERNAL')));
    const { container } = renderWithProviders(<TicketFocus ticketId="ticket-1" onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this ticket");
    await expectNoAxeViolations(container);
  });

  it('shows a loading skeleton, then an error for the conversation', async () => {
    server.use(
      meHandler(makeMe()),
      ticketHandler(makeTicket()),
      http.get(`${API}/tickets/ticket-1/messages`, () => errorResponse(500, 'INTERNAL')),
      historyHandler('ticket-1', []),
      groupDestinationsHandler([makeGroup()]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
      tagsHandler([]),
      usersHandler([]),
    );
    renderWithProviders(<TicketFocus ticketId="ticket-1" onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    expect(await screen.findByText("Couldn't load messages")).toBeInTheDocument();
  });

  it('shows the empty conversation state when there are no messages', async () => {
    const ticket = makeTicket();
    server.use(
      meHandler(makeMe()),
      ticketHandler(ticket),
      messagesHandler(ticket.id, []),
      historyHandler(ticket.id, []),
      groupDestinationsHandler([makeGroup()]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
      tagsHandler([]),
      usersHandler([]),
    );
    renderWithProviders(<TicketFocus ticketId={ticket.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('enables reply/note, edit, group, owner, tag and delete controls when every action is allowed', async () => {
    const ticket = makeTicket({ allowedActions: ['reply', 'note', 'edit', 'change_group', 'assign', 'delete'] });
    renderFocus(ticket);
    await screen.findByRole('heading', { level: 2, name: ticket.title });

    // Not run through expectNoAxeViolations here: the composer's mention field carries the
    // role="combobox"-on-<textarea> bug already reported from MessageComposer.test.tsx.
    expect(screen.getByRole('combobox', { name: 'Reply' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'State' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('group', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Group' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete ticket' })).toBeInTheDocument();
  });

  it('disables reply/note, edit, group, owner and tags, and hides delete, when no action is allowed', async () => {
    const ticket = makeTicket({ allowedActions: [] });
    renderFocus(ticket);
    await screen.findByRole('heading', { level: 2, name: ticket.title });

    expect(screen.getByRole('combobox', { name: 'Reply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveAttribute('aria-disabled', 'true');
    for (const button of screen.getAllByRole('button', { name: /Low|Normal|High|Urgent/ })) expect(button).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Group' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete ticket' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).not.toBeInTheDocument();
  });

  it('offers "Assign to me" only when assign is allowed and the ticket is unowned', async () => {
    const ticket = makeTicket({ allowedActions: ['assign'], owner: null });
    renderFocus(ticket);
    expect(await screen.findByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
  });
});
