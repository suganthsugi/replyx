import { Global, Module } from '@nestjs/common';

import { AuditLogsService } from './audit-logs.service.js';
import { AuditConsumer } from './audit.consumer.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

/** Global: any module records audit entries in its own transactions. */
@Global()
@Module({ controllers: [AuditController], providers: [AuditService, AuditLogsService, AuditConsumer], exports: [AuditService] })
export class AuditModule {}
