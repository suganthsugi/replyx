import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import ComplexityPage, { keyFromLabel } from '../../src/pages/admin/ai/ComplexityPage';
import { RoutingSection } from '../../src/pages/admin/ai/RoutingSection';
import GroupsPage from '../../src/pages/admin/groups/GroupsPage';
import { API } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AiSettings, AiSettingsPatch, ComplexityConfig, ErrorResponse, Group, GroupInput, Me } from '../../src/api/generated/model';

/**
 * US4 screens (specs/002-ai-assist T032/T033): the complexity page (add, edit, reorder and remove
 * factors, the threshold order rule and its live band preview, server field errors on the right
 * field), the routing section of AI settings, and the AI description on groups.
 */

const FIND = { timeout: 10_000 };
const polite = () => document.querySelector('[aria-live="polite"]');

const CONFIG: ComplexityConfig = {
  thresholds: { standard: 0.45, advanced: 0.8 },
  factors: [
    { key: 'frustration', label: 'Customer frustration', kind: 'score', weight: 2, instructions: 'Rate the frustration.', levels: ['calm', 'annoyed', 'angry'] },
    { key: 'several_issues', label: 'Several issues', kind: 'noul', weight: 1, instructions: 'Several issues?', criteria: { true: 'Two or more.', false: 'One.' } },
  ],
};

function renderComplexity(initial: ComplexityConfig = CONFIG, respond?: (body: ComplexityConfig) => Response) {
  const saved: ComplexityConfig[] = [];
  let current = initial;
  server.use(
    http.get(`${API}/ai/complexity`, () => HttpResponse.json<ComplexityConfig>(current)),
    http.get(`${API}/tags`, () => HttpResponse.json({ items: [{ id: 'tag-vip', name: 'VIP' }] })),
    http.put(`${API}/ai/complexity`, async ({ request }) => {
      const body = (await request.json()) as ComplexityConfig;
      saved.push(body);
      if (respond !== undefined) return respond(body);
      current = body;
      return HttpResponse.json<ComplexityConfig>(body);
    }),
  );
  return { ...renderWithProviders(<ComplexityPage />), saved };
}

describe('ComplexityPage', () => {
  it('shows the factors, the thresholds and the level bands, with no axe violations', async () => {
    const { container } = renderComplexity();
    expect(await screen.findByRole('heading', { level: 1, name: 'Complexity' }, FIND)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 3, name: 'Customer frustration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Several issues' })).toBeInTheDocument();
    const levels = screen.getByRole('list', { name: 'Levels by score' });
    expect(within(levels).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Fast: score below 45%',
      'Standard: score from 45% to below 80%',
      'Advanced: score from 80% up',
    ]);
    expect(screen.getByRole('slider', { name: /Standard from/ })).toHaveAttribute('aria-valuetext', '45%');
    await expectNoAxeViolations(container);
  });

  it('adds a choice factor with a generated key, reorders it, and saves only its kind’s fields', async () => {
    const { saved } = renderComplexity();
    await userEvent.click(await screen.findByRole('button', { name: 'Add factor' }, FIND));
    const names = screen.getAllByRole('textbox', { name: 'Name' });
    await userEvent.type(names[2]!, 'Order value');
    expect(screen.getAllByRole('textbox', { name: 'Key' })[2]).toHaveValue('order_value');

    const card = screen.getByRole('listitem', { name: 'Order value' });
    await userEvent.click(within(card).getByRole('combobox', { name: 'Type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Multiple choice' }));
    // Pasted, not typed key by key: per-key typing made this test time out under full-suite load.
    const fill = async (name: string, text: string) => {
      await userEvent.click(within(card).getByRole('textbox', { name }));
      await userEvent.paste(text);
    };
    await fill('Question for the AI', 'How much is the order worth?');
    await fill('Option 1 description', 'Under 50 euros');
    await fill('Option 2 description', 'Over 500 euros');

    await userEvent.click(screen.getByRole('button', { name: 'Move Order value up' }));
    expect(polite()).toHaveTextContent('Order value moved to position 2 of 3');
    expect(screen.getByRole('button', { name: 'Move Order value up' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Customer frustration' }));
    // Focus goes to the next card instead of falling back to the page.
    expect(screen.getByRole('heading', { level: 3, name: 'Order value' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Save complexity settings' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      thresholds: { standard: 0.45, advanced: 0.8 },
      factors: [
        {
          key: 'order_value',
          label: 'Order value',
          kind: 'choice',
          weight: 1,
          instructions: 'How much is the order worth?',
          options: [
            { key: 'low', description: 'Under 50 euros', value: 0 },
            { key: 'high', description: 'Over 500 euros', value: 1 },
          ],
        },
        { key: 'several_issues', label: 'Several issues', kind: 'noul', weight: 1, instructions: 'Several issues?', criteria: { true: 'Two or more.', false: 'One.' } },
      ],
    });
  }, 30_000);

  it('moves focus to Add factor after removing the last factor', async () => {
    renderComplexity({ ...CONFIG, factors: [CONFIG.factors[0]!] });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Customer frustration' }, FIND));
    expect(screen.getByRole('button', { name: 'Add factor' })).toHaveFocus();
    expect(screen.getByText(/Add at least one factor with a weight above 0 to save/)).toBeInTheDocument();
  });

  it('blocks saving while the Advanced threshold is not above the Standard one', async () => {
    renderComplexity();
    const advanced = await screen.findByRole('slider', { name: /Advanced from/ }, FIND);
    advanced.focus();
    // From 80% down to 40%, below Standard (45%).
    await userEvent.keyboard('{ArrowLeft>40/}');
    expect(advanced).toHaveAttribute('aria-valuetext', '40%');
    expect(screen.getByRole('alert')).toHaveTextContent('The Advanced threshold must be higher than the Standard one.');
    expect(advanced).toHaveAccessibleDescription('The Advanced threshold must be higher than the Standard one.');
    expect(screen.getByRole('button', { name: 'Save complexity settings' })).toBeDisabled();
    expect(within(screen.getByRole('list', { name: 'Levels by score' })).getByRole('listitem')).toHaveTextContent('Fix the thresholds to see the levels.');
  });

  it('puts server field errors on the matching field', async () => {
    renderComplexity(CONFIG, () =>
      HttpResponse.json<ErrorResponse>(
        { error: { code: 'VALIDATION_FAILED', message: 'The request is invalid', details: [{ path: 'factors.1.key', issue: 'duplicate' }] } },
        { status: 400 },
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Save complexity settings' }, FIND));
    const key = (await screen.findAllByRole('textbox', { name: 'Key' }))[1]!;
    await waitFor(() => expect(key).toHaveAccessibleDescription('This is already used'));
    expect(key).toHaveAttribute('aria-invalid', 'true');
  });

  it('turns labels into valid keys', () => {
    expect(keyFromLabel('VIP customer!')).toBe('vip_customer');
    expect(keyFromLabel('2nd reopen')).toBe('nd_reopen');
    expect(keyFromLabel('x'.repeat(60))).toHaveLength(40);
  });
});

describe('RoutingSection', () => {
  const settings: AiSettings = {
    replyMode: 'off',
    routingEnabled: false,
    routingThreshold: 0.7,
    models: { fast: 'a', standard: 'b', advanced: 'c' },
    provider: 'openrouter',
    providerKey: { last4: 'Q7ZX' },
    paused: null,
  };

  it('turns routing on with a threshold, sending only what changed', async () => {
    const patches: AiSettingsPatch[] = [];
    server.use(
      http.patch(`${API}/ai/settings`, async ({ request }) => {
        const patch = (await request.json()) as AiSettingsPatch;
        patches.push(patch);
        return HttpResponse.json<AiSettings>({ ...settings, ...patch } as AiSettings);
      }),
    );
    const { container } = renderWithProviders(<RoutingSection settings={settings} />);
    const slider = screen.getByRole('slider', { name: /Confidence needed/ });
    expect(slider).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save routing' })).toBeDisabled();

    await userEvent.click(screen.getByRole('switch', { name: 'Route new tickets with AI' }));
    expect(slider).toBeEnabled();
    slider.focus();
    await userEvent.keyboard('{ArrowRight>5/}');
    expect(slider).toHaveAttribute('aria-valuetext', '75%');
    await userEvent.click(screen.getByRole('button', { name: 'Save routing' }));
    await waitFor(() => expect(patches).toEqual([{ routingEnabled: true, routingThreshold: 0.75 }]));
    await expectNoAxeViolations(container);
  });
});

describe('group AI descriptions', () => {
  const me = (permissions: string[]): Me => ({ id: 'u1', email: 'ada@acme.test', name: 'Ada', kind: 'staff', roles: [], permissions, groupAccess: [], accessVersion: 1 });
  const groups: Group[] = [{ id: 'g-billing', name: 'Billing', status: 'active', openTicketCount: 0, aiDescription: 'Invoices and refunds' }];

  function renderGroups(permissions: string[]) {
    const updates: GroupInput[] = [];
    server.use(
      http.get(`${API}/me`, () => HttpResponse.json(me(permissions))),
      http.get(`${API}/groups`, () => HttpResponse.json({ items: groups })),
      http.patch(`${API}/groups/:id`, async ({ request }) => {
        const body = (await request.json()) as GroupInput;
        updates.push(body);
        return HttpResponse.json<Group>({ ...groups[0]!, ...body });
      }),
    );
    return { ...renderWithProviders(<GroupsPage />), updates };
  }

  it('lets an AI settings manager edit the AI description', async () => {
    const { updates } = renderGroups(['group.view', 'group.edit', 'ai_settings.manage']);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Billing' }, FIND));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('textbox', { name: 'AI description' });
    expect(field).toHaveValue('Invoices and refunds');
    expect(field).toHaveAccessibleDescription(/for AI routing/);
    await userEvent.clear(field);
    await userEvent.type(field, 'Invoices, charges and refunds');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updates).toEqual([{ name: 'Billing', description: '', aiDescription: 'Invoices, charges and refunds' }]));
    await expectNoAxeViolations(document.body);
  });

  it('hides the AI description from group editors without ai_settings.manage, and never sends it', async () => {
    const { updates } = renderGroups(['group.view', 'group.edit']);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Billing' }, FIND));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('textbox', { name: 'AI description' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updates).toEqual([{ name: 'Billing', description: '' }]));
  });
});
