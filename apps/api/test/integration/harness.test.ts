import { describe, expect, it } from 'vitest';

import { SessionService } from '../../src/identity/session.service.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../src/platform-kernel/db/unit-of-work.js';
import { getTestWorker, service } from '../support/app.js';
import { createGroup, createTenant, createUser } from '../support/factories.js';
import { asGuest, asUser } from '../support/http.js';
import { connectResult, connectSocket, waitForEvent } from '../support/socket.js';

describe('test harness', () => {
  it('serves the real pipeline on the tenant host', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const unknown = await asUser(admin).get('/does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });

    const unknownTenant = await asGuest('tenant-missing-xyz.localhost').get('/does-not-exist');
    expect(unknownTenant.status).toBe(404);
    expect(unknownTenant.body).toMatchObject({ error: { code: 'TENANT_NOT_FOUND' } });

    const ready = await asGuest(tenant).get('/health/ready');
    expect(ready.status).toBe(200);
  });

  it('creates users with system and group access', async () => {
    const tenant = await createTenant();
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: true } }] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    expect(customer.kind).toBe('customer');
    expect(group.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('connects sockets per audience and delivers relay control events', async () => {
    await getTestWorker();
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });

    expect(await connectResult(customer, { namespace: '/' })).toBe('UNAUTHENTICATED');
    expect(await connectResult(agent, { anonymous: true })).toBe('UNAUTHENTICATED');

    const socket = await connectSocket(agent);
    const closing = waitForEvent<{ code: string }>(socket, 'closing', () => true, 10_000);
    const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test' });
    const sessions = await service(SessionService);
    await (await service(UnitOfWork)).withTenant(ctx, (tx) => sessions.revokeAllForUser(tx, agent.id, 'sign_out_all'));
    await expect(closing).resolves.toEqual({ code: 'SESSION_REVOKED' });
    socket.close();
  });
});
