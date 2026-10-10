import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { CommandBar } from '../../src/components/shell/CommandBar';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { customerResult, searchHandler, ticketResult } from './fixtures';

import type { SearchTickets200 } from '../../src/api/generated/model';

const VIEWS = [{ id: 'view-1', name: 'My open tickets' }];

function setup() {
  const handlers = {
    onSelectView: vi.fn(),
    onOpenTicketNumber: vi.fn(),
    onOpenTicket: vi.fn(),
    onOpenSearch: vi.fn(),
  };
  const utils = renderWithProviders(<CommandBar views={VIEWS} {...handlers} />);
  return { ...handlers, ...utils };
}

async function typeQuery(text: string) {
  await userEvent.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Jump to a view or ticket number' });
  await userEvent.type(input, text);
  return input;
}

describe('CommandBar search', () => {
  it('shows quick search results next to views, with the highlight as a mark', async () => {
    const seen: URL[] = [];
    server.use(
      searchHandler(
        () => ({
          items: [ticketResult('t-1', 4471, 'Billing', 'About ⟦invoice⟧ 4471'), customerResult('c-1', 'Ines Invoice', 'ines@example.com')],
          nextCursor: null,
        }),
        seen,
      ),
    );
    setup();
    await typeQuery('invoice');
    const dialog = await screen.findByRole('dialog');
    const ticket = await within(dialog).findByRole('option', { name: /#4471 Billing/ });
    expect(within(ticket).getByText('invoice').tagName).toBe('MARK');
    expect(within(dialog).getByRole('option', { name: /Ines Invoice/ })).toHaveTextContent('Customer · ines@example.com');
    expect(ticket).toHaveTextContent('Cara Customer · About invoice 4471');
    expect(within(dialog).getByRole('option', { name: /See all results for "invoice"/ })).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.searchParams.get('type')).toBe('all');
    expect(seen[0]?.searchParams.get('limit')).toBe('8');
    await expectNoAxeViolations(dialog);
  });

  it('opens a found ticket', async () => {
    server.use(searchHandler(() => ({ items: [ticketResult('t-1', 4471, 'Billing')], nextCursor: null })));
    const { onOpenTicket } = setup();
    await typeQuery('bill');
    await userEvent.click(await screen.findByRole('option', { name: /#4471 Billing/ }));
    expect(onOpenTicket).toHaveBeenCalledWith('t-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it("shows a found customer's tickets in the results page", async () => {
    server.use(searchHandler(() => ({ items: [customerResult('c-1', 'Ines Invoice', 'ines@example.com')], nextCursor: null })));
    const { onOpenSearch } = setup();
    await typeQuery('ines');
    await userEvent.click(await screen.findByRole('option', { name: /Ines Invoice/ }));
    expect(onOpenSearch).toHaveBeenCalledWith('ines@example.com', 'tickets');
  });

  it('"See all results" opens the results page with the trimmed query', async () => {
    server.use(searchHandler(() => ({ items: [], nextCursor: null })));
    const { onOpenSearch } = setup();
    await typeQuery('  refund ');
    await userEvent.click(await screen.findByRole('option', { name: /See all results for "refund"/ }));
    expect(onOpenSearch).toHaveBeenCalledWith('refund');
  });

  it('keeps ticket-by-number working alongside search', async () => {
    server.use(searchHandler(() => ({ items: [], nextCursor: null })));
    const { onOpenTicketNumber } = setup();
    await typeQuery('#1234');
    await userEvent.click(await screen.findByRole('option', { name: /Open ticket 1234/ }));
    expect(onOpenTicketNumber).toHaveBeenCalledWith(1234);
  });

  it('does not search when no search handler is provided', async () => {
    const seen: URL[] = [];
    server.use(searchHandler(() => ({ items: [], nextCursor: null }), seen));
    renderWithProviders(<CommandBar views={VIEWS} onSelectView={vi.fn()} onOpenTicketNumber={vi.fn()} />);
    await typeQuery('refund');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toHaveLength(0);
  });

  it('shows and announces "Searching…" while the request is in flight', async () => {
    // Held until released, not a fixed delay: under load a short delay could end before the checks.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API}/search`, async () => {
        await held;
        return HttpResponse.json<SearchTickets200>({ items: [], nextCursor: null });
      }),
    );
    setup();
    await typeQuery('refund');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Searching…')).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Searching');
    release();
    await waitFor(() => expect(within(dialog).queryByText('Searching…')).not.toBeInTheDocument());
  });

  it('shows and announces a search failure, and keeps the views usable', async () => {
    server.use(http.get(`${API}/search`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    setup();
    await typeQuery('tickets');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Search is unavailable/)).toBeInTheDocument();
    expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent('Search is unavailable');
    expect(within(dialog).getByRole('option', { name: /My open tickets/ })).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
  });
});
