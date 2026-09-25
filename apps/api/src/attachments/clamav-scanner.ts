import { connect, type Socket } from 'node:net';

import type { MalwareScanner, ScanVerdict } from './scan.job.js';
import type { Readable } from 'node:stream';

/**
 * clamd's `INSTREAM` over TCP (`CLAMAV_HOST`, `host` or `host:port`, default port 3310): the file
 * is sent as length-prefixed chunks and clamd answers `stream: OK` or
 * `stream: <signature> FOUND`. Anything else (an error reply, a timeout, a dropped connection)
 * throws, so the job retries rather than passing a file it couldn't scan.
 */

const DEFAULT_PORT = 3310;
const TIMEOUT_MS = 60_000;
const MAX_CHUNK = 64 * 1024;

export function parseClamdAddress(value: string): { host: string; port: number } {
  const [host, port] = value.split(':');
  if (host === undefined || host === '') throw new Error('CLAMAV_HOST is empty');
  const parsed = port === undefined ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('CLAMAV_HOST has an invalid port');
  return { host, port: parsed };
}

/** clamd's reply, without the trailing NUL. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0+$/, '').trim();
  if (text === 'stream: OK') return { verdict: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1] !== undefined) return { verdict: 'infected', signature: found[1] };
  throw new Error(`Unexpected clamd reply: ${text.slice(0, 200)}`);
}

export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';
  private readonly address: { host: string; port: number };

  constructor(address: string) {
    this.address = parseClamdAddress(address);
  }

  scan(file: Readable): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.address);
      const replies: Buffer[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        file.destroy();
        reject(error);
      };
      socket.setTimeout(TIMEOUT_MS, () => fail(new Error('clamd timed out')));
      socket.on('error', fail);
      socket.on('data', (chunk: Buffer) => replies.push(chunk));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(parseClamdReply(Buffer.concat(replies).toString('utf8')));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Unreadable clamd reply'));
        }
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        file.on('data', (data: Buffer) => {
          for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
            const part = data.subarray(offset, offset + MAX_CHUNK);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(part.length);
            socket.write(size);
            socket.write(part);
          }
        });
        file.on('error', fail);
        file.on('end', () => socket.write(Buffer.alloc(4)));
      });
    });
  }
}
