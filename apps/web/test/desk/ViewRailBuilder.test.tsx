import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ViewRail } from '../../src/pages/desk/inbox/ViewRail';
import { API } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server } from '../setup';

import {
  eligibleOwnersHandler,
  groupDestinationsHandler,
  makeEligibleOwner,
  makeMe,
  makeTag,
  makeView,
  meHandler,
  tagsHandler,
  viewsHandler,
} from './fixtures';

import type { PreviewViewCount200, View } from '../../src/api/generated/model';

/** ViewBuilder is a MUI drawer: a cold, instrumented first open is slow (see NewTicketDialog.test.tsx). */
const SLOW = 60_000;
const FIND = { timeout: 10_000 };

function builderEndpoints() {
  return [
    groupDestinationsHandler([{ id: 'group-1', name: 'Support' }]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
    tagsHandler([makeTag()]),
    http.post(`${API}/views/preview-count`, () => HttpResponse.json<PreviewViewCount200>({ count: 2 })),
  ];
}

describe('ViewRail view builder wiring', () => {
  it('hides "New view" without view.create', async () => {
    server.use(meHandler(makeMe({ permissions: ['ticket.view'] })), viewsHandler([makeView()]));
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);
    await screen.findByRole('button', { name: /My open tickets/ });
    expect(screen.queryByRole('button', { name: 'New view' })).not.toBeInTheDocument();
  });

  it('shows "New view" with view.create, opens the builder and selects the created view', async () => {
    const created = makeView({ id: 'view-42', name: 'Fresh' });
    server.use(
      meHandler(makeMe({ permissions: ['view.create'] })),
      viewsHandler([makeView()]),
      ...builderEndpoints(),
      http.post(`${API}/views`, () => HttpResponse.json<View>(created, { status: 201 })),
    );
    const onSelectView = vi.fn();
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={onSelectView} />);

    await userEvent.click(await screen.findByRole('button', { name: 'New view' }, FIND));
    expect(await screen.findByRole('dialog', { name: 'New view' }, FIND)).toBeInTheDocument();

    await userEvent.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Fresh');
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(onSelectView).toHaveBeenCalledWith('view-42'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New view' })).not.toBeInTheDocument());
  }, SLOW);

  it('offers Edit only on editable views, described by the view name, and opens it with the view', async () => {
    server.use(
      meHandler(makeMe()),
      viewsHandler([
        makeView({ id: 'view-1', name: 'Mine', editable: true, position: 0, conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: ['open'] }] }, columns: ['title'] }),
        makeView({ id: 'view-2', name: 'Shared', editable: false, position: 1 }),
      ]),
      ...builderEndpoints(),
    );
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={vi.fn()} />);

    const edit = await screen.findByRole('button', { name: 'Edit view' }, FIND);
    expect(screen.getAllByRole('button', { name: 'Edit view' })).toHaveLength(1);
    expect(edit).toHaveAccessibleDescription('Mine');

    await userEvent.click(edit);
    expect(await screen.findByRole('dialog', { name: 'Edit view' }, FIND)).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: /^Name/ })).toHaveValue('Mine');
  }, SLOW);

  it('selects a saved view from the rail', async () => {
    server.use(meHandler(makeMe()), viewsHandler([makeView({ id: 'view-1', name: 'Mine' })]));
    const onSelectView = vi.fn();
    renderWithProviders(<ViewRail activeViewId={undefined} onSelectView={onSelectView} />);
    await userEvent.click(await screen.findByRole('button', { name: /Mine/ }));
    expect(onSelectView).toHaveBeenCalledWith('view-1');
  });
});
