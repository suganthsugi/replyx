import { describe, expect, it } from 'vitest';

import { SessionService, STAFF_IDLE_MS } from '../../../src/identity/session.service.js';
import { SessionExpirySweeper } from '../../../src/platform-kernel/realtime/session-expiry.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser } from '../../support/factories.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

describe('socket session expiry', () => {
  it('keeps sockets whose session slid through HTTP use and closes idle ones', async () => {
    const { clock } = await getTestApp();
    const sweeper = await service(SessionExpirySweeper);
    const tenant = await createTenant();
    const [active, idle] = await Promise.all([createUser(tenant, { roles: ['agent'] }), createUser(tenant, { roles: ['agent'] })]);

    const activeSocket = await connectSocket(active);
    const idleSocket = await connectSocket(idle);
    const idleClosing = waitForEvent<{ code: string }>(idleSocket, 'closing', () => true, 10_000);
    const activeClosed = { value: false };
    activeSocket.on('closing', () => {
      activeClosed.value = true;
    });

    // Both sessions are still inside their idle window: nothing to close.
    clock.advance(STAFF_IDLE_MS - 60_000);
    expect(await sweeper.sweep()).toBe(0);

    // The active user makes an authenticated request (what the auth guard does), which slides
    // their expiry; then both handshake expiries pass.
    // (The 60 s lookup cache runs on real time, which the test clock skips: drop it first.)
    const sessions = await service(SessionService);
    await sessions.purgeCache(tenant.id, [active.sessionId ?? '', idle.sessionId ?? '']);
    await sessions.authenticate(tenant.id, active.sessionToken);
    clock.advance(2 * 60_000);
    expect(await sweeper.sweep()).toBe(1);
    await expect(idleClosing).resolves.toEqual({ code: 'SESSION_EXPIRED' });
    expect(activeClosed.value).toBe(false);
    expect(activeSocket.connected).toBe(true);

    activeSocket.close();
    idleSocket.close();
  });
});
