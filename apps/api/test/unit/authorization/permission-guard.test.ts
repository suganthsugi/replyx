import { Controller, Get, Post, type ExecutionContext } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PermissionGuard } from '../../../src/authorization/permission.guard.js';
import {
  CustomerApi,
  OperatorApi,
  Public,
  RequirePermission,
  StaffApi,
} from '../../../src/authorization/registry/module-permissions.js';
import { PermissionRegistry } from '../../../src/authorization/registry/registry.service.js';
import { auditRoutes, RouteAudit } from '../../../src/authorization/registry/route-audit.js';

import type { Decision } from '../../../src/authorization/policy.service.js';

const TENANT = { id: '0192f3c4-0000-7000-8000-00000000000a', slug: 'acme', status: 'active' as const };
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const staff = { kind: 'staff' as const, userId: USER, sessionId: 's1' };
const customer = { kind: 'customer' as const, userId: USER, sessionId: 's2' };

class Routes {
  @RequirePermission('group.create')
  staffRoute(this: void) {}
  @CustomerApi()
  customerRoute(this: void) {}
  @StaffApi()
  ownAccountRoute(this: void) {}
  @OperatorApi()
  operatorRoute(this: void) {}
  @Public()
  publicRoute(this: void) {}
  undecorated(this: void) {}
}

function run(handler: () => void, req: Record<string, unknown>, decision: Decision = 'allow') {
  const policy = { can: vi.fn(() => Promise.resolve(decision)) };
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1', headers: {}, ...req }) }),
  } as unknown as ExecutionContext;
  return { promise: new PermissionGuard(policy as never).canActivate(context), policy };
}

describe('PermissionGuard', () => {
  it('asks the policy for staff routes with the request context', async () => {
    const { promise, policy } = run(Routes.prototype.staffRoute, { tenant: TENANT, actor: staff });
    await expect(promise).resolves.toBe(true);
    expect(policy.can).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT.id, actor: { kind: 'user', id: USER }, requestId: 'req-1' }),
      'group.create',
    );
  });

  it('answers 403 PERMISSION_DENIED when the policy denies', async () => {
    const { promise } = run(Routes.prototype.staffRoute, { tenant: TENANT, actor: staff }, 'deny');
    await expect(promise).rejects.toMatchObject({ code: 'PERMISSION_DENIED', httpStatus: 403 });
  });

  it('answers 404 across audiences, the same as an unknown route', async () => {
    const onStaff = run(Routes.prototype.staffRoute, { tenant: TENANT, actor: customer });
    await expect(onStaff.promise).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404, message: 'Not found' });
    expect(onStaff.policy.can).not.toHaveBeenCalled();
    await expect(run(Routes.prototype.customerRoute, { tenant: TENANT, actor: staff }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets any staff session through own-account routes without asking the policy', async () => {
    const { promise, policy } = run(Routes.prototype.ownAccountRoute, { tenant: TENANT, actor: staff });
    await expect(promise).resolves.toBe(true);
    expect(policy.can).not.toHaveBeenCalled();
    await expect(run(Routes.prototype.ownAccountRoute, { tenant: TENANT, actor: customer }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets customers through customer routes', async () => {
    await expect(run(Routes.prototype.customerRoute, { tenant: TENANT, actor: customer }).promise).resolves.toBe(true);
  });

  it('requires the console host and an operator session on operator routes', async () => {
    await expect(run(Routes.prototype.operatorRoute, { hostKind: 'tenant' }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(run(Routes.prototype.operatorRoute, { hostKind: 'console' }).promise).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const operator = { operatorId: USER, sessionId: 'o1' };
    await expect(run(Routes.prototype.operatorRoute, { hostKind: 'console', operator }).promise).resolves.toBe(true);
  });

  it('passes public routes and refuses undecorated ones', async () => {
    await expect(run(Routes.prototype.publicRoute, {}).promise).resolves.toBe(true);
    await expect(run(Routes.prototype.undecorated, { tenant: TENANT, actor: staff }).promise).rejects.toThrow(
      'no single access decorator',
    );
  });
});

describe('auditRoutes', () => {
  const known = (key: string) => key === 'group.create';

  it('passes routes with exactly one valid decorator', () => {
    expect(
      auditRoutes(
        [
          { name: 'A.a', method: 'POST', path: '/groups', access: [{ kind: 'permission', permission: 'group.create' }] },
          { name: 'A.b', method: 'GET', path: '/customer/conversation', access: [{ kind: 'customer' }] },
          { name: 'A.c', method: 'GET', path: '/platform/tenants', access: [{ kind: 'operator' }] },
          { name: 'A.d', method: 'GET', path: '/auth/sign-in', access: [{ kind: 'public' }] },
          { name: 'A.e', method: 'GET', path: '/me', access: [{ kind: 'staff' }] },
        ],
        known,
      ),
    ).toEqual([]);
  });

  it('reports missing, duplicate and unknown decorators and misplaced audiences', () => {
    const problems = auditRoutes(
      [
        { name: 'B.none', method: 'GET', path: '/x', access: [] },
        { name: 'B.two', method: 'GET', path: '/x', access: [{ kind: 'public' }, { kind: 'customer' }] },
        { name: 'B.unknown', method: 'GET', path: '/x', access: [{ kind: 'permission', permission: 'nope.view' }] },
        { name: 'B.customerOutside', method: 'GET', path: '/tickets', access: [{ kind: 'customer' }] },
        { name: 'B.staffInside', method: 'GET', path: '/customer/x', access: [{ kind: 'permission', permission: 'group.create' }] },
        { name: 'B.operatorOutside', method: 'GET', path: '/tenants', access: [{ kind: 'operator' }] },
        { name: 'B.staffOnData', method: 'GET', path: '/tickets', access: [{ kind: 'staff' }] },
      ],
      known,
    );
    expect(problems).toHaveLength(7);
    expect(problems.join('\n')).toMatch(/B\.staffOnData .*only live under \/auth or \/me/);
    expect(problems.join('\n')).toMatch(/B\.none .*no access decorator/);
    expect(problems.join('\n')).toMatch(/B\.two .*2 access decorators/);
    expect(problems.join('\n')).toMatch(/B\.unknown .*unknown permission nope\.view/);
  });
});

describe('RouteAudit', () => {
  @Controller('customer/things')
  @CustomerApi()
  class CustomerThings {
    @Get()
    list() {}
    @Post(':id')
    @StaffApi()
    act() {}
    @Post('public')
    @Public()
    open() {}
    helper() {}
  }

  @Controller('groups')
  class Groups {
    @Post()
    @RequirePermission('group.create')
    create() {}
    @Get()
    list() {}
  }

  async function audit() {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [CustomerThings, Groups],
      providers: [RouteAudit, { provide: PermissionRegistry, useValue: { has: (key: string) => key === 'group.create' } }],
    }).compile();
    return moduleRef.get(RouteAudit);
  }

  it('discovers every route handler with its path and effective access', async () => {
    const routes = (await audit()).routes();
    expect(routes.map((r) => [r.name, r.path, r.access.map((a) => a.kind)])).toEqual([
      ['CustomerThings.list', '/customer/things', ['customer']],
      ['CustomerThings.act', '/customer/things/:id', ['staff']],
      ['CustomerThings.open', '/customer/things/public', ['public']],
      ['Groups.create', '/groups', ['permission']],
      ['Groups.list', '/groups', []],
    ]);
  });

  it('fails start-up listing each problem', async () => {
    const routeAudit = await audit();
    let message = '';
    try {
      routeAudit.onApplicationBootstrap();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Route access audit failed:/);
    expect(message).toContain('CustomerThings.act (/customer/things/:id): only customer (or public) routes may live under /customer');
    expect(message).toContain('Groups.list (/groups) has no access decorator');
    expect(message).not.toContain('CustomerThings.open');
  });
});
