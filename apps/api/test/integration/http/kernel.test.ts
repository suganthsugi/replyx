import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Public, RequirePermission } from '../../../src/authorization/registry/module-permissions.js';
import { createDatabase } from '../../../src/platform-kernel/db/database.js';
import { RateLimit } from '../../../src/platform-kernel/http/rate-limit.js';
import { ZodValidationPipe } from '../../../src/platform-kernel/http/validation.pipe.js';
import { getTestApp } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';

/**
 * The HTTP kernel end to end (T050): error envelope, validation, tenant resolution, suspension,
 * CSRF, authentication across hosts, permissions and rate limits. The probe routes exist only in
 * this test's app.
 */

const CreateItem = z.object({ name: z.string().min(1).max(5) }).strict();

@Controller('probe')
class ProbeController {
  @Post('items')
  @HttpCode(201)
  @RequirePermission('group.create')
  create(@Body(new ZodValidationPipe(CreateItem)) body: z.infer<typeof CreateItem>) {
    return { name: body.name };
  }

  @Get('items')
  @RequirePermission('group.view')
  list() {
    return { items: [], nextCursor: null };
  }

  @Get('limited')
  @Public()
  @RateLimit('sign-in')
  limited() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let tenant: TestTenant;
let admin: TestUser;
let agent: TestUser;

beforeAll(async () => {
  await getTestApp({ imports: [ProbeModule] });
  tenant = await createTenant();
  admin = await createUser(tenant, { roles: ['admin'] });
  agent = await createUser(tenant, { roles: ['agent'] });
});

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

describe('HTTP kernel', () => {
  it('answers success and 403 PERMISSION_DENIED from the policy', async () => {
    expect((await asUser(admin).post('/probe/items', { name: 'abc' })).status).toBe(201);
    const denied = await asUser(agent).post('/probe/items', { name: 'abc' });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to do this' } });
  });

  it('rejects invalid and unknown fields with 400 VALIDATION_FAILED details', async () => {
    const response = await asUser(admin).post('/probe/items', { name: 'too long', extra: 1 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect((response.body as { error: { details: unknown[] } }).error.details).toEqual(
      expect.arrayContaining([
        { path: 'name', issue: 'too_long' },
        { path: 'extra', issue: 'unrecognized_key' },
      ]) as unknown[],
    );
  });

  it('answers 401 UNAUTHENTICATED without a session and for another tenant host', async () => {
    const guest = await asGuest(tenant).get('/probe/items');
    expect(guest.status).toBe(401);
    expect(guest.body).toEqual(errorBody('UNAUTHENTICATED'));

    const other = await createTenant();
    const crossHost = await asUser(admin, { host: other.host }).get('/probe/items');
    expect(crossHost.status).toBe(401);
    expect(crossHost.body).toEqual(guest.body);
  });

  it('answers 404 for unknown routes, unknown tenants and reserved slugs', async () => {
    const route = await asUser(admin).get('/probe/nope');
    expect(route.status).toBe(404);
    expect(route.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    for (const host of ['no-such-tenant-xyz.localhost', 'admin.localhost', 'api.localhost', 'a.b.localhost']) {
      const response = await asGuest(host).get('/probe/items');
      expect([host, response.status]).toEqual([host, 404]);
      expect(response.body).toEqual(errorBody('TENANT_NOT_FOUND'));
    }
  });

  it('requires X-CSRF-Token on non-GET requests', async () => {
    const missing = await asUser(admin, { csrf: false }).post('/probe/items', { name: 'abc' });
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual(errorBody('CSRF_FAILED'));
    // GET needs no token.
    expect((await asUser(admin, { csrf: false }).get('/probe/items')).status).toBe(200);
  });

  it('hides staff routes from customers with 404', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const response = await asUser(customer).get('/probe/items');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('answers 429 RATE_LIMITED with Retry-After after the policy limit', async () => {
    const own = await createTenant();
    const statuses: number[] = [];
    let last: Awaited<ReturnType<ReturnType<typeof asGuest>['get']>> | undefined;
    for (let i = 0; i < 11; i++) {
      last = await asGuest(own).get('/probe/limited');
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(last?.status).toBe(429);
    expect(last?.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) as string, retryAfter: expect.any(Number) as number } });
    expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('answers 503 TENANT_SUSPENDED for a suspended tenant', async () => {
    const suspended = await createTenant();
    const user = await createUser(suspended, { roles: ['admin'] });
    const platform = createDatabase(process.env.DATABASE_URL_PLATFORM as string, 'platform');
    try {
      await sql`UPDATE tenants SET status = 'suspended', suspended_at = now() WHERE id = ${suspended.id}`.execute(platform);
    } finally {
      await platform.destroy();
    }
    const response = await asUser(user).get('/probe/items');
    expect(response.status).toBe(503);
    expect(response.body).toEqual(errorBody('TENANT_SUSPENDED'));
  });
});
