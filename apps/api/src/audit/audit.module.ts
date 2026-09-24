import { Global, Module } from '@nestjs/common';

import { AuditConsumer } from './audit.consumer.js';
import { AuditService } from './audit.service.js';

/** Global: any module records audit entries in its own transactions. */
@Global()
@Module({ providers: [AuditService, AuditConsumer], exports: [AuditService] })
export class AuditModule {}
