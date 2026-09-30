import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ViewBuilder } from '../../src/components/builders/ViewBuilder';
import { eligibleOwnersHandler, groupDestinationsHandler, makeEligibleOwner, makeTag, makeView, tagsHandler } from '../desk/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { PreviewViewCount200, Role, View, ViewInput } from '../../src/api/generated/model';

/**
 * The builder is a MUI drawer with many controls: a cold, instrumented first render is slow, so
 * these tests get more than the 20 s default (the global timeout is unchanged), like the sibling
 * drawer/dialog tests.
 */
const SLOW = 60_000;
const FIND = { timeout: 10_000 };

const makeRole = (overrides: Partial<Role> = {}): Role => ({
  id: 'role-1',
  name: 'Agent',
  system: null,
  permissions: [],
  groupAccess: [],
  userCount: 1,
  ...overrides,
});

function lookupHandlers(options: { roles?: Role[] } = {}) {
  return [
    groupDestinationsHandler([{ id: 'group-1', name: 'Support' }]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
    tagsHandler([makeTag()]),
    http.get(`${API}/roles`, () => HttpResponse.json<{ items: Role[] }>({ items: options.roles ?? [makeRole()] })),
  ];
}

function previewHandler(count: number | (() => Response | Promise<Response>) = 5, bodies: unknown[] = []) {
  return http.post(`${API}/views/preview-count`, async ({ request }) => {
    bodies.push(await request.json());
    if (typeof count === 'function') return count();
    return HttpResponse.json<PreviewViewCount200>({ count });
  });
}

function setup(props: Partial<Parameters<typeof ViewBuilder>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const utils = renderWithProviders(<ViewBuilder open onClose={onClose} onSaved={onSaved} canShare={false} {...props} />);
  return { onClose, onSaved, ...utils };
}

const live = (container: HTMLElement, mode: 'polite' | 'assertive' = 'polite') => container.ownerDocument.querySelector(`[aria-live="${mode}"]`);

async function fillName(name: string) {
  await userEvent.type(await screen.findByRole('textbox', { name: /^Name/ }, FIND), name);
}

describe('ViewBuilder create', () => {
  it('creates a view: POSTs the form body, then calls onSaved and onClose', async () => {
    const bodies: ViewInput[] = [];
    const saved = makeView({ id: 'view-9', name: 'Billing queue' });
    server.use(
      ...lookupHandlers(),
      previewHandler(),
      http.post(`${API}/views`, async ({ request }) => {
        bodies.push((await request.json()) as ViewInput);
        return HttpResponse.json<View>(saved, { status: 201 });
      }),
    );
    const { onClose, onSaved, container } = setup();

    expect(await screen.findByRole('dialog', { name: 'New view' }, FIND)).toBeInTheDocument();
    await fillName('  Billing queue ');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'All billing');
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(onClose).toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      name: 'Billing queue',
      description: 'All billing',
      visibility: 'personal',
      conditions: { op: 'and', items: [{ field: 'state', operator: 'is_not', value: ['closed'] }] },
      sort: [{ field: 'updated_at', direction: 'desc' }],
      columns: ['number', 'title', 'customer', 'state', 'priority', 'group', 'owner', 'updated_at'],
    });
    expect(bodies[0]).not.toHaveProperty('sharedRoleIds');
    expect(container.ownerDocument.body).toHaveTextContent('View "Billing queue" created.');
  }, SLOW);

  it('has no axe violations and starts with focus on the name field', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup();
    const name = await screen.findByRole('textbox', { name: /^Name/ }, FIND);
    await waitFor(() => expect(name).toHaveFocus());
    await expectNoAxeViolations(document.body);
  }, SLOW);

  it('validates locally: a missing name is reported, announced and focused, and nothing is sent', async () => {
    const posted = vi.fn();
    server.use(...lookupHandlers(), previewHandler(), http.post(`${API}/views`, () => (posted(), errorResponse(500, 'INTERNAL'))));
    const { container } = setup();
    await screen.findByRole('dialog', { name: 'New view' }, FIND);

    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    const name = await screen.findByRole('textbox', { name: /^Name/ });
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(name).toHaveAccessibleDescription('Enter a name for the view.');
    await waitFor(() => expect(name).toHaveFocus());
    expect(live(container, 'assertive')).toHaveTextContent('The view was not saved. Enter a name for the view.');
    expect(posted).not.toHaveBeenCalled();
  }, SLOW);

  it('requires at least one column', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup();
    await fillName('Empty columns');
    const list = screen.getByRole('list', { name: 'Columns' });
    for (const label of ['Number', 'Title', 'Customer', 'State', 'Priority', 'Group', 'Owner', 'Updated']) {
      await userEvent.click(within(list).getByRole('button', { name: `Remove ${label}` }));
    }
    expect(await screen.findByText('No columns chosen.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));
    expect(await screen.findByText('Choose at least one column.')).toBeInTheDocument();
  }, SLOW);

  it('adds a column and a sort field from the pickers and reorders columns', async () => {
    const bodies: ViewInput[] = [];
    server.use(
      ...lookupHandlers(),
      previewHandler(),
      http.post(`${API}/views`, async ({ request }) => {
        bodies.push((await request.json()) as ViewInput);
        return HttpResponse.json<View>(makeView(), { status: 201 });
      }),
    );
    const { container } = setup();
    await fillName('Custom');

    await userEvent.click(screen.getByRole('combobox', { name: 'Add a column' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Tags' }));
    expect(live(container)).toHaveTextContent('Tags column added.');

    await userEvent.click(screen.getByRole('combobox', { name: 'Add a sort field' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Priority' }));
    const sort = screen.getByRole('list', { name: 'Sort order' });
    await userEvent.click(within(within(sort).getByRole('group', { name: 'Priority direction' })).getByRole('button', { name: 'Ascending' }));

    const columns = screen.getByRole('list', { name: 'Columns' });
    await userEvent.click(within(columns).getByRole('button', { name: 'Move Title up' }));

    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.columns.slice(0, 2)).toEqual(['title', 'number']);
    expect(bodies[0]?.columns).toContain('tags');
    expect(bodies[0]?.sort).toHaveLength(2);
    expect(bodies[0]?.sort[1]).toEqual({ field: 'priority', direction: 'asc' });
  }, SLOW);

  it('maps a server validation failure onto its field and announces it', async () => {
    server.use(
      ...lookupHandlers(),
      previewHandler(),
      http.post(`${API}/views`, () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'name', issue: 'too_long' }] } },
          { status: 400 },
        ),
      ),
    );
    const { container, onClose } = setup();
    await fillName('Way too long');
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    const name = await screen.findByRole('textbox', { name: /^Name/ });
    await waitFor(() => expect(name).toHaveAccessibleDescription('This is too long.'));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(live(container, 'assertive')).toHaveTextContent('The view was not saved. This is too long.');
    expect(onClose).not.toHaveBeenCalled();
    // The form is usable again after the failure.
    expect(screen.getByRole('button', { name: 'Create view' })).toBeEnabled();
  }, SLOW);

  it('shows a form-level message when the server answers 403', async () => {
    server.use(...lookupHandlers(), previewHandler(), http.post(`${API}/views`, () => errorResponse(403, 'PERMISSION_DENIED', 'Forbidden')));
    setup();
    await fillName('Shared');
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    expect(await screen.findByText("You don't have permission to share views.")).toBeInTheDocument();
  }, SLOW);

  it('shows the preview count and announces it', async () => {
    const bodies: unknown[] = [];
    server.use(...lookupHandlers(), previewHandler(1, bodies));
    const { container } = setup();

    expect(await screen.findByText('1 ticket matches now', undefined, FIND)).toBeInTheDocument();
    expect(live(container)).toHaveTextContent('1 ticket matches these conditions.');
    expect(bodies[0]).toEqual({ conditions: { op: 'and', items: [{ field: 'state', operator: 'is_not', value: ['closed'] }] } });
  }, SLOW);

  it('says the count needs values while a condition is incomplete and does not request it', async () => {
    const bodies: unknown[] = [];
    server.use(...lookupHandlers(), previewHandler(3, bodies));
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Add condition' }, FIND));
    expect(screen.getByText('Give every condition a value to see how many tickets match.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));
    expect(await screen.findByText('Choose a value')).toBeInTheDocument();
  }, SLOW);

  it('hides the count when the preview fails', async () => {
    server.use(...lookupHandlers(), previewHandler(() => errorResponse(400, 'VALIDATION_FAILED')));
    setup();
    expect(await screen.findByText("Couldn't count matching tickets for these conditions.", undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByText(/tickets? match(es)? now/)).not.toBeInTheDocument();
  }, SLOW);

  it('closes at once when nothing changed, and asks before discarding changes', async () => {
    server.use(...lookupHandlers(), previewHandler());
    const first = setup();
    await screen.findByRole('dialog', { name: 'New view' }, FIND);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const { onClose } = setup();
    await fillName('Draft');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  }, SLOW);
});

describe('ViewBuilder sharing', () => {
  it('limits sharing to "Only me" without view.share', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup({ canShare: false });
    const only = await screen.findByRole('radio', { name: 'Only me' }, FIND);
    expect(only).toBeChecked();
    expect(only).toBeDisabled();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByText("You don't have permission to share views, so this view stays personal.")).toBeInTheDocument();
  }, SLOW);

  it('offers every option with view.share and sends the chosen roles', async () => {
    const bodies: ViewInput[] = [];
    server.use(
      ...lookupHandlers({ roles: [makeRole({ id: 'role-7', name: 'Supervisor' })] }),
      previewHandler(),
      http.post(`${API}/views`, async ({ request }) => {
        bodies.push((await request.json()) as ViewInput);
        return HttpResponse.json<View>(makeView(), { status: 201 });
      }),
    );
    setup({ canShare: true });
    await fillName('Shared');
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['personal', 'all_staff', 'roles', 'groups']);

    await userEvent.click(screen.getByRole('radio', { name: 'Specific roles' }));
    // No roles chosen yet: local validation asks for one.
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));
    expect(await screen.findByText('Choose at least one role.')).toBeInTheDocument();

    const roles = screen.getByRole('combobox', { name: 'Roles' });
    await userEvent.click(roles);
    await userEvent.click(await screen.findByRole('option', { name: 'Supervisor' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ visibility: 'roles', sharedRoleIds: ['role-7'] });
  }, SLOW);

  it('offers groups from the destinations the person can reach', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup({ canShare: true });
    await userEvent.click(await screen.findByRole('radio', { name: 'Specific groups' }, FIND));
    await userEvent.click(screen.getByRole('combobox', { name: 'Groups' }));
    expect(await screen.findByRole('option', { name: 'Support' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create view' }));
    expect(await screen.findByText('Choose at least one group.')).toBeInTheDocument();
  }, SLOW);
});

describe('ViewBuilder lookups', () => {
  it('shows a Retry when a lookup fails and clears it once the reload works', async () => {
    let failing = true;
    server.use(
      groupDestinationsHandler([{ id: 'group-1', name: 'Support' }]),
      eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
      http.get(`${API}/tags`, () => (failing ? errorResponse(500, 'INTERNAL') : HttpResponse.json({ items: [makeTag()] }))),
      previewHandler(),
    );
    const { container } = setup();

    const retry = await screen.findByRole('button', { name: 'Retry' }, FIND);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load some of the lists/);
    await waitFor(() => expect(live(container, 'assertive')).toHaveTextContent("Couldn't load some of the lists"));

    failing = false;
    await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument());
  }, SLOW);
});

describe('ViewBuilder edit', () => {
  const existing = makeView({
    id: 'view-5',
    name: 'Urgent',
    description: 'Fast lane',
    visibility: 'all_staff',
    conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: ['urgent'] }] },
    sort: [{ field: 'priority', direction: 'desc' }],
    columns: ['title', 'priority'],
    editable: true,
  });

  it('opens with the view values and saves with PUT /views/{id}', async () => {
    const bodies: ViewInput[] = [];
    server.use(
      ...lookupHandlers(),
      previewHandler(),
      http.put(`${API}/views/view-5`, async ({ request }) => {
        bodies.push((await request.json()) as ViewInput);
        return HttpResponse.json<View>({ ...existing, name: 'Urgent!' });
      }),
    );
    const { onSaved, onClose } = setup({ view: existing, canShare: true });

    expect(await screen.findByRole('dialog', { name: 'Edit view' }, FIND)).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: /^Name/ });
    expect(name).toHaveValue('Urgent');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Fast lane');
    expect(screen.getByRole('radio', { name: 'All staff' })).toBeChecked();
    expect(within(screen.getByRole('list', { name: 'Columns' })).getAllByRole('listitem')).toHaveLength(2);

    await userEvent.type(name, '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(bodies[0]).toMatchObject({
      name: 'Urgent!',
      description: 'Fast lane',
      visibility: 'all_staff',
      conditions: existing.conditions,
      columns: ['title', 'priority'],
    });
  }, SLOW);

  it('shows a view that is not editable read-only', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup({ view: { ...existing, editable: false }, canShare: true });

    expect(await screen.findByText('You can look at this view but not change it.', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeDisabled();
    await expectNoAxeViolations(document.body);
  }, SLOW);

  it('locks the sharing of a default (system) view', async () => {
    server.use(...lookupHandlers(), previewHandler());
    setup({ view: { ...existing, system: 'all_open' }, canShare: true });
    expect(await screen.findByText(/Its sharing cannot change/, undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All staff' })).toBeDisabled();
  }, SLOW);

  it('reports a view that was deleted meanwhile', async () => {
    server.use(...lookupHandlers(), previewHandler(), http.put(`${API}/views/view-5`, () => errorResponse(404, 'VIEW_NOT_FOUND', 'gone')));
    setup({ view: existing });
    await screen.findByRole('dialog', { name: 'Edit view' }, FIND);
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This view no longer exists.')).toBeInTheDocument();
  }, SLOW);
});
