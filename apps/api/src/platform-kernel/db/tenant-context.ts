/**
 * Who is acting, for which tenant, in which request (research D3). Every tenant-scoped unit of
 * work and repository needs one, and one cannot exist without a valid `tenantId`.
 *
 * The tenant id must come from the resolved host (`req.tenant.id`) or from a job payload that was
 * enqueued from an existing context. Never build one from request body, query, params or headers.
 */

/** Matches `actor_kind` in audit_logs / ticket history (data-model.md). */
export type Actor =
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'operator'; readonly id: string }
  | { readonly kind: 'automation'; readonly id: string }
  | { readonly kind: 'system' };

export interface TenantContextInit {
  tenantId: string;
  actor: Actor;
  requestId: string;
  /** Client IP for audit entries (HTTP requests only). */
  ip?: string | null;
  /**
   * Forces every unit of work opened with this context to be read-only, whichever method the
   * caller uses. Set for operator support-access requests (FR-001a): the guarantee belongs to
   * the actor, not to each call site.
   */
  readOnly?: boolean;
  /**
   * Why this work runs, stamped on every outbox event it writes (outbox.service.ts): an automation
   * rule's run carries its rule id and chain depth, so the rule never runs on its own events and
   * chains stop at the maximum depth (FR-089).
   */
  cause?: ContextCause;
}

/** Same shape as the outbox's `EventCause` (kept here so the kernel types don't import upwards). */
export interface ContextCause {
  ruleId?: string;
  depth?: number;
  eventId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_IP_LENGTH = 64;

export class TenantContext {
  readonly tenantId: string;
  readonly actor: Actor;
  readonly requestId: string;
  readonly ip: string | null;
  readonly readOnly: boolean;
  readonly cause: Readonly<ContextCause> | null;

  // A private field makes the class nominal: an object literal is not a TenantContext.
  readonly #brand = true;

  private constructor(init: TenantContextInit) {
    this.tenantId = init.tenantId.toLowerCase();
    this.actor = Object.freeze({ ...init.actor });
    this.requestId = init.requestId;
    this.ip = init.ip ?? null;
    this.readOnly = init.readOnly === true;
    this.cause = init.cause === undefined ? null : Object.freeze({ ...init.cause });
    Object.freeze(this);
  }

  /** Throws (a programming error, not a client error) when any part is missing or malformed. */
  static create(init: TenantContextInit): TenantContext {
    const { tenantId, actor, requestId, ip, readOnly, cause } = init as Partial<TenantContextInit>;
    if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
      throw new TypeError('TenantContext requires a tenantId (uuid)');
    }
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
      throw new TypeError('TenantContext requires a requestId');
    }
    if (ip !== undefined && ip !== null && (typeof ip !== 'string' || ip.length > MAX_IP_LENGTH)) {
      throw new TypeError('TenantContext ip must be a short string');
    }
    assertActor(actor);
    return new TenantContext({ tenantId, actor, requestId, ip, readOnly: readOnly === true, ...(cause === undefined ? {} : { cause }) });
  }

  static isTenantContext(value: unknown): value is TenantContext {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}

function assertActor(actor: unknown): asserts actor is Actor {
  if (typeof actor !== 'object' || actor === null) {
    throw new TypeError('TenantContext requires an actor');
  }
  const { kind, id } = actor as { kind?: unknown; id?: unknown };
  switch (kind) {
    case 'system':
      return;
    case 'user':
    case 'operator':
    case 'automation':
      if (typeof id === 'string' && UUID_PATTERN.test(id)) return;
      throw new TypeError(`TenantContext actor of kind "${kind}" requires an id (uuid)`);
    default:
      throw new TypeError('TenantContext actor has an unknown kind');
  }
}
