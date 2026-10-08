import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import AiSettingsPage from '../../src/pages/admin/ai/AiSettingsPage';
import { FakeSocket } from '../chat/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AiSettings, AiSettingsPatch, ConnectionTest, ListAiModels200, SetAiProviderKeyBody } from '../../src/api/generated/model';
import type { Envelope } from '../../src/data/socket';

/**
 * The AI settings page (specs/002-ai-assist T012/T013): the key shown only as last4, saving a key,
 * the connection test result, reply mode and models saved together (only changed fields), and the
 * paused banner arriving and clearing over the socket.
 */

const FIND = { timeout: 10_000 };

const MODELS: ListAiModels200 = {
  decisionModel: 'typesafe/jev-1.13',
  levels: {
    fast: [
      { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, isDefault: true },
      { id: 'qwen/qwen3.7-flash', label: 'Qwen 3.7 Flash', inputPerMillionUsd: 0.03, outputPerMillionUsd: 0.13, isDefault: false },
    ],
    standard: [{ id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5, isDefault: true }],
    advanced: [{ id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', inputPerMillionUsd: 2, outputPerMillionUsd: 10, isDefault: true }],
  },
};

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    replyMode: 'off',
    routingEnabled: false,
    routingThreshold: 0.7,
    models: { fast: 'anthropic/claude-haiku-5.5', standard: 'google/gemini-3.1-flash-lite', advanced: 'anthropic/claude-sonnet-5.5' },
    provider: 'openrouter',
    providerKey: { last4: 'Q7ZX' },
    paused: null,
    ...overrides,
  };
}

function renderPage(initial: AiSettings = settings()) {
  let current = initial;
  const patches: AiSettingsPatch[] = [];
  const keys: string[] = [];
  server.use(
    http.get(`${API}/ai/settings`, () => HttpResponse.json<AiSettings>(current)),
    http.get(`${API}/ai/models`, () => HttpResponse.json<ListAiModels200>(MODELS)),
    http.patch(`${API}/ai/settings`, async ({ request }) => {
      const patch = (await request.json()) as AiSettingsPatch;
      patches.push(patch);
      current = { ...current, ...(patch.replyMode === undefined ? {} : { replyMode: patch.replyMode }), models: { ...current.models, ...patch.models } };
      return HttpResponse.json<AiSettings>(current);
    }),
    http.put(`${API}/ai/settings/provider-key`, async ({ request }) => {
      const { apiKey } = (await request.json()) as SetAiProviderKeyBody;
      keys.push(apiKey);
      current = { ...current, providerKey: { last4: apiKey.slice(-4) }, paused: null };
      return HttpResponse.json<AiSettings>(current);
    }),
  );
  const socket = new FakeSocket();
  const view = renderWithProviders(
    <RealtimeProvider namespace="/" userId="admin-1" createSocket={() => socket}>
      <AiSettingsPage />
    </RealtimeProvider>,
  );
  return { ...view, socket, patches, keys, setCurrent: (next: AiSettings) => (current = next) };
}

let seq = 1;
function fire(socket: FakeSocket, type: string, data: object) {
  seq += 1;
  const envelope: Envelope = { id: `evt-${seq}`, seq, stream: 'user', type, occurredAt: '2026-10-09T08:00:00.000Z', actor: { kind: 'system' }, data };
  act(() => socket.fire('event', envelope));
}

describe('AiSettingsPage', () => {
  it('shows the key as last4 only, the reply modes and model prices, with no axe violations', async () => {
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'AI settings' }, FIND)).toBeInTheDocument();
    expect(await screen.findByText('•••• Q7ZX', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Off/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Drafts for agents/ })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Fast model' })).toHaveTextContent('Claude Haiku 5.5 (default) · $0.10 in / $0.50 out per million tokens');
    expect(screen.queryByRole('heading', { name: /AI paused/ })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('offers Add key without a key, and saves a new key without ever showing it', async () => {
    const { keys } = renderPage(settings({ providerKey: null }));
    expect(await screen.findByText('No key saved', undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an OpenRouter key' });
    const field = within(dialog).getByLabelText(/API key/);
    expect(field).toHaveAttribute('type', 'password');
    await userEvent.type(field, 'sk-or-v1-secret-AB12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));

    expect(await screen.findByText('•••• AB12')).toBeInTheDocument();
    expect(keys).toEqual(['sk-or-v1-secret-AB12']);
    expect(screen.queryByText(/sk-or-v1-secret/)).not.toBeInTheDocument();
  });

  it('saves the reply mode and a model together, sending only what changed', async () => {
    const { patches } = renderPage();
    await userEvent.click(await screen.findByRole('radio', { name: /Drafts for agents/ }, FIND));
    await userEvent.click(screen.getByRole('combobox', { name: 'Fast model' }));
    await userEvent.click(await screen.findByRole('option', { name: /Qwen 3.7 Flash/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toEqual([{ replyMode: 'drafts', models: { fast: 'qwen/qwen3.7-flash' } }]));
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('AI settings saved'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());
  });

  it('shows a model validation error on its field', async () => {
    renderPage();
    server.use(http.patch(`${API}/ai/settings`, () => HttpResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'The request is invalid', details: [{ path: 'models.fast', issue: 'invalid_model' }] } },
      { status: 400 },
    )));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Fast model' }, FIND));
    await userEvent.click(await screen.findByRole('option', { name: /Qwen 3.7 Flash/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Fast model' })).toHaveAccessibleDescription(/not valid/));
  });

  it('shows and announces the connection test result in plain language', async () => {
    const { container } = renderPage();
    server.use(
      http.post(`${API}/ai/settings/provider-key/test`, () =>
        HttpResponse.json<ConnectionTest>({ ok: false, error: 'invalid_key', detail: 'OpenRouter did not accept this key. Check that you copied all of it, or create a new key.' }),
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }, FIND));
    expect(await screen.findByRole('note', { name: 'Connection test result' })).toHaveTextContent(/OpenRouter did not accept this key/);
    expect(container.ownerDocument.querySelector('[aria-live="assertive"]')).toHaveTextContent('Connection failed');

    server.use(http.post(`${API}/ai/settings/provider-key/test`, () => HttpResponse.json<ConnectionTest>({ ok: true, detail: 'Connected to OpenRouter.', creditRemainingUsd: 4.5 })));
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('note', { name: 'Connection test result' })).toHaveTextContent('Connected to OpenRouter. Credit left on this key: $4.50.'));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Connection works');
  });

  it('explains a missing key on test as an error', async () => {
    renderPage();
    server.use(http.post(`${API}/ai/settings/provider-key/test`, () => errorResponse(409, 'AI_KEY_MISSING', 'Save an AI provider key first')));
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }, FIND));
    expect(await screen.findByText('Save an AI provider key first')).toBeInTheDocument();
  });

  it('shows the paused banner from the API and live from the socket, and clears it on resume', async () => {
    const { socket, container } = renderPage(settings({ paused: { reason: 'no_credit', since: '2026-10-09T07:00:00.000Z' } }));
    expect(await screen.findByRole('heading', { name: 'AI paused: no credit left' }, FIND)).toBeInTheDocument();
    await expectNoAxeViolations(container);

    fire(socket, 'ai.resumed', {});
    await waitFor(() => expect(screen.queryByRole('heading', { name: /AI paused/ })).not.toBeInTheDocument());
    fire(socket, 'ai.paused', { reason: 'invalid_key' });
    expect(await screen.findByRole('heading', { name: 'AI paused: the key was not accepted' })).toBeInTheDocument();
    expect(screen.getByText(/Replace the key/)).toBeInTheDocument();
  });

  it('asks before removing the key', async () => {
    const { setCurrent } = renderPage();
    server.use(
      http.delete(`${API}/ai/settings/provider-key`, () => {
        setCurrent(settings({ providerKey: null }));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Remove key' }, FIND));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the OpenRouter key?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    expect(await screen.findByText('No key saved')).toBeInTheDocument();
  });

  it('shows the error state and retries when settings fail to load', async () => {
    server.use(
      http.get(`${API}/ai/settings`, () => errorResponse(500, 'INTERNAL', 'Something went wrong')),
      http.get(`${API}/ai/models`, () => HttpResponse.json<ListAiModels200>(MODELS)),
    );
    renderWithProviders(<AiSettingsPage />);
    expect(await screen.findByRole('heading', { name: "Couldn't load AI settings" }, FIND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
