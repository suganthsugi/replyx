import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OutboundRefusedError,
  OutboundTimeoutError,
  checkOutboundUrl,
  guardedLookup,
  isPrivateAddress,
  outboundRequest,
} from '../../../src/platform-kernel/http/outbound-guard.js';

// vitest's `vi.mock('node:dns')` does not intercept the guard's import in this SWC setup (the real
// lookup ran, so every name was "unresolvable"). IP literals resolve to themselves without a DNS
// query, so the guard's address checks are exercised deterministically without a mock.


function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof OutboundRefusedError ? error.reason : 'other';
  }
  return undefined;
}

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('checkOutboundUrl', () => {
  it('accepts public https URLs', () => {
    expect(checkOutboundUrl('https://shop.example.com/api', false).hostname).toBe('shop.example.com');
  });

  it('refuses bad, non-https, credentialed, localhost and private-IP URLs', () => {
    expect(refusal(() => checkOutboundUrl('not a url', false))).toBe('invalid_url');
    expect(refusal(() => checkOutboundUrl('http://shop.example.com', false))).toBe('not_https');
    expect(refusal(() => checkOutboundUrl('ftp://shop.example.com', false))).toBe('not_https');
    expect(refusal(() => checkOutboundUrl('https://user:pw@shop.example.com', false))).toBe('invalid_url');
    expect(refusal(() => checkOutboundUrl('https://localhost:3000', false))).toBe('private_address');
    expect(refusal(() => checkOutboundUrl('https://api.localhost', false))).toBe('private_address');
    expect(refusal(() => checkOutboundUrl('https://127.0.0.1', false))).toBe('private_address');
    expect(refusal(() => checkOutboundUrl('https://[::1]/x', false))).toBe('private_address');
  });

  it('allows http and private hosts only when allowPrivate is set (development)', () => {
    expect(checkOutboundUrl('http://host.docker.internal:3100', true).port).toBe('3100');
  });
});

describe('guardedLookup', () => {
  function resolve(host: string, allowPrivate: boolean): Promise<unknown> {
    return new Promise((done) => {
      guardedLookup(allowPrivate)(host, { all: true }, (err, addresses) => done(err ?? addresses));
    });
  }

  it('refuses a name that resolves to a private address (what a rebinding name resolves to)', async () => {
    expect(await resolve('10.1.2.3', false)).toBeInstanceOf(OutboundRefusedError);
    expect(await resolve('localhost', false)).toBeInstanceOf(OutboundRefusedError);
  });

  it('passes public addresses, and private ones in development', async () => {
    expect(await resolve('93.184.216.34', false)).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(await resolve('10.1.2.3', true)).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });
});

describe('outboundRequest', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500);
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      if (req.url === '/big') {
        res.end('x'.repeat(2048));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ key: req.headers['x-spree-api-key'] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('sends headers and returns status and body (development)', async () => {
    const res = await outboundRequest({ url: `${base}/ok`, headers: { 'x-spree-api-key': 'sk_1' }, timeoutMs: 1000, allowPrivate: true });
    expect(res).toEqual({ status: 200, body: '{"key":"sk_1"}' });
  });

  it('does not follow redirects', async () => {
    const res = await outboundRequest({ url: `${base}/redirect`, timeoutMs: 1000, allowPrivate: true });
    expect(res.status).toBe(302);
  });

  it('times out and caps the response size', async () => {
    await expect(outboundRequest({ url: `${base}/slow`, timeoutMs: 100, allowPrivate: true })).rejects.toBeInstanceOf(
      OutboundTimeoutError,
    );
    await expect(outboundRequest({ url: `${base}/big`, timeoutMs: 1000, maxBytes: 100, allowPrivate: true })).rejects.toThrow(
      'too large',
    );
  });

  it('refuses private targets outside development', async () => {
    await expect(outboundRequest({ url: base, timeoutMs: 1000, allowPrivate: false })).rejects.toMatchObject({ reason: 'not_https' });
    await expect(outboundRequest({ url: 'https://10.1.2.3/x', timeoutMs: 1000, allowPrivate: false })).rejects.toMatchObject({
      reason: 'private_address',
    });
  });
});
