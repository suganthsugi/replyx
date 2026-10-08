import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound HTTP to tenant-supplied hosts (store connections; specs/002-ai-assist research R9).
 *
 * A tenant admin chooses the URL, so the request must never reach our own network: only https,
 * and every address the host resolves to must be public. The check runs inside the socket's DNS
 * lookup, so a name that re-resolves to a private address between the check and the connect
 * (DNS rebinding) is still refused. Redirects are not followed. In development (`allowPrivate`)
 * http and private addresses are allowed so a local store (host.docker.internal) works.
 */

export type OutboundRefusal = 'invalid_url' | 'not_https' | 'private_address' | 'unresolvable';

export class OutboundRefusedError extends Error {
  constructor(readonly reason: OutboundRefusal) {
    super(`Outbound request refused: ${reason}`);
    this.name = 'OutboundRefusedError';
  }
}

export class OutboundTimeoutError extends Error {
  constructor() {
    super('Outbound request timed out');
    this.name = 'OutboundTimeoutError';
  }
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (v4, v6, v4-mapped v6). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1] !== undefined) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true;
}

export function defaultAllowPrivate(): boolean {
  return process.env.NODE_ENV === 'development';
}

/** Validates the URL shape (not DNS). Use on save so the admin gets an immediate field error. */
export function checkOutboundUrl(raw: string, allowPrivate = defaultAllowPrivate()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefusedError('invalid_url');
  }
  if (url.username !== '' || url.password !== '') throw new OutboundRefusedError('invalid_url');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new OutboundRefusedError('not_https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) throw new OutboundRefusedError('private_address');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) throw new OutboundRefusedError('private_address');
  return url;
}

export interface OutboundRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Responses larger than this are cut off with an error (default 2 MB). */
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface OutboundResponse {
  status: number;
  body: string;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Exported for tests: the socket lookup that refuses private addresses. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err !== null) {
        callback(new OutboundRefusedError('unresolvable'), []);
        return;
      }
      if (addresses.length === 0 || (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))) {
        callback(new OutboundRefusedError(addresses.length === 0 ? 'unresolvable' : 'private_address'), []);
        return;
      }
      if (options.all === true) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** One request, no redirects, bounded time and size. Rejects with `OutboundRefusedError` / `OutboundTimeoutError`. */
export async function outboundRequest(req: OutboundRequest): Promise<OutboundResponse> {
  const allowPrivate = req.allowPrivate ?? defaultAllowPrivate();
  const url = checkOutboundUrl(req.url, allowPrivate);
  const maxBytes = req.maxBytes ?? 2 * 1024 * 1024;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };
    const request = send(
      url,
      { method: req.method ?? 'GET', headers: req.headers, lookup: guardedLookup(allowPrivate) },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new Error('Outbound response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        response.on('error', fail);
      },
    );
    const timer = setTimeout(() => fail(new OutboundTimeoutError()), req.timeoutMs);
    request.on('error', fail);
    request.on('close', () => clearTimeout(timer));
    if (req.body !== undefined) request.write(req.body);
    request.end();
  });
}
