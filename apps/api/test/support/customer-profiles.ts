import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';

import { service } from './app.js';
import { createUser, type TestTenant, type TestUser } from './factories.js';

/**
 * `customer_profiles` rows (data-model.md "customer_profiles"), inserted by the real sign-up flow
 * (`identity/customer-auth.service.ts`) but not by the generic `createUser` factory. Anything that
 * reads a customer through `customers.repository.ts` (`GET`/`PATCH /customers/{id}`, an inner join
 * on `customer_profiles`) needs one, else the customer is invisible (`CustomerRow` undefined).
 */

class CustomerProfileRepository extends TenantRepository {
  insertProfile(
    tx: TenantTransaction,
    userId: string,
    values: { phone?: string; company?: string; lastMessageAt?: Date },
  ): Promise<void> {
    return this.insertInto(tx, 'customer_profiles', {
      user_id: userId,
      ...(values.phone === undefined ? {} : { phone: values.phone }),
      ...(values.company === undefined ? {} : { company: values.company }),
      ...(values.lastMessageAt === undefined ? {} : { last_message_at: values.lastMessageAt }),
    }).execute();
  }
}

/**
 * A customer user with its `customer_profiles` row, so `GET`/`PATCH /customers/{id}` can find it
 * (`createUser` alone leaves a customer without one, since real sign-up is what inserts it).
 */
export async function createCustomer(
  tenant: TestTenant,
  options: Parameters<typeof createUser>[1] & { phone?: string; company?: string; lastMessageAt?: Date } = {},
): Promise<TestUser> {
  const { phone, company, lastMessageAt, ...userOptions } = options;
  const user = await createUser(tenant, { ...userOptions, kind: 'customer', roles: userOptions.roles ?? ['customer'] });
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-customer-profile' });
  await (await service(UnitOfWork)).withTenant(ctx, (tx) => new CustomerProfileRepository(ctx).insertProfile(tx, user.id, { phone, company, lastMessageAt }));
  return user;
}
