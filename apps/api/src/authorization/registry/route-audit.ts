import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { routeAccessOf, type RouteAccess } from './module-permissions.js';
import { PermissionRegistry } from './registry.service.js';

/**
 * Start-up check (constitution II): every controller route carries exactly one of
 * `@RequirePermission`, `@Public`, `@CustomerApi` or `@OperatorApi` (its own or its
 * controller's), permission keys exist in the registry, customer routes live under `customer/`
 * and operator routes under `platform/`. Any violation stops the api process from starting.
 */

export interface RouteInfo {
  /** `Controller.method`, for the error message. */
  name: string;
  /** Controller path joined with the handler path, without the global prefix. */
  path: string;
  access: readonly RouteAccess[];
}

const AUDIENCE_PREFIX: Readonly<Partial<Record<RouteAccess['kind'], string>>> = {
  customer: 'customer',
  operator: 'platform',
};

function firstSegment(path: string): string {
  return path.split('/').find((segment) => segment !== '') ?? '';
}

/** Problems found, one line each; empty when every route passes. */
export function auditRoutes(routes: readonly RouteInfo[], knownPermission: (key: string) => boolean): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    const label = `${route.name} (${route.path})`;
    if (route.access.length !== 1) {
      problems.push(
        route.access.length === 0
          ? `${label} has no access decorator`
          : `${label} has ${route.access.length} access decorators`,
      );
      continue;
    }
    const access = route.access[0] as RouteAccess;
    if (access.kind === 'permission' && !knownPermission(access.permission)) {
      problems.push(`${label} requires unknown permission ${access.permission}`);
    }
    const segment = firstSegment(route.path);
    for (const [kind, prefix] of Object.entries(AUDIENCE_PREFIX)) {
      if ((access.kind === kind) !== (segment === prefix)) {
        problems.push(`${label}: only ${kind} routes may live under /${prefix}, and they must`);
      }
    }
  }
  return problems;
}

function joinPath(...parts: unknown[]): string {
  const segments = parts.flatMap((part) => (Array.isArray(part) ? (part as unknown[]).slice(0, 1) : [part]));
  return `/${segments
    .filter((segment): segment is string => typeof segment === 'string')
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment !== '')
    .join('/')}`;
}

@Injectable()
export class RouteAudit implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly registry: PermissionRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const problems = auditRoutes(this.routes(), (key) => this.registry.has(key));
    if (problems.length > 0) {
      throw new Error(`Route access audit failed:\n  ${problems.join('\n  ')}`);
    }
  }

  /** Every route handler of every controller in the app. */
  routes(): RouteInfo[] {
    const routes: RouteInfo[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | null | undefined;
      const metatype = wrapper.metatype as (abstract new (...args: never[]) => unknown) | null | undefined;
      if (instance === undefined || instance === null || typeof metatype !== 'function') continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) as unknown;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName] as object;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        routes.push({
          name: `${metatype.name}.${methodName}`,
          path: joinPath(controllerPath, Reflect.getMetadata(PATH_METADATA, handler)),
          access: routeAccessOf(handler, metatype),
        });
      }
    }
    return routes;
  }
}
