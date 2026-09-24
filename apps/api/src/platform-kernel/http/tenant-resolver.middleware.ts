import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestMiddleware,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Kysely } from 'kysely';

import { PLATFORM_DB, type Database } from '../db/database.js';
import { assignLogContext } from '../observability/logger.js';

import { AppError } from './app-error.js';

import type { HostKind, ResolvedTenant } from './request-context.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Tenant resolution from the `Host` header (research D2). The tenant never comes from the body,
 * query, params or any other header. Runs before authentication (run-log decision C1).
 */

/** Never tenant slugs (also rejected by the `tenants_slug_format` constraint). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'console',
  'api',
  'www',
  'admin',
  'static',
  'internal',
  'mail',
]);

const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9])*$/;

/** The unprefixed health routes (app.setup.ts UNPREFIXED_ROUTES). */
const HEALTH_PATH = /^\/health\/(live|ready)(\?|$)/;

export type HostResolution =
  | { kind: Extract<HostKind, 'console'> }
  | { kind: Extract<HostKind, 'tenant'>; tenant: ResolvedTenant };

export function tenantNotFound(): AppError {
  return new AppError('TENANT_NOT_FOUND', 404, 'Tenant not found');
}

export function tenantSuspended(): AppError {
  return new AppError('TENANT_SUSPENDED', 503, 'This workspace is currently unavailable');
}

/** `Acme.Localhost:5173` → `acme.localhost`. Returns undefined for anything that isn't a host name. */
export function normalizeHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(name) ? name : undefined;
}

/** The slug for `{slug}.{baseDomain}` (exactly one label), else undefined. */
export function slugFromHost(host: string, baseDomain: string): string | undefined {
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return undefined;
  const slug = host.slice(0, -suffix.length);
  if (slug.length < 3 || slug.length > 40 || !SLUG_PATTERN.test(slug)) return undefined;
  return slug;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value.toLowerCase();
}

/** Shared by the HTTP middleware and the Socket.IO handshake (T037). */
@Injectable()
export class TenantResolver {
  private readonly baseDomain = requireEnv('BASE_DOMAIN');
  private readonly consoleHost = requireEnv('CONSOLE_HOST');

  constructor(@Inject(PLATFORM_DB) private readonly db: Kysely<Database>) {}

  /** Throws 404 `TENANT_NOT_FOUND` for unknown, reserved or malformed hosts. */
  async resolve(rawHost: string | undefined): Promise<HostResolution> {
    const host = normalizeHost(rawHost);
    if (host === undefined) throw tenantNotFound();
    if (host === this.consoleHost) return { kind: 'console' };

    const slug = slugFromHost(host, this.baseDomain);
    if (slug === undefined || RESERVED_SLUGS.has(slug)) throw tenantNotFound();

    const row = await this.db
      .selectFrom('tenants')
      .select(['id', 'slug', 'status'])
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (row === undefined) throw tenantNotFound();
    return { kind: 'tenant', tenant: { id: row.id, slug: row.slug, status: row.status } };
  }
}

@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolver) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // Docker healthchecks call the container directly, without a tenant host.
    if (HEALTH_PATH.test(req.originalUrl)) {
      next();
      return;
    }
    // Use the raw Host header: X-Forwarded-Host is client-controlled.
    const resolution = await this.resolver.resolve(req.headers.host);
    req.hostKind = resolution.kind;
    if (resolution.kind === 'tenant') {
      req.tenant = resolution.tenant;
      assignLogContext({ tenantId: resolution.tenant.id });
    }
    next();
  }
}

export const ALLOW_SUSPENDED = 'replyx:allowSuspended';

/** Lets a route answer while its tenant is suspended (e.g. the customer "unavailable" branding). */
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);

/** 503 `TENANT_SUSPENDED` for a suspended tenant's routes, unless marked `@AllowSuspended()`. */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const tenant = context.switchToHttp().getRequest<Request>().tenant;
    if (tenant?.status !== 'suspended') return true;
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_SUSPENDED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed === true) return true;
    throw tenantSuspended();
  }
}
