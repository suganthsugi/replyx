import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import MacrosPage from '../../src/pages/admin/macros/MacrosPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Group, ListMacros200, Macro, MacroInput, Me, Role, TagRef } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const ALL = ['macro.view', 'macro.create', 'macro.edit', 'macro.delete'];

const me = (permissions: string[]): Me => ({
  id: 'u1',
  email: 'ada@acme.test',
  name: 'Ada',
  kind: 'staff',
  roles: [],
  permissions,
  groupAccess: [],
  accessVersion: 1,
});

function macro(overrides: Partial<Macro> = {}): Macro {
  return { id: 'm1', name: 'Refund issued', body: 'We have refunded you.', actions: { state: 'resolved' }, visibility: 'all_staff', sharedRoleIds: [], sharedGroupIds: [], ...overrides };
}

function seed(initial: Macro[], permissions = ALL) {
  const state = { macros: [...initial], created: [] as MacroInput[] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me(permissions))),
    http.get(`${API}/roles`, () => HttpResponse.json<{ items: Role[] }>({ items: [] })),
    http.get(`${API}/groups`, () => HttpResponse.json<{ items: Group[] }>({ items: [] })),
    http.get(`${API}/tags`, () => HttpResponse.json<{ items: TagRef[] }>({ items: [] })),
    http.get(`${API}/macros`, () => HttpResponse.json<ListMacros200>({ items: state.macros })),
    http.post(`${API}/macros`, async ({ request }) => {
      const body = (await request.json()) as MacroInput;
      state.created.push(body);
      const created = macro({ id: `m${state.macros.length + 1}`, name: body.name, body: body.body, actions: body.actions ?? {} });
      state.macros = [...state.macros, created];
      return HttpResponse.json<Macro>(created, { status: 201 });
    }),
  );
  return state;
}

describe('MacrosPage', () => {
  it('lists macros with their ticket changes and sharing', async () => {
    seed([macro()]);
    renderWithProviders(<MacrosPage />);
    const list = await screen.findByRole('list', { name: 'Macros' }, FIND);
    expect(within(list).getByRole('heading', { name: 'Refund issued' })).toBeInTheDocument();
    expect(within(list).getByText('Also: set state to Resolved')).toBeInTheDocument();
    expect(within(list).getByText('Everyone')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Macros' })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('shows an empty state and adds a macro through the drawer', async () => {
    const state = seed([]);
    renderWithProviders(<MacrosPage />);
    expect(await screen.findByText('No macros yet', undefined, FIND)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add macro' })[0] as HTMLElement);
    const form = await screen.findByRole('form', { name: 'Add macro' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Thanks');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reply text' }), 'Thanks for writing in.');
    await userEvent.click(within(form).getByRole('button', { name: 'Add macro' }));
    expect(await screen.findByRole('heading', { name: 'Thanks' }, FIND)).toBeInTheDocument();
    expect(state.created).toEqual([{ name: 'Thanks', body: 'Thanks for writing in.', actions: {}, visibility: 'all_staff', sharedRoleIds: [], sharedGroupIds: [] }]);
  });

  it('hides add, edit and delete without the permissions', async () => {
    seed([macro()], ['macro.view']);
    renderWithProviders(<MacrosPage />);
    await screen.findByRole('list', { name: 'Macros' }, FIND);
    expect(screen.queryByRole('button', { name: 'Add macro' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Refund issued' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Refund issued' })).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the list fails', async () => {
    seed([]);
    server.use(http.get(`${API}/macros`, () => errorResponse(500, 'INTERNAL')));
    renderWithProviders(<MacrosPage />);
    expect(await screen.findByText("Couldn't load macros", undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
