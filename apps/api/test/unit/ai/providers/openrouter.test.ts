import { describe, expect, it, vi } from 'vitest';

import { OpenRouterProvider, errorKindForStatus } from '../../../../src/ai/providers/openrouter/openrouter.provider.js';
import { ProviderError } from '../../../../src/ai/providers/ports.js';

const CREDS = { apiKey: 'sk-or-test' };

function stubFetch(status: number, body: unknown) {
  return vi.fn(() =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

function sent(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  return { url: url.toString(), init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

describe('OpenRouterProvider.complete', () => {
  it('sends tools, json schema, privacy and usage options and maps tool calls and cost', async () => {
    const fetchMock = stubFetch(200, {
      model: 'anthropic/claude-haiku-5.5',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderNumber":"R1"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 8, cost: 0.000016 },
    });
    const provider = new OpenRouterProvider('https://openrouter.test', fetchMock);
    const result = await provider.complete(CREDS, {
      model: 'anthropic/claude-haiku-5.5',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 'search_policies', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c0', content: '{}' },
      ],
      tools: [{ name: 'lookup_order', description: 'Look up', parameters: { type: 'object' } }],
      responseSchema: { name: 'answer', schema: { type: 'object' } },
    });

    const { url, init, body } = sent(fetchMock);
    expect(url).toBe('https://openrouter.test/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(body.provider).toEqual({ data_collection: 'deny' });
    expect(body.usage).toEqual({ include: true });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'lookup_order', description: 'Look up', parameters: { type: 'object' } } }]);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } });
    expect((body.messages as unknown[])[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'search_policies', arguments: '{}' } }],
    });
    expect((body.messages as unknown[])[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{}' });

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'lookup_order', arguments: '{"orderNumber":"R1"}' }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8, costUsd: 0.000016 });
  });

  it('maps HTTP failures to error kinds without echoing the body', async () => {
    const provider = new OpenRouterProvider('https://openrouter.test', stubFetch(402, { error: { message: 'secret prompt text' } }));
    const error = await provider.complete(CREDS, { model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'credit', status: 402 });
    expect((error as Error).message).not.toContain('secret prompt text');
    expect((error as ProviderError).pausesTenant).toBe(true);
  });

  it('treats an unexpected response shape as unavailable', async () => {
    const provider = new OpenRouterProvider('https://openrouter.test', stubFetch(200, { nope: true }));
    await expect(provider.complete(CREDS, { model: 'm', messages: [] })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('turns a network timeout into a timeout error', async () => {
    const fetchMock = vi.fn(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    const provider = new OpenRouterProvider('https://openrouter.test', fetchMock);
    await expect(provider.complete(CREDS, { model: 'm', messages: [] })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('OpenRouterProvider.decide', () => {
  it('posts to the alpha decisions endpoint and returns typed answers', async () => {
    const fetchMock = stubFetch(200, {
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        wants_human: { type: 'noul', noul: 0.96 },
        team: { type: 'choice', choice: 'billing', confidence: 0.75, probabilities: { billing: 0.84, none: 0.16 } },
        frustration: { type: 'score', score: 1.99, confidence: 0.99, legend: { 0: 'calm' }, probabilities: { 0: 0, 1: 0.01, 2: 0.99 } },
      },
      usage: { cost: 0.00002, input_tokens: 476, output_tokens: 70 },
    });
    const provider = new OpenRouterProvider('https://openrouter.test', fetchMock);
    const result = await provider.decide(CREDS, {
      model: 'typesafe/jev-1.13',
      state: { message: 'help' },
      questions: { wants_human: { type: 'noul', instructions: 'Human?', criteria: { true: 'yes', false: 'no' } } },
    });
    const { url, body } = sent(fetchMock);
    expect(url).toBe('https://openrouter.test/api/alpha/decisions');
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(result.answers.wants_human).toMatchObject({ type: 'noul', noul: 0.96 });
    expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'billing' });
    expect(result.answers.frustration).toMatchObject({ type: 'score', score: 1.99 });
    expect(result.usage).toEqual({ inputTokens: 476, outputTokens: 70, costUsd: 0.00002 });
  });
});

describe('OpenRouterProvider.embed', () => {
  it('returns vectors in input order', async () => {
    const fetchMock = stubFetch(200, {
      model: 'openai/text-embedding-3-small',
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    const provider = new OpenRouterProvider('https://openrouter.test', fetchMock);
    const result = await provider.embed(CREDS, { model: 'openai/text-embedding-3-small', inputs: ['a', 'b'] });
    expect(sent(fetchMock).body.input).toEqual(['a', 'b']);
    expect(result.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(result.usage.costUsd).toBeNull();
  });
});

describe('OpenRouterProvider.checkKey', () => {
  it('reports the remaining limit and treats an exhausted key as no credit', async () => {
    const ok = new OpenRouterProvider('https://openrouter.test', stubFetch(200, { data: { label: 'k', limit_remaining: 4.5 } }));
    await expect(ok.checkKey(CREDS)).resolves.toEqual({ limitRemainingUsd: 4.5 });
    const empty = new OpenRouterProvider('https://openrouter.test', stubFetch(200, { data: { limit_remaining: 0 } }));
    await expect(empty.checkKey(CREDS)).rejects.toMatchObject({ kind: 'credit' });
    const invalid = new OpenRouterProvider('https://openrouter.test', stubFetch(401, {}));
    await expect(invalid.checkKey(CREDS)).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('errorKindForStatus', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'credit'],
    [429, 'rate_limit'],
    [524, 'timeout'],
    [400, 'bad_request'],
    [413, 'bad_request'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [529, 'unavailable'],
  ])('%i → %s', (status, kind) => {
    expect(errorKindForStatus(status)).toBe(kind);
  });
});
