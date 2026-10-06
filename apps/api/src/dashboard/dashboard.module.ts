import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/** `GET /dashboard` (api process only). The policy, unit of work and clock come from global modules. */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardHttpModule {}
