/**
 * Permission declarations and route access decorators (research D6, constitution II/III).
 *
 * A module declares its resources and actions once with `definePermissions()` and registers the
 * result as a provider (`permissionsProvider()`); the registry collects every declaration at
 * start-up. Every controller route carries exactly one access decorator (checked at start-up by
 * `route-audit.ts`).
 */

export type PermissionKey = `${string}.${string}`;

export interface PermissionAction {
  action: string;
  description: string;
}

export interface ModulePermissions {
  /** Owning module, e.g. `tickets`. */
  module: string;
  resources: readonly { resource: string; actions: readonly PermissionAction[] }[];
}

const DECLARATION = Symbol('replyx:modulePermissions');

type BrandedDeclaration = ModulePermissions & { readonly [DECLARATION]: true };

const NAME_PATTERN = /^[a-z][a-z_]*$/;

export function definePermissions(declaration: ModulePermissions): ModulePermissions {
  for (const name of [declaration.module, ...declaration.resources.flatMap((r) => [r.resource, ...r.actions.map((a) => a.action)])]) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid permission name "${name}" in module ${declaration.module}`);
    }
  }
  return Object.freeze({ ...declaration, [DECLARATION]: true as const });
}

export function isModulePermissions(value: unknown): value is ModulePermissions {
  return typeof value === 'object' && value !== null && (value as Partial<BrandedDeclaration>)[DECLARATION] === true;
}

/** `providers: [permissionsProvider(TicketPermissions)]` in the owning module. */
export function permissionsProvider(declaration: ModulePermissions) {
  return { provide: `replyx:permissions:${declaration.module}`, useValue: declaration };
}

export function permissionKeys(declaration: ModulePermissions): PermissionKey[] {
  return declaration.resources.flatMap((r) => r.actions.map((a): PermissionKey => `${r.resource}.${a.action}`));
}

// ---------------------------------------------------------------------------------------------
// Route access decorators
// ---------------------------------------------------------------------------------------------

/** Metadata key holding how a route is authorized. */
export const ROUTE_ACCESS = 'replyx:routeAccess';

export type RouteAccess =
  | { kind: 'permission'; permission: PermissionKey }
  | { kind: 'public' }
  | { kind: 'staff' }
  | { kind: 'customer' }
  | { kind: 'operator' };

/**
 * Access decorators append to a list instead of overwriting, so the route audit can reject a
 * route (or controller) that carries more than one. A handler's entry overrides its controller's.
 */
function accessDecorator(access: RouteAccess): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const holder = (descriptor?.value ?? target) as object;
    const existing = (Reflect.getMetadata(ROUTE_ACCESS, holder) as RouteAccess[] | undefined) ?? [];
    Reflect.defineMetadata(ROUTE_ACCESS, [...existing, access], holder);
  };
}

/** Staff route: the global permission guard asks the policy service for `permission`. */
export const RequirePermission = (permission: PermissionKey) => accessDecorator({ kind: 'permission', permission });

/** No session needed (sign-in, branding, health). */
export const Public = () => accessDecorator({ kind: 'public' });

/**
 * Any signed-in staff user, no permission key: only for the caller's own account (sign-out,
 * `/me`). Never for tenant data, which always needs `@RequirePermission`.
 */
export const StaffApi = () => accessDecorator({ kind: 'staff' });

/** Customer API (`/customer/*`): authorized by ownership of the caller's own conversation. */
export const CustomerApi = () => accessDecorator({ kind: 'customer' });

/** Platform console API (`/platform/*`), console host and operator session only. */
export const OperatorApi = () => accessDecorator({ kind: 'operator' });

/** The access entries for a route: the handler's own, else its controller's. */
export function routeAccessOf(handler: object, controller: object): RouteAccess[] {
  const own = Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess[] | undefined;
  return own ?? (Reflect.getMetadata(ROUTE_ACCESS, controller) as RouteAccess[] | undefined) ?? [];
}
