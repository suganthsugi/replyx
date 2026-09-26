import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { CustomerDrawer } from '../../src/pages/desk/customers/CustomerDrawer';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

import { customerHandler, makeCustomerProfile, makeMe, makeTicket, meHandler } from './fixtures';

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
});
