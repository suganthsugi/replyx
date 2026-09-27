import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { TicketList } from '../../src/components/tickets/TicketList';
import { renderWithProviders } from '../render';

import { makeTicketSummary } from './fixtures';

import type { TicketSummary } from '../../src/data/tickets';

/**
 * `useVirtualRows` sizes its viewport from the container's `clientHeight`, which jsdom always
 * reports as 0. Mocking it on the prototype lets these tests control how many rows mount, the way
 * a real scrollable pane would.
 */
function mockClientHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: height });
}

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 0 });
});

function makeTickets(count: number): TicketSummary[] {
  return Array.from({ length: count }, (_, index) =>
    makeTicketSummary({ id: `ticket-${index + 1}`, number: 1000 + index, title: `Ticket ${index + 1}` }),
  );
}

describe('TicketList', () => {
  it('keeps aria-setsize and aria-posinset in sync with the ticket count, including after scrolling', () => {
    mockClientHeight(400);
    const tickets = makeTickets(40);
    const { container } = renderWithProviders(<TicketList tickets={tickets} label="My tickets" onOpenTicket={() => undefined} />);

    const initialOptions = screen.getAllByRole('option');
    expect(initialOptions.length).toBeGreaterThan(0);
    for (const option of initialOptions) {
      expect(option).toHaveAttribute('aria-setsize', '40');
      const posinset = Number(option.getAttribute('aria-posinset'));
      expect(posinset).toBeGreaterThanOrEqual(1);
      expect(posinset).toBeLessThanOrEqual(40);
    }

    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    listbox.scrollTop = 30 * 84;
    fireEvent.scroll(listbox);

    const scrolledOptions = screen.getAllByRole('option');
    expect(scrolledOptions.length).toBeGreaterThan(0);
    for (const option of scrolledOptions) {
      expect(option).toHaveAttribute('aria-setsize', '40');
      const posinset = Number(option.getAttribute('aria-posinset'));
      expect(posinset).toBeGreaterThanOrEqual(1);
      expect(posinset).toBeLessThanOrEqual(40);
    }
    // Scrolling well past the top should have moved the mounted window forward.
    const maxPosinset = Math.max(...scrolledOptions.map((option) => Number(option.getAttribute('aria-posinset'))));
    expect(maxPosinset).toBeGreaterThan(10);
  });

  it('clamps the roving tab stop and focus to the last row when the list shrinks after End', async () => {
    mockClientHeight(2000);
    const user = userEvent.setup();
    const tickets = makeTickets(5);
    const { rerender } = renderWithProviders(<TicketList tickets={tickets} label="My tickets" onOpenTicket={() => undefined} />);

    const options = screen.getAllByRole('option');
    options[0]!.focus();
    await user.keyboard('{End}');

    expect(screen.getAllByRole('option')[4]!).toHaveFocus();

    const fewerTickets = makeTickets(3);
    rerender(<TicketList tickets={fewerTickets} label="My tickets" onOpenTicket={() => undefined} />);

    const remainingOptions = screen.getAllByRole('option');
    const focusable = remainingOptions.filter((option) => option.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toBe(remainingOptions[remainingOptions.length - 1]);
    expect(document.activeElement).toBe(remainingOptions[remainingOptions.length - 1]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not steal focus back into the list after a blur to dead space, then a shrink', () => {
    mockClientHeight(2000);
    const tickets = makeTickets(5);
    const { rerender } = renderWithProviders(<TicketList tickets={tickets} label="My tickets" onOpenTicket={() => undefined} />);

    const options = screen.getAllByRole('option');
    options[4]!.focus();
    expect(options[4]!).toHaveFocus();

    // A blur to nowhere focusable (dead space, a window blur): the row stays in the DOM, so this
    // is a real focus loss, not a shrink removing the focused row. `.blur()` (unlike
    // `fireEvent.blur`) actually moves `document.activeElement`, which then falls back to <body>.
    options[4]!.blur();
    expect(document.activeElement).toBe(document.body);

    const fewerTickets = makeTickets(3);
    rerender(<TicketList tickets={fewerTickets} label="My tickets" onOpenTicket={() => undefined} />);

    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus through several rows while ArrowDown is held', async () => {
    mockClientHeight(2000);
    const user = userEvent.setup();
    const tickets = makeTickets(6);
    renderWithProviders(<TicketList tickets={tickets} label="My tickets" onOpenTicket={() => undefined} />);

    const options = screen.getAllByRole('option');
    options[0]!.focus();
    await user.keyboard('{ArrowDown>3/}');

    expect(screen.getAllByRole('option')[3]!).toHaveFocus();
  });
});
