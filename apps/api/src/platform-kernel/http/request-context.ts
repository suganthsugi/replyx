/**
 * What the HTTP pipeline attaches to each request, in pipeline order (constitution II, C1):
 * tenant from the host (tenant-resolver.middleware.ts) → session and actor (identity/auth.guard.ts)
 * → permission (authorization/permission.guard.ts).
 */

export interface ResolvedTenant {
  readonly id: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
}

/** `tenant`: `{slug}.{BASE_DOMAIN}`; `console`: `CONSOLE_HOST` (platform operators). */
export type HostKind = 'tenant' | 'console';

/** The authenticated caller, set by the auth guard. */
export interface RequestActor {
  readonly kind: 'staff' | 'customer';
  readonly userId: string;
  readonly sessionId: string;
}

// @types/express merges the global Express.Request into its Request type.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the only augmentation point
  namespace Express {
    interface Request {
      hostKind?: HostKind;
      /** Set for every request on a tenant host; never on the console host. */
      tenant?: ResolvedTenant;
      actor?: RequestActor;
    }
  }
}
