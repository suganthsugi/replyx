import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS } from '../../../src/platform-kernel/observability/logger.js';

describe('AI key redaction', () => {
  it('never logs provider or store keys', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      apiKey: 'sk-or-v1-top',
      input: { apiKey: 'sk_store_nested' },
      headers: { authorization: 'Bearer sk-or-v1-header', 'x-spree-api-key': 'sk_spree_header' },
      request: { headers: { authorization: 'Bearer sk-or-v1-deep', 'x-spree-api-key': 'sk_spree_deep' } },
      model: 'kept-model',
    });
    const output = lines.join('');
    for (const leaked of ['sk-or-v1-top', 'sk_store_nested', 'sk-or-v1-header', 'sk_spree_header', 'sk-or-v1-deep', 'sk_spree_deep']) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain('kept-model');
  });
});
