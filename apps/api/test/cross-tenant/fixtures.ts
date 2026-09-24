import type { RoleRef, TestTenant, TestUser } from '../support/factories.js';

/**
 * Cross-tenant fixtures (research D25, SC-010, testing-conventions rule 7). Every registry
 * resource that has a route needs one: the generated suite (cross-tenant.test.ts) creates the
 * resource in tenant A with `create`, then calls each of the resource's routes as a tenant B
 * user who holds the route's permission, and expects the same 404 as for an unknown id (lists:
 * no tenant A ids). A route whose resource has no fixture fails the suite.
 *
 * Staff routes are keyed by the registry resource (`ticket`, `group`, ...); customer routes
 * (`@CustomerApi`) by `customer:{first path segment after /customer}`, e.g. `customer:conversation`.
 */

export interface CreatedResource {
  /** Values for the route's path parameters, by name (`id`, `messageId`, ...). */
  params: Record<string, string>;
  /** Ids that must never appear in tenant B's responses. */
  ids: string[];
}

export interface CrossTenantFixture {
  /** Creates the resource (and anything it needs) in `tenant`. */
  create(tenant: TestTenant): Promise<CreatedResource>;
  /**
   * A valid request body per route name (`Controller.method`) for non-GET routes, so the
   * request reaches the service's lookup instead of failing validation.
   */
  bodies?: Record<string, (resource: CreatedResource) => object>;
  /** Roles for the tenant B caller; defaults to Admin (every permission, full group access). */
  callerRoles?: RoleRef[];
}

export const FIXTURES: Record<string, CrossTenantFixture> = {};

/**
 * Extra cross-tenant checks added by later stories: real-time subscriptions (a tenant B socket
 * subscribing to a tenant A stream acks NOT_FOUND) and attachment downloads.
 */
export type CrossTenantCheck = (a: TestTenant, b: TestTenant, callerB: TestUser) => Promise<void>;

export const REALTIME_CHECKS: Record<string, CrossTenantCheck> = {};
export const ATTACHMENT_CHECKS: Record<string, CrossTenantCheck> = {};
