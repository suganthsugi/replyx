import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ResponderBadge } from '../../src/components/data-display/ResponderBadge';
import { RealtimeProvider } from '../../src/data/realtime';
import AiUsagePage from '../../src/pages/admin/ai/AiUsagePage';
import ChatPage from '../../src/pages/customer/ChatPage';
import { TicketFocus } from '../../src/pages/desk/inbox/TicketFocus';
import { conversationEvent, conversationPage, FakeSocket, me, myMessage, supportMessage } from '../chat/fixtures';
import { eligibleOwnersHandler, groupDestinationsHandler, historyHandler, makeEligibleOwner, makeGroup, makeMe, makeMessage, makeTicket, meHandler, messagesHandler, tagsHandler, usersHandler } from '../desk/fixtures';
import { API, branding, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { AiDraft, AiRun, ListAiRuns200, Responder, Ticket } from '../../src/api/generated/model';

/**
 * The assistant in the UI (specs/002-ai-assist T028/T029): the responder badge (variants, the
 * polite "Now replying" announcement, the sheen held still under reduced motion), Take over and
 * Hand back on the ticket, the AI draft bar, the "Assistant · AI" author chip in both threads, and
 * the AI usage table.
 */

const FIND = { timeout: 10_000 };
const polite = () => document.querySelector('[aria-live="polite"]');

/** The badge's text as a screen reader gets it: without aria-hidden parts (the avatar's initial). */
function spoken(element: Element | null): string {
  const copy = element?.cloneNode(true) as Element | undefined;
  copy?.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return (copy?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('ResponderBadge', () => {
  it.each<[string, Responder, string]>([
    ['assistant', { kind: 'assistant' }, 'Now replying: Assistant · AI'],
    ['agent', { kind: 'agent', name: 'Ada Agent', avatarUrl: null }, 'Now replying: Ada Agent'],
    ['team', { kind: 'team' }, 'Now replying: Support team'],
  ])('shows the %s variant with no axe violations', async (_kind, responder, text) => {
    const { container } = renderWithProviders(<ResponderBadge responder={responder} />);
    expect(spoken(container.querySelector('[data-testid="responder-badge"]'))).toBe(text);
    await expectNoAxeViolations(container);
  });

  it('announces a change politely, but not the first render', () => {
    const view = renderWithProviders(<ResponderBadge responder={{ kind: 'assistant' }} />);
    expect(polite()).toHaveTextContent('');
    view.rerender(<ResponderBadge responder={{ kind: 'agent', name: 'Ada Agent', avatarUrl: null }} />);
    expect(polite()).toHaveTextContent('Now replying: Ada Agent');
  });

  it('animates the Assistant sheen and holds it still under reduced motion', () => {
    const { container } = renderWithProviders(<ResponderBadge responder={{ kind: 'assistant' }} />);
    const badge = container.querySelector('[data-responder="assistant"]');
    expect(badge).not.toBeNull();
    const classes = [...(badge?.classList ?? [])];
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const own = (rule: CSSRule) => rule instanceof CSSStyleRule && classes.some((name) => rule.selectorText.includes(`.${name}`));

    const base = rules.filter(own) as CSSStyleRule[];
    expect(base.some((rule) => /3s linear infinite/.test(rule.style.animation))).toBe(true);
    expect(base.some((rule) => rule.cssText.includes('linear-gradient('))).toBe(true);

    const reduced = rules.filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion: reduce'));
    const still = reduced.flatMap((rule) => [...rule.cssRules]).filter(own) as CSSStyleRule[];
    expect(still.some((rule) => rule.style.animation === 'none')).toBe(true);
  });
});

function aiState(overrides: Partial<NonNullable<Ticket['ai']>> = {}): NonNullable<Ticket['ai']> {
  return { stopped: false, stoppedReason: null, canTakeOver: true, canHandBack: false, ...overrides };
}

function renderTicket(initial: Ticket, options: { draft?: AiDraft } = {}) {
  let current = initial;
  let draft = options.draft;
  const calls: string[] = [];
  server.use(
    meHandler(makeMe()),
    http.get(`${API}/tickets/${initial.id}`, () => HttpResponse.json<Ticket>(current)),
    messagesHandler(initial.id, [makeMessage(), makeMessage({ id: 'msg-ai', authorKind: 'assistant', author: { id: 'assistant', name: 'Assistant' }, body: 'Your order R100200 has shipped.' })]),
    historyHandler(initial.id, []),
    groupDestinationsHandler([makeGroup()]),
    eligibleOwnersHandler('group-1', [makeEligibleOwner()]),
    tagsHandler([]),
    usersHandler([]),
    http.get(`${API}/tickets/${initial.id}/ai-draft`, () => {
      if (draft === undefined) return errorResponse(404, 'AI_DRAFT_NOT_FOUND');
      return HttpResponse.json<AiDraft>(draft) as unknown as ReturnType<typeof errorResponse>;
    }),
    http.post(`${API}/tickets/${initial.id}/ai-draft/discard`, () => {
      calls.push('discard');
      draft = undefined;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/tickets/${initial.id}/ai/takeover`, () => {
      calls.push('takeover');
      const responder: Responder = { kind: 'agent', name: 'Mia Me', avatarUrl: null };
      current = { ...current, owner: { id: 'me-1', name: 'Mia Me' }, responder, ai: aiState({ stopped: true, stoppedReason: 'takeover', canTakeOver: false, canHandBack: true }) };
      return HttpResponse.json<Responder>(responder);
    }),
    http.post(`${API}/tickets/${initial.id}/ai/handback`, () => {
      calls.push('handback');
      current = { ...current, owner: null, responder: { kind: 'assistant' }, ai: aiState() };
      return HttpResponse.json<Responder>({ kind: 'assistant' });
    }),
  );
  const view = renderWithProviders(<TicketFocus ticketId={initial.id} onClose={vi.fn()} onOpenCustomer={vi.fn()} />);
  return { ...view, calls };
}

describe('the ticket view', () => {
  it('takes over from the assistant and hands back, with the badge following', async () => {
    const { calls } = renderTicket(makeTicket({ owner: null, responder: { kind: 'assistant' }, ai: aiState() }));
    expect(await screen.findByText('Assistant · AI', { selector: 'span' }, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand back to AI' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByRole('button', { name: 'Hand back to AI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    expect(spoken(screen.getByTestId('responder-badge'))).toBe('Now replying: Mia Me');
    await waitFor(() => expect(polite()).toHaveTextContent('Now replying: Mia Me'));

    await userEvent.click(screen.getByRole('button', { name: 'Hand back to AI' }));
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(spoken(screen.getByTestId('responder-badge'))).toBe('Now replying: Assistant · AI');
    expect(calls).toEqual(['takeover', 'handback']);
  });

  it('shows neither button nor badge when AI is off for the tenant', async () => {
    renderTicket(makeTicket());
    expect(await screen.findByRole('heading', { level: 2, name: 'Cannot reset my password' }, FIND)).toBeInTheDocument();
    expect(screen.queryByTestId('responder-badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
  });

  it('marks assistant messages with the AI author chip', async () => {
    renderTicket(makeTicket({ responder: { kind: 'team' }, ai: aiState({ canTakeOver: false }) }));
    const message = (await screen.findByText('Your order R100200 has shipped.', undefined, FIND)).closest('li');
    expect(message).not.toBeNull();
    expect(within(message as HTMLElement).getByText('AI')).toBeInTheDocument();
    expect(message).toHaveTextContent('Assistant');
  });

  it('puts the AI draft in the composer with Use, and throws it away with Discard', async () => {
    const draft: AiDraft = { id: 'draft-1', ticketId: 'ticket-1', body: 'Your parcel left our warehouse yesterday.', createdAt: '2026-10-09T08:00:00.000Z' };
    const first = renderTicket(makeTicket(), { draft });
    const bar = await screen.findByRole('region', { name: 'AI draft' }, FIND);
    await waitFor(() => expect(polite()).toHaveTextContent('An AI draft reply is ready for this ticket'));
    await userEvent.click(within(bar).getByRole('button', { name: 'Use' }));
    expect(await screen.findByDisplayValue(draft.body)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'AI draft' })).not.toBeInTheDocument();
    first.unmount();

    const second = renderTicket(makeTicket(), { draft });
    await userEvent.click(within(await screen.findByRole('region', { name: 'AI draft' }, FIND)).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'AI draft' })).not.toBeInTheDocument());
    expect(second.calls).toEqual(['discard']);
    await waitFor(() => expect(polite()).toHaveTextContent('AI draft discarded'));
  });
});

describe('the customer chat', () => {
  function renderChat(responder: Responder) {
    const aiReply = { ...supportMessage('m2', 'Your order R100200 has shipped.'), from: { kind: 'support' as const, name: 'Assistant', avatarUrl: null }, isAi: true };
    server.use(
      http.get(`${API}/customer/conversation`, () =>
        HttpResponse.json(conversationPage([{ type: 'message', message: myMessage('m1', 'Where is R100200?', 'cm-1') }, { type: 'message', message: aiReply }], { responder })),
      ),
      http.post(`${API}/customer/messages/read`, () => new HttpResponse(null, { status: 204 })),
    );
    const socket = new FakeSocket();
    const view = renderWithProviders(
      <RealtimeProvider namespace="/customer" userId={me.id} createSocket={() => socket}>
        <ChatPage me={me} branding={{ ...branding, tenantName: 'Acme' }} />
      </RealtimeProvider>,
    );
    return { ...view, socket };
  }

  it('shows who is replying in the header, the AI chip on assistant replies, and follows a responder change', async () => {
    const { container, socket } = renderChat({ kind: 'assistant' });
    const header = (await screen.findByRole('heading', { level: 1, name: 'Acme Support' }, FIND)).closest('header') as HTMLElement;
    expect(spoken(await within(header).findByTestId('responder-badge'))).toBe('Now replying: Assistant · AI');
    const reply = (await screen.findByText('Your order R100200 has shipped.')).closest('li') as HTMLElement;
    expect(within(reply).getByText('AI')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ticket/i);
    await expectNoAxeViolations(container);

    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    act(() => socket.open());
    act(() => socket.fire('event', conversationEvent('conversation.responder_changed', { responder: { kind: 'agent', name: 'Ada Agent', avatarUrl: null } })));
    await waitFor(() => expect(spoken(within(header).getByTestId('responder-badge'))).toBe('Now replying: Ada Agent'));
    await waitFor(() => expect(polite()).toHaveTextContent('Now replying: Ada Agent'));
  });
});

describe('AiUsagePage', () => {
  const RUN: AiRun = {
    id: 'run-1',
    createdAt: '2026-10-09T08:00:00.000Z',
    ticket: { id: 'ticket-1', number: 1234 },
    purpose: 'reply',
    model: 'anthropic/claude-haiku-5.5',
    level: 'fast',
    complexityScore: null,
    inputTokens: 1200,
    outputTokens: 80,
    costUsd: 0.0012,
    costEstimated: false,
    durationMs: 900,
    outcome: 'ok',
  };

  it('lists the calls with totals, and sends the purpose filter', async () => {
    const purposes: (string | null)[] = [];
    server.use(
      http.get(`${API}/ai/runs`, ({ request }) => {
        const purpose = new URL(request.url).searchParams.get('purpose');
        purposes.push(purpose);
        const items = purpose === null || purpose === 'reply' ? [RUN] : [];
        return HttpResponse.json<ListAiRuns200>({ items, nextCursor: null, totals: { runs: items.length, costUsd: items.length * 0.0012 } });
      }),
    );
    const { container } = renderWithProviders(<AiUsagePage />);
    const table = await screen.findByRole('table', { name: 'AI calls' }, FIND);
    expect(within(table).getByText('anthropic/claude-haiku-5.5')).toBeInTheDocument();
    expect(within(table).getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Runs').parentElement).toHaveTextContent('1');
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('combobox', { name: 'Purpose' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Summary' }));
    expect(await screen.findByText('No AI calls match these filters')).toBeInTheDocument();
    expect(purposes).toContain('summary');
  });
});
