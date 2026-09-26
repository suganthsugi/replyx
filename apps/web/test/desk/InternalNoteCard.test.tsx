import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InternalNoteCard } from '../../src/components/tickets/InternalNoteCard';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import { makeMessage } from './fixtures';

describe('InternalNoteCard', () => {
  it('is labelled "Internal note" and never reads as a customer-visible reply', async () => {
    const message = makeMessage({ visibility: 'internal', body: 'Waiting on billing to confirm the refund.', author: { id: 'agent-1', name: 'Ada Agent' } });
    const { container } = renderWithProviders(
      <ul>
        <InternalNoteCard message={message} />
      </ul>,
    );
    expect(screen.getByText(/Internal note · Ada Agent/)).toBeInTheDocument();
    expect(screen.getByText('Waiting on billing to confirm the refund.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
