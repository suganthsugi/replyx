import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { TicketState } from '../../src/api/generated/model';
import { StateSelector } from '../../src/components/inputs/StateSelector';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

function Controlled() {
  const [state, setState] = useState<{ state: TicketState; pendingUntil: string | null }>({ state: TicketState.open, pendingUntil: null });
  return (
    <StateSelector
      value={state.state}
      pendingUntil={state.pendingUntil}
      onChange={setState}
      minPendingUntil="2026-09-26T00:00"
    />
  );
}

describe('StateSelector', () => {
  it('has no pending-date field for a non-pending state', async () => {
    const { container } = renderWithProviders(<Controlled />);
    expect(screen.queryByLabelText(/Remind at|Close at/)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('opens and picks a state with the keyboard, then requires a pending date', async () => {
    const { container } = renderWithProviders(<Controlled />);
    const select = screen.getByRole('combobox', { name: 'State' });
    select.focus();
    await userEvent.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    const field = await screen.findByLabelText(/Remind at/);
    expect(field).toBeRequired();
    expect(field).toHaveValue('2026-09-26T00:00');
    await expectNoAxeViolations(container);
  });

  it('disables the select and any pending field when disabled', () => {
    function DisabledPending() {
      return <StateSelector value={TicketState.pending_close} pendingUntil="2026-10-01T09:00:00.000Z" onChange={() => undefined} disabled />;
    }
    renderWithProviders(<DisabledPending />);
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText(/Close at/)).toBeDisabled();
  });
});
