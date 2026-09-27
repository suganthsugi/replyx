import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ViewRail } from '../../src/pages/desk/inbox/ViewRail';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

import { makeView, reorderViewsHandler, viewCountsHandler, viewsHandler } from './fixtures';

describe('ViewRail', () => {
  it('shows a loading status, then the views with counts, marking the active one', async () => {
    server.use(viewsHandler([makeView({ id: 'view-1', name: 'My open tickets', count: 3, position: 0 }), makeView({ id: 'view-2', name: 'Unassigned', count: 0, position: 1 })]));
    const { container } = renderWithProviders(<ViewRail activeViewId="view-2" onSelectView={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading views');
    expect(await screen.findByRole('button', { name: /My open tickets/ })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unassigned' })).toHaveAttribute('aria-current', 'page');
    await expectNoAxeViolations(container);
  });

  it('shows an empty state when there are no views', async () => {
    server.use(viewsHandler([]));
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    expect(await screen.findByText('No views yet')).toBeInTheDocument();
  });

  it('shows a retryable error when views fail to load', async () => {
    server.use(http.get(`${API}/views`, () => errorResponse(500, 'INTERNAL')));
    const { container } = renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    expect(await screen.findByText("Couldn't load views")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('prefers the live count over the view\'s own count once it loads', async () => {
    server.use(
      viewsHandler([makeView({ id: 'view-1', name: 'My open tickets', count: 3, position: 0 })]),
      viewCountsHandler({ 'view-1': 9 }),
    );
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    expect(await screen.findByText('9')).toBeInTheDocument();
  });
});

describe('ViewRail arranging', () => {
  it('lists every view, including hidden ones, only in arrange mode', async () => {
    server.use(
      viewsHandler([
        makeView({ id: 'view-1', name: 'My open tickets', position: 0, hidden: false }),
        makeView({ id: 'view-2', name: 'Archived', position: 1, hidden: true }),
      ]),
    );
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    await screen.findByRole('button', { name: /My open tickets/ });
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Arrange views' }));
    const list = screen.getByRole('list', { name: 'Arrange views' });
    expect(within(list).getByText('My open tickets')).toBeInTheDocument();
    expect(within(list).getByText(/Archived/)).toBeInTheDocument();
    // Move up on the first row and down on the last are out of bounds.
    expect(within(list).getByRole('button', { name: 'Move My open tickets up' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(list).getByRole('button', { name: 'Move Archived down' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('moves a view up, saves the swapped positions, and announces the move', async () => {
    server.use(
      viewsHandler([
        makeView({ id: 'view-1', name: 'My open tickets', position: 0, editable: true }),
        makeView({ id: 'view-2', name: 'Unassigned', position: 1, editable: true }),
      ]),
      reorderViewsHandler(),
    );
    const { container } = renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arrange views' }));

    const moveUp = screen.getByRole('button', { name: 'Move Unassigned up' });
    await userEvent.click(moveUp);

    await waitFor(() => expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Unassigned moved up'));
    // The pressed button keeps focus through the save and re-render (it is never `disabled`).
    expect(screen.getByRole('button', { name: 'Move Unassigned up' })).toHaveFocus();
  });

  it('hides a view through the Show/Hide toggle', async () => {
    server.use(viewsHandler([makeView({ id: 'view-1', name: 'My open tickets', position: 0, editable: true, hidden: false })]), reorderViewsHandler());
    const { container } = renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arrange views' }));

    await userEvent.click(screen.getByRole('button', { name: 'Hide My open tickets' }));

    await waitFor(() => expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('My open tickets hidden'));
  });

  it('disables the move and hide controls for a view that is not editable', async () => {
    server.use(
      viewsHandler([
        makeView({ id: 'view-1', name: 'All open', position: 0, editable: false }),
        makeView({ id: 'view-2', name: 'Mine', position: 1, editable: true }),
      ]),
    );
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arrange views' }));

    expect(screen.getByRole('button', { name: 'Move All open up' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Move All open down' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Hide All open' })).toHaveAttribute('aria-disabled', 'true');
  });
});
