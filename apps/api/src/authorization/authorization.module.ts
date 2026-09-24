import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { PolicyService } from './policy.service.js';
import { INITIAL_PERMISSIONS } from './registry/initial-permissions.js';
import { permissionsProvider } from './registry/module-permissions.js';
import { PermissionRegistry, REGISTRY_OPTIONS, type RegistryOptions } from './registry/registry.service.js';
import { RouteAudit } from './registry/route-audit.js';

/**
 * Authorization (research D6): the permission registry, the start-up route audit and the policy
 * service; the permission guard is registered by the API pipeline. Global because every module's
 * guards and services ask it.
 */
@Global()
@Module({})
export class AuthorizationModule {
  static forRoot(options: RegistryOptions): DynamicModule {
    return {
      module: AuthorizationModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: REGISTRY_OPTIONS, useValue: options },
        ...INITIAL_PERMISSIONS.map(permissionsProvider),
        PermissionRegistry,
        PolicyService,
        RouteAudit,
      ],
      exports: [PermissionRegistry, PolicyService],
    };
  }
}
