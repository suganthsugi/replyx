import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { NewTicketDialog } from '../../src/pages/desk/inbox/NewTicketDialog';
import { API } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

import { eligibleOwnersHandler, groupsHandler, makeEligibleOwner, makeGroup, makeMe, makeUser, meHandler, tagsHandler, usersHandler } from './fixtures';

function setup() {
  server.use(
    meHandler(makeMe()),
    usersHandler([makeUser({ id: 'customer-1', name: 'Cara Customer', email: 'cara@customer.test' })]),
    groupsHandler([makeGroup({ id: 'group-1', name: 'Support', status: 'active' })]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner({ id: 'agent-1', name: 'Ada Agent' })]),
    tagsHandler([]),
  );
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = renderWithProviders(<NewTicketDialog open onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated, ...utils };
}

async function fillRequiredFields() {
  const customerField = await screen.findByRole('combobox', { name: 'Customer' });
  await userEvent.type(customerField, 'Cara');
  await userEvent.click(await screen.findByRole('option', { name: /Cara Customer/ }));

  const groupField = screen.getByRole('combobox', { name: 'Group' });
  await userEvent.type(groupField, 'Support');
  await userEvent.click(await screen.findByRole('option', { name: 'Support' }));

  await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Cannot sign in');
  await userEvent.type(screen.getByRole('textbox', { name: 'First message' }), 'Hi, I need help signing in.');
}

describe('NewTicketDialog', () => {
  it('is a labelled dialog with the customer, group, owner, priority, tags, title and message fields', async () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Start a new ticket' });
    await screen.findByRole('combobox', { name: 'Customer' });
    expect(screen.getByRole('combobox', { name: 'Group' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Owner (optional)' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'First message' })).toBeInTheDocument();
    expect(screen.getByText(/This is a public reply/)).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
  });

  it('creates the ticket and reports success', async () => {
    const { onCreated, onClose } = setup();
    server.use(
      http.post(`${API}/tickets`, () => HttpResponse.json({ id: 'ticket-99' })),
    );
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ticket-99'));
    expect(onClose).toHaveBeenCalled();
  });

  it('maps CUSTOMER_INACTIVE onto the customer field', async () => {
    setup();
    server.use(
      http.post(`${API}/tickets`, () =>
        HttpResponse.json({ error: { code: 'CUSTOMER_INACTIVE', message: 'no longer active' } }, { status: 409 }),
      ),
    );
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    const customerField = await screen.findByRole('combobox', { name: 'Customer' });
    await waitFor(() => expect(customerField).toHaveAccessibleDescription('This customer is no longer active.'));
  });

  it('maps GROUP_INACTIVE onto the group field', async () => {
    setup();
    server.use(
      http.post(`${API}/tickets`, () =>
        HttpResponse.json({ error: { code: 'GROUP_INACTIVE', message: 'no longer active' } }, { status: 409 }),
      ),
    );
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    const groupField = screen.getByRole('combobox', { name: 'Group' });
    await waitFor(() => expect(groupField).toHaveAccessibleDescription('This group is no longer active.'));
  });

  it('maps OWNER_NOT_ELIGIBLE onto the owner field', async () => {
    setup();
    server.use(
      http.post(`${API}/tickets`, () =>
        HttpResponse.json({ error: { code: 'OWNER_NOT_ELIGIBLE', message: 'not eligible' } }, { status: 409 }),
      ),
    );
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    const ownerField = screen.getByRole('combobox', { name: 'Owner (optional)' });
    await waitFor(() => expect(ownerField).toHaveAccessibleDescription('This owner no longer has edit access on the group.'));
  });

  it('shows a generic error for anything else', async () => {
    setup();
    server.use(
      http.post(`${API}/tickets`, () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'Something went wrong on our end.' } }, { status: 500 }),
      ),
    );
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/i);
  });
});
