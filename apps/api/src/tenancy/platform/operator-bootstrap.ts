import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { PasswordService } from '../../identity/password.service.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';

import type { Kysely } from 'kysely';

/**
 * Creates the first platform operator from `OPERATOR_BOOTSTRAP_EMAIL` / `OPERATOR_BOOTSTRAP_PASSWORD`
 * when `platform_operators` is empty (FR-001): a fresh deployment has no console account, and
 * there is no other way in.
 *
 * It runs only on an empty table, so the variables can stay in the environment without the
 * password being reapplied later; changing an existing operator's password is a console action.
 */
@Injectable()
export class OperatorBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('OperatorBootstrap');

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    private readonly passwords: PasswordService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = process.env.OPERATOR_BOOTSTRAP_EMAIL?.trim().toLowerCase();
    const password = process.env.OPERATOR_BOOTSTRAP_PASSWORD;
    if (email === undefined || email === '' || password === undefined || password === '') return;

    const existing = await this.db.selectFrom('platform_operators').select('id').limit(1).executeTakeFirst();
    if (existing !== undefined) return;

    const created = await this.db
      .insertInto('platform_operators')
      .values({ email, name: 'Platform operator', password_hash: await this.passwords.hash(password) })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (created !== undefined) this.logger.log(`Bootstrapped the first platform operator (${email})`);
  }
}
