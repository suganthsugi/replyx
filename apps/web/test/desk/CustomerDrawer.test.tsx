import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { CustomerDrawer } from '../../src/pages/desk/customers/CustomerDrawer';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

import { customerHandler, makeCustomerProfile, makeMe, makeTicket, meHandler, tagsHandler } from './fixtures';

import type { CustomerProfile } from '../../src/api/generated/model';

describe('CustomerDrawer', () => {
  it('shows nothing selected until a customer is chosen', () => {
    renderWithProviders(<CustomerDrawer customerId={null} open onClose={vi.fn()} onOpenTicket={vi.fn()} />);
    expect(screen.getByText('No customer selected')).toBeInTheDocument();
  });

  it('shows a loading state, then the profile with tags and tickets', async () => {
    server.use(
      meHandler(makeMe()),
      customerHandler(
        makeCustomerProfile({
          id: 'customer-1',
          tags: [{ id: 'tag-1', name: 'vip' }],
          openTickets: [makeTicket({ id: 'ticket-1', number: 42, title: 'Billing question' })],
          closedTickets: [],
        }),
      ),
    );
    const { container } = renderWithProviders(<CustomerDrawer customerId="customer-1" open onClose={vi.fn()} onOpenTicket={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('cara@customer.test')).toBeInTheDocument();
    expect(screen.getByText('vip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Billing question/ })).toBeInTheDocument();
    expect(screen.getByText('No closed tickets.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows a retryable error when the customer fails to load', async () => {
    server.use(http.get(`${API}/customers/customer-1`, () => errorResponse(500, 'INTERNAL')));
    const { container } = renderWithProviders(<CustomerDrawer customerId="customer-1" open onClose={vi.fn()} onOpenTicket={vi.fn()} />);
    expect(await screen.findByText("Couldn't load this customer")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('moves focus to the Name field when Edit is activated, and back to Edit on Cancel', async () => {
    const user = userEvent.setup();
    server.use(meHandler(makeMe()), customerHandler(makeCustomerProfile({ id: 'customer-1' })), tagsHandler([]));
    renderWithProviders(<CustomerDrawer customerId="customer-1" open onClose={vi.fn()} onOpenTicket={vi.fn()} />);

    const editButton = await screen.findByRole('button', { name: 'Edit' });
    await user.click(editButton);

    const nameField = await screen.findByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(nameField).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const editButtonAgain = await screen.findByRole('button', { name: 'Edit' });
    await waitFor(() => expect(editButtonAgain).toHaveFocus());
  });

  it('returns focus to Edit after a successful save', async () => {
    const user = userEvent.setup();
    const profile = makeCustomerProfile({ id: 'customer-1', name: 'Cara Customer' });
    server.use(
      meHandler(makeMe()),
      customerHandler(profile),
      tagsHandler([]),
      http.patch(`${API}/customers/customer-1`, () => HttpResponse.json<CustomerProfile>({ ...profile, name: 'Cara Customerson' })),
    );
    renderWithProviders(<CustomerDrawer customerId="customer-1" open onClose={vi.fn()} onOpenTicket={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('textbox', { name: 'Name' });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const editButtonAgain = await screen.findByRole('button', { name: 'Edit' });
    await waitFor(() => expect(editButtonAgain).toHaveFocus());
  });
});
