import { describe, expect, it } from 'vitest';

import {
  DECISION_MODEL,
  DEFAULT_LEVEL_MODELS,
  EMBEDDING_MODEL,
  costOf,
  isSelectableModel,
  modelForLevel,
} from '../../../../src/ai/providers/catalog.js';
import { FakeAiProvider, bagOfWords } from '../../../../src/ai/providers/fake/fake.provider.js';
import { providerFromEnv } from '../../../../src/ai/providers/provider-from-env.js';

const CREDS = { apiKey: 'any' };

describe('catalog', () => {
  it('pins Jev and defaults every level to a selectable model', () => {
    expect(DECISION_MODEL.id).toBe('typesafe/jev-1.13');
    expect(EMBEDDING_MODEL.dimensions).toBe(1536);
    for (const level of ['fast', 'standard', 'advanced'] as const) {
      expect(isSelectableModel(level, DEFAULT_LEVEL_MODELS[level])).toBe(true);
    }
  });

  it('falls back to the default for unknown or cross-level choices', () => {
    expect(modelForLevel({ fast: 'google/gemini-2.5-flash-lite' }, 'fast')).toBe('google/gemini-2.5-flash-lite');
    expect(modelForLevel({ fast: 'anthropic/claude-sonnet-5.5' }, 'fast')).toBe(DEFAULT_LEVEL_MODELS.fast);
    expect(modelForLevel({}, 'advanced')).toBe(DEFAULT_LEVEL_MODELS.advanced);
  });

  it('prefers the provider cost and otherwise estimates from list prices (dated ids too)', () => {
    expect(costOf('anthropic/claude-haiku-5.5', { inputTokens: 1, outputTokens: 1, costUsd: 0.5 })).toEqual({ costUsd: 0.5, estimated: false });
    expect(costOf('anthropic/claude-haiku-5.5', { inputTokens: 6000, outputTokens: 300, costUsd: null })).toEqual({
      costUsd: 0.00075,
      estimated: true,
    });
    expect(costOf('typesafe/jev-1.13-20260917', { inputTokens: 1_000_000, outputTokens: 0, costUsd: null }).costUsd).toBe(0.042);
    expect(costOf('unknown/model', { inputTokens: 1, outputTokens: 1, costUsd: null })).toEqual({ costUsd: null, estimated: true });
  });
});

describe('FakeAiProvider', () => {
  it('fails for the scripted bad keys', async () => {
    const fake = new FakeAiProvider();
    await expect(fake.checkKey({ apiKey: 'fake-invalid' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(fake.checkKey({ apiKey: 'fake-no-credit' })).rejects.toMatchObject({ kind: 'credit' });
    await expect(fake.complete({ apiKey: 'fake-down' }, { model: 'm', messages: [] })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('answers decisions from markers and word overlap', async () => {
    const fake = new FakeAiProvider();
    const result = await fake.decide(CREDS, {
      model: 'typesafe/jev-1.13',
      state: 'I was charged twice on my card [fake:wants_human] [fake:frustration=2]',
      questions: {
        wants_human: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n' } },
        refund: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n' } },
        frustration: { type: 'score', instructions: '?', criteria: ['calm', 'annoyed', 'angry'] },
        team: { type: 'choice', instructions: '?', criteria: { g1: 'Billing: charges, invoices and payments', g2: 'Shipping and delivery', none: 'None fit' } },
      },
    });
    expect(result.answers.wants_human).toEqual({ type: 'noul', noul: 0.95 });
    expect(result.answers.refund).toEqual({ type: 'noul', noul: 0.05 });
    expect(result.answers.frustration).toMatchObject({ type: 'score', score: 2 });
    expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'g1' });

    const none = await fake.decide(CREDS, {
      model: 'm',
      state: 'hello there',
      questions: { team: { type: 'choice', instructions: '?', criteria: { g1: 'Billing', none: 'None fit' } } },
    });
    expect(none.answers.team).toMatchObject({ choice: 'none' });
  });

  it('runs the order tool loop', async () => {
    const fake = new FakeAiProvider();
    const tools = [
      { name: 'lookup_order', description: '', parameters: {} },
      { name: 'search_policies', description: '', parameters: {} },
    ];
    const schema = { name: 'answer', schema: {} };
    const ask = await fake.complete(CREDS, {
      model: 'm',
      tools,
      responseSchema: schema,
      messages: [{ role: 'user', content: '<customer_message>Where is my order?</customer_message>' }],
    });
    expect(JSON.parse(ask.content!)).toMatchObject({ awaiting: 'order_number', resolved: true });

    const call = await fake.complete(CREDS, {
      model: 'm',
      tools,
      responseSchema: schema,
      messages: [{ role: 'user', content: '<customer_message>R100200</customer_message>' }],
    });
    expect(call.toolCalls).toEqual([{ id: 'call_order', name: 'lookup_order', arguments: '{"orderNumber":"R100200"}' }]);

    const answer = await fake.complete(CREDS, {
      model: 'm',
      tools,
      responseSchema: schema,
      messages: [
        { role: 'user', content: '<customer_message>R100200</customer_message>' },
        { role: 'assistant', content: null, toolCalls: call.toolCalls },
        { role: 'tool', toolCallId: 'call_order', content: JSON.stringify({ number: 'R100200', status: 'shipped', shipments: [{ tracking: 'TRK1' }] }) },
      ],
    });
    expect((JSON.parse(answer.content!) as { reply: string }).reply).toBe('Your order R100200 is shipped, tracking number TRK1.');
  });

  it('can be scripted and records calls', async () => {
    const fake = new FakeAiProvider();
    fake.script = () => ({ content: 'scripted', toolCalls: [] });
    const result = await fake.complete(CREDS, { model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(result.content).toBe('scripted');
    expect(fake.calls).toHaveLength(1);
    fake.reset();
    expect(fake.calls).toHaveLength(0);
  });

  it('embeds similar texts close together', () => {
    const a = bagOfWords('returns accepted within 30 days', 64);
    const b = bagOfWords('can I return it within 30 days', 64);
    const c = bagOfWords('shipping to Mumbai takes a week', 64);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});

describe('providerFromEnv', () => {
  it('picks fake by default outside production and refuses fake in production', () => {
    expect(providerFromEnv({ NODE_ENV: 'test' }).name).toBe('fake');
    expect(providerFromEnv({ NODE_ENV: 'production' }).name).toBe('openrouter');
    expect(() => providerFromEnv({ NODE_ENV: 'production', AI_PROVIDER: 'fake' })).toThrow('not allowed');
    expect(() => providerFromEnv({ AI_PROVIDER: 'other' })).toThrow('Unknown AI_PROVIDER');
  });
});
