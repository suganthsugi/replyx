import { connect } from 'node:net';

/**
 * The development clock offset the api and worker honour (apps/api/src/platform-kernel/clock.ts):
 * a millisecond counter in Valkey that both refresh once a second. `pnpm --filter api
 * dev:advance-clock` writes the same key; the playwright container shares the compose network, so
 * a tiny RESP client here does the same INCRBY/DEL without needing the api's code or ioredis.
 */

const KEY = 'replyx:dev:clock-offset-ms';
const HOST = process.env.E2E_VALKEY_HOST ?? 'valkey';
const PORT = Number(process.env.E2E_VALKEY_PORT ?? 6379);

function commandOnce(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: PORT });
    const payload = `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
    let reply = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('Valkey did not answer'));
    });
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      if (reply.includes('\r\n')) {
        socket.end();
        if (reply.startsWith('-')) reject(new Error(`Valkey: ${reply.trim()}`));
        else resolve(reply.trim());
      }
    });
    socket.on('error', reject);
  });
}

/** Moves the api's and worker's clocks forward by `hours` (they pick it up within a second). */
export async function advanceClock(hours: number): Promise<void> {
  await command('INCRBY', KEY, String(Math.round(hours * 3_600_000)));
}

/** Back to real time. */
export async function resetClock(): Promise<void> {
  await command('DEL', KEY);
}

/** Compose DNS can answer EAI_AGAIN under load: try a few times before giving up. */
async function command(...args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commandOnce(...args);
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
