import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CommandBar } from '../../src/components/shell/CommandBar';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

const VIEWS = [
  { id: 'view-1', name: 'My open tickets' },
  { id: 'view-2', name: 'Unassigned' },
];

function setup() {
  const onSelectView = vi.fn();
  const onOpenTicketNumber = vi.fn();
  const utils = renderWithProviders(<CommandBar views={VIEWS} onSelectView={onSelectView} onOpenTicketNumber={onOpenTicketNumber} />);
  return { onSelectView, onOpenTicketNumber, ...utils };
}

describe('CommandBar', () => {
  it('opens on Ctrl/Cmd+K and is closed until then', async () => {
    setup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Jump to' });
    expect(dialog).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
  });

  it('offers "Open ticket 1234" for a ticket number and opens it on commit', async () => {
    const { onOpenTicketNumber } = setup();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    const input = await screen.findByRole('combobox', { name: 'Jump to a view or ticket number' });
    await userEvent.type(input, '#1234');
    const option = await screen.findByRole('option', { name: /Open ticket 1234/ });
    expect(option).toBeInTheDocument();
    await userEvent.click(option);
    expect(onOpenTicketNumber).toHaveBeenCalledWith(1234);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('filters views by name and selects one', async () => {
    const { onSelectView } = setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Jump to a view or ticket number' });
    await userEvent.type(input, 'unassigned');
    const option = await screen.findByRole('option', { name: /Unassigned/ });
    await userEvent.click(option);
    expect(onSelectView).toHaveBeenCalledWith('view-2');
  });

  it('closes on Escape and returns focus to the body', async () => {
    setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Jump to' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body).toHaveFocus();
  });
});
