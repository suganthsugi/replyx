import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import PoliciesPage from '../../src/pages/admin/ai/PoliciesPage';
import { FakeSocket } from '../chat/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AttachmentSummary, ListPolicyDocuments200, PolicyDocument, PolicyDocumentDetail, PolicyDocumentInput } from '../../src/api/generated/model';
import type { Envelope } from '../../src/data/socket';

/**
 * Policy documents admin page (specs/002-ai-assist T017/T018): create by text, upload a file, live
 * status over the socket (chip + announcement), rename, confirmed delete, field errors, and axe.
 */

const FIND = { timeout: 10_000 };

function policy(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return { id: 'pol-1', title: 'Return policy', status: 'processing', source: 'text', updatedAt: '2026-10-09T08:00:00.000Z', ...overrides };
}

function renderPage(initial: PolicyDocument[] = [policy()]) {
  let items = initial;
  const created: PolicyDocumentInput[] = [];
  const renamed: Array<{ id: string; title: string }> = [];
  const deleted: string[] = [];
  server.use(
    http.get(`${API}/ai/policies`, () => HttpResponse.json<ListPolicyDocuments200>({ items })),
    http.get(`${API}/ai/policies/:id`, ({ params }) => {
      const found = items.find((item) => item.id === params['id']) ?? policy({ id: params['id'] as string });
      return HttpResponse.json<PolicyDocumentDetail>({ ...found, text: 'Returns within 30 days.', versions: [] });
    }),
    http.post(`${API}/ai/policies`, async ({ request }) => {
      const body = (await request.json()) as PolicyDocumentInput;
      created.push(body);
      const next = policy({ id: 'pol-new', title: body.title, source: 'text' });
      items = [...items, next];
      return HttpResponse.json<PolicyDocument>(next, { status: 201 });
    }),
    http.patch(`${API}/ai/policies/:id`, async ({ params, request }) => {
      const { title } = (await request.json()) as { title: string };
      renamed.push({ id: params['id'] as string, title });
      items = items.map((item) => (item.id === params['id'] ? { ...item, title } : item));
      return HttpResponse.json<PolicyDocument>(items.find((item) => item.id === params['id']) ?? policy());
    }),
    http.delete(`${API}/ai/policies/:id`, ({ params }) => {
      deleted.push(params['id'] as string);
      items = items.filter((item) => item.id !== params['id']);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const socket = new FakeSocket();
  const view = renderWithProviders(
    <RealtimeProvider namespace="/" userId="admin-1" createSocket={() => socket}>
      <PoliciesPage />
    </RealtimeProvider>,
  );
  return { ...view, socket, created, renamed, deleted, setItems: (next: PolicyDocument[]) => (items = next) };
}

let seq = 100;
function fire(socket: FakeSocket, type: string, data: object) {
  seq += 1;
  const envelope: Envelope = { id: `evt-${seq}`, seq, stream: 'user', type, occurredAt: '2026-10-09T08:00:00.000Z', actor: { kind: 'system' }, data };
  act(() => socket.fire('event', envelope));
}

const live = (container: HTMLElement, level: 'polite' | 'assertive') => container.ownerDocument.querySelector(`[aria-live="${level}"]`);

async function confirmDialog(name: string) {
  return screen.findByRole('dialog', { name }).catch(() => screen.findByRole('alertdialog', { name }));
}

describe('PoliciesPage', () => {
  it('lists policies with status chips and no axe violations (processing, ready, failed)', async () => {
    const { container } = renderPage([
      policy(),
      policy({ id: 'pol-2', title: 'Refund policy', status: 'ready', activeSince: '2026-10-08T08:00:00.000Z' }),
      policy({ id: 'pol-3', title: 'Shipping policy', status: 'failed', error: 'No readable text in this file.' }),
    ]);
    const list = await screen.findByRole('list', { name: 'Policies' }, FIND);
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Processing')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Ready')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'Why Shipping policy failed' })).toHaveTextContent('No readable text in this file.');
    await expectNoAxeViolations(container);
  });

  it('shows the empty state', async () => {
    renderPage([]);
    expect(await screen.findByRole('heading', { name: 'No policies yet' }, FIND)).toBeInTheDocument();
  });

  it('shows the error state when the list fails', async () => {
    server.use(http.get(`${API}/ai/policies`, () => errorResponse(500, 'INTERNAL', 'Something went wrong')));
    renderWithProviders(<PoliciesPage />);
    expect(await screen.findByRole('heading', { name: "Couldn't load policies" }, FIND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('creates a policy from typed text and confirms with a toast', async () => {
    const { created } = renderPage([]);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a policy' });
    const save = within(dialog).getByRole('button', { name: 'Add policy' });
    expect(save).toBeDisabled();
    await expectNoAxeViolations(dialog);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Shipping policy');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Policy text/ }), 'We ship in 2 days.');
    await userEvent.click(save);

    await waitFor(() => expect(created).toEqual([{ title: 'Shipping policy', text: 'We ship in 2 days.' }]));
    expect((await screen.findAllByText('Policy added. It is processing and will be ready shortly.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a policy' })).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Shipping policy' })).toBeInTheDocument();
  });

  it('uploads a file and creates the policy from the ready attachment', async () => {
    const { created } = renderPage([]);
    server.use(
      http.post(`${API}/attachments`, () =>
        HttpResponse.json<AttachmentSummary>({ id: 'att-1', fileName: 'returns.md', contentType: 'text/markdown', sizeBytes: 12, scanStatus: 'clean' }, { status: 201 }),
      ),
    );
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a policy' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Returns');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Upload file' }));
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['# Returns'], 'returns.md', { type: 'text/markdown' }), { applyAccept: false });

    expect(await within(dialog).findByText('Uploaded', undefined, FIND)).toBeInTheDocument();
    await waitFor(() => expect(live(dialog, 'polite')).toHaveTextContent('returns.md uploaded'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));
    await waitFor(() => expect(created).toEqual([{ title: 'Returns', attachmentId: 'att-1' }]));
  });

  it('rejects an unsupported file type on the file field without uploading', async () => {
    renderPage([]);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a policy' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Upload file' }));
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }), { applyAccept: false });
    expect(await within(dialog).findByText('Choose a .txt, .md or .pdf file.')).toBeInTheDocument();
  });

  it('changes the chip live from the socket and announces it', async () => {
    const { socket, container, setItems } = renderPage();
    const row = (await screen.findByRole('heading', { name: 'Return policy' }, FIND)).closest('li')!;
    expect(within(row).getByText('Processing')).toBeInTheDocument();

    setItems([policy({ status: 'ready', activeSince: '2026-10-09T08:05:00.000Z' })]);
    fire(socket, 'ai.policy_version_updated', { documentId: 'pol-1', versionId: 'v-1', status: 'active' });
    expect(await within(row).findByText('Ready')).toBeInTheDocument();
    expect(within(row).queryByText('Processing')).not.toBeInTheDocument();
    await waitFor(() => expect(live(container, 'polite')).toHaveTextContent('Return policy is ready'));

    setItems([policy({ status: 'failed', error: 'Could not read the file.' })]);
    fire(socket, 'ai.policy_version_updated', { documentId: 'pol-1', versionId: 'v-2', status: 'failed' });
    expect(await within(row).findByText('Failed')).toBeInTheDocument();
    await waitFor(() => expect(live(container, 'assertive')).toHaveTextContent('Return policy failed to process'));
    expect(await screen.findByRole('note', { name: 'Why Return policy failed' })).toHaveTextContent('Could not read the file.');
  });

  it('renames a policy', async () => {
    const { renamed } = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Return policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Rename policy' });
    const field = within(dialog).getByRole('textbox', { name: /Title/ });
    expect(within(dialog).getByRole('button', { name: 'Save name' })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, 'Refunds');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(renamed).toEqual([{ id: 'pol-1', title: 'Refunds' }]));
    expect((await screen.findAllByText('Policy renamed')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'Refunds' })).toBeInTheDocument();
  });

  it('shows POLICY_TITLE_TAKEN on the title field when renaming, and announces it', async () => {
    const { container } = renderPage();
    server.use(http.patch(`${API}/ai/policies/:id`, () => errorResponse(409, 'POLICY_TITLE_TAKEN', 'Title taken')));
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Return policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Rename policy' });
    const field = within(dialog).getByRole('textbox', { name: /Title/ });
    await userEvent.clear(field);
    await userEvent.type(field, 'Refund policy');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(field).toHaveAccessibleDescription('A policy with this title already exists. Choose a different title.'));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(live(container, 'assertive')).toHaveTextContent('A policy with this title already exists');
  });

  it('shows POLICY_TITLE_TAKEN on create and moves focus to the title', async () => {
    renderPage([]);
    server.use(http.post(`${API}/ai/policies`, () => errorResponse(409, 'POLICY_TITLE_TAKEN', 'Title taken')));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a policy' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    await userEvent.type(title, 'Return policy');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Policy text/ }), 'Text');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));
    await waitFor(() => expect(title).toHaveAccessibleDescription(/already exists/));
    await waitFor(() => expect(title).toHaveFocus());
  });

  it('shows ATTACHMENT_BLOCKED on the file field and clears the file', async () => {
    renderPage([]);
    server.use(
      http.post(`${API}/attachments`, () =>
        HttpResponse.json<AttachmentSummary>({ id: 'att-9', fileName: 'bad.pdf', contentType: 'application/pdf', sizeBytes: 5, scanStatus: 'clean' }, { status: 201 }),
      ),
      http.post(`${API}/ai/policies`, () => errorResponse(409, 'ATTACHMENT_BLOCKED', 'Blocked')),
    );
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add policy' }, FIND))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a policy' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Bad');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Upload file' }));
    await userEvent.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, new File(['%PDF'], 'bad.pdf', { type: 'application/pdf' }), { applyAccept: false });
    await within(dialog).findByText('Uploaded', undefined, FIND);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add policy' }));

    const choose = await within(dialog).findByRole('button', { name: 'Choose file' });
    await waitFor(() => expect(choose).toHaveAccessibleDescription(/blocked by the security scan/));
    await waitFor(() => expect(choose).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Add policy' })).toBeDisabled();
  });

  it('asks before deleting, then removes the row, toasts and focuses the heading', async () => {
    const { deleted } = renderPage([policy(), policy({ id: 'pol-2', title: 'Refund policy', status: 'ready' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Return policy' }, FIND));
    const dialog = await confirmDialog('Delete Return policy?');
    expect(deleted).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete policy' }));

    await waitFor(() => expect(deleted).toEqual(['pol-1']));
    expect((await screen.findAllByText('Return policy deleted')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Return policy' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Policies' })).toHaveFocus());
  });

  it('keeps the policy when the delete is cancelled', async () => {
    const { deleted } = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Return policy' }, FIND));
    const dialog = await confirmDialog('Delete Return policy?');
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }));
    expect(deleted).toEqual([]);
    expect(await screen.findByRole('heading', { name: 'Return policy' })).toBeInTheDocument();
  });

  it('opens the editor for an existing policy with its text', async () => {
    renderPage([policy({ status: 'ready' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Return policy' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Edit policy' });
    expect(await within(dialog).findByRole('textbox', { name: /Policy text/ }, FIND)).toHaveValue('Returns within 30 days.');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await expectNoAxeViolations(dialog);
  });
});
