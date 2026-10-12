import { describe, expect, it, vi } from 'vitest';

import { AssistantTools, MAX_POLICY_SEARCHES, newToolTurn } from '../../../src/ai/assistant/assistant-tools.js';

import type { TurnInput } from '../../../src/ai/assistant/turn-brain.js';
import type { CommerceConnector } from '../../../src/ai/commerce/ports.js';
import type { StoreConnectionService } from '../../../src/ai/commerce/store-connection.service.js';
import type { PolicyPassage, PolicySearch } from '../../../src/ai/knowledge/policy-search.js';

const RETURNS: PolicyPassage = { documentTitle: 'Returns Policy', heading: 'Window', content: 'Returns within 30 days.' };
const SHIPPING: PolicyPassage = { documentTitle: 'Shipping Policy', heading: null, content: 'Ships in 2 days.' };

const INPUT = { ctx: {}, ticketId: 't1' } as unknown as TurnInput;

function toolsReturning(...results: PolicyPassage[][]) {
  const search = vi.fn<PolicySearch['search']>();
  for (const result of results) search.mockResolvedValueOnce(result);
  const tools = new AssistantTools({ search } as unknown as PolicySearch, {} as StoreConnectionService, {} as CommerceConnector);
  return { tools, search };
}

function searchCall(id: string, query = 'returns') {
  return { id, name: 'search_policies', arguments: JSON.stringify({ query }) };
}

function passagesOf(outcome: Awaited<ReturnType<AssistantTools['execute']>>) {
  if (outcome.kind !== 'result') throw new Error('expected a result');
  const json = outcome.content.replace(/^<policies>\n/, '').replace(/\n<\/policies>$/, '');
  return JSON.parse(json) as { passages: { document: string }[]; alreadyReturned?: number };
}

describe('AssistantTools.search_policies', () => {
  it('does not send a passage the turn already returned', async () => {
    const { tools } = toolsReturning([RETURNS], [RETURNS, SHIPPING]);
    const turn = newToolTurn();

    expect(passagesOf(await tools.execute(INPUT, searchCall('c1'), turn)).passages.map((p) => p.document)).toEqual(['Returns Policy']);
    const second = passagesOf(await tools.execute(INPUT, searchCall('c2', 'shipping'), turn));
    expect(second.passages.map((p) => p.document)).toEqual(['Shipping Policy']);
    expect(second.alreadyReturned).toBe(1);
  });

  it(`stops searching after ${MAX_POLICY_SEARCHES} searches in one turn`, async () => {
    const { tools, search } = toolsReturning(...Array.from({ length: MAX_POLICY_SEARCHES + 1 }, () => [RETURNS]));
    const turn = newToolTurn();

    for (let i = 0; i < MAX_POLICY_SEARCHES; i += 1) await tools.execute(INPUT, searchCall(`c${i}`), turn);
    const over = await tools.execute(INPUT, searchCall('over'), turn);

    expect(over).toEqual({ kind: 'result', content: JSON.stringify({ error: 'search_limit_reached' }) });
    expect(search).toHaveBeenCalledTimes(MAX_POLICY_SEARCHES);
  });

  it('starts every turn with a fresh budget', async () => {
    const { tools, search } = toolsReturning([RETURNS], [RETURNS]);

    await tools.execute(INPUT, searchCall('c1'), newToolTurn());
    const next = passagesOf(await tools.execute(INPUT, searchCall('c2'), newToolTurn()));

    expect(next.passages.map((p) => p.document)).toEqual(['Returns Policy']);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
