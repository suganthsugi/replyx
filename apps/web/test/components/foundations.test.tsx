import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from '../../src/components/foundations/EmptyState';
import { useAnnounce } from '../../src/components/foundations/LiveRegion';
import { Skeleton } from '../../src/components/foundations/Skeleton';
import { VisuallyHidden } from '../../src/components/foundations/VisuallyHidden';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

describe('EmptyState', () => {
  it('shows an empty state with its action', async () => {
    const onClick = vi.fn();
    const { container } = renderWithProviders(
      <EmptyState title="No tickets" message="New conversations appear here." action={{ label: 'Create a view', onClick }} />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'No tickets' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create a view' }));
    expect(onClick).toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('shows an error as an alert with a retry', async () => {
    const onRetry = vi.fn();
    const { container } = renderWithProviders(
      <EmptyState variant="error" title="Could not load tickets" message="Check your connection." onRetry={onRetry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });
});

describe('Skeleton', () => {
  it('announces what is loading and hides the placeholders', async () => {
    const { container } = renderWithProviders(<Skeleton variant="list" rows={4} label="tickets" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading tickets');
    await expectNoAxeViolations(container);
  });
});

describe('LiveRegion', () => {
  function Announcer() {
    const announce = useAnnounce();
    return (
      <>
        <button type="button" onClick={() => announce('New message from Priya')}>
          Polite
        </button>
        <button type="button" onClick={() => announce('Message failed to send', 'assertive')}>
          Assertive
        </button>
      </>
    );
  }

  it('announces politely and assertively from one region per area', async () => {
    const { container } = renderWithProviders(<Announcer />);
    await userEvent.click(screen.getByRole('button', { name: 'Polite' }));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('New message from Priya');
    await userEvent.click(screen.getByRole('button', { name: 'Assertive' }));
    expect(container.ownerDocument.querySelector('[aria-live="assertive"]')).toHaveTextContent('Message failed to send');
    await expectNoAxeViolations(container);
  });

  it('refuses to be used outside its provider', () => {
    function Bare() {
      useAnnounce();
      return null;
    }
    // React logs the thrown render error; keep the test output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow('LiveRegionProvider');
    spy.mockRestore();
  });
});

describe('VisuallyHidden', () => {
  it('keeps text available to assistive technology', () => {
    renderWithProviders(
      <button type="button">
        <span aria-hidden="true">×</span>
        <VisuallyHidden>Remove tag</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Remove tag' })).toBeInTheDocument();
  });
});
