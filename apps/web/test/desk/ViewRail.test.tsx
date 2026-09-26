import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ViewRail } from '../../src/pages/desk/inbox/ViewRail';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server, expectNoAxeViolations  } from '../setup';

import { makeView, viewsHandler } from './fixtures';

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
});
