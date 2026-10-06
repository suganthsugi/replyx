import { Controller, Get, Req } from '@nestjs/common';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';

import { DashboardService, type DashboardDto } from './dashboard.service.js';

import type { Request } from 'express';

/** `GET /dashboard` (contracts/operations.yaml, FR-086). Needs `dashboard.view`; figures are limited to the caller's accessible tickets. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermission('dashboard.view')
  get(@Req() req: Request): Promise<DashboardDto> {
    return this.dashboard.get(tenantContextOf(req));
  }
}
