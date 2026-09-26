import { Module } from '@nestjs/common';

import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/** HTTP side of customer profiles (api process only, contracts/tickets.yaml `/customers/{id}`). */
@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersHttpModule {}
