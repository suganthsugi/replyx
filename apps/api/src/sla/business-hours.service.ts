import { Injectable } from '@nestjs/common';
import { ZodError } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, validationFailed } from '../platform-kernel/http/app-error.js';

import { BusinessCalendarError } from './business-calendar.js';
import { normalizeHolidays, normalizeIntervals, type BusinessHoursInput } from './business-hours-input.js';
import { businessHoursRowToCalendar } from './business-hours.mapper.js';
import { SlaAdminRepository, type BusinessHoursRecord, type BusinessHoursValues } from './sla-admin.repository.js';
import { SlaReapplyService } from './sla-reapply.service.js';

import type { BusinessHoursIntervals } from '../platform-kernel/db/tables/sla.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Business-hours calendars admin (US12, FR-084, contracts/operations.yaml `/business-hours*`,
 * permissions `sla_policy.view/create/edit/delete`).
 *
 * - Names are unique per tenant, case-insensitively (409 `BUSINESS_HOURS_NAME_TAKEN`).
 * - Deleting a calendar that an SLA policy or the tenant settings still use is 409 `IN_USE`.
 * - After an edit, open tickets' SLA times are recomputed (`SlaReapplyService`, after commit).
 * - Writes of one tenant's SLA configuration serialize on an advisory lock (`lockConfig`).
 */

export interface BusinessHoursDto {
  id: string;
  name: string;
  timezone: string;
  intervals: BusinessHoursIntervals;
  holidays: string[];
}

function toDto(record: BusinessHoursRecord): BusinessHoursDto {
  return { id: record.id, name: record.name, timezone: record.timezone, intervals: record.intervals, holidays: record.holidays };
}

function valuesOf(input: BusinessHoursInput): BusinessHoursValues {
  const values = {
    name: input.name,
    timezone: input.timezone,
    intervals: normalizeIntervals(input.intervals),
    holidays: normalizeHolidays(input.holidays),
  };
  // The same check the SLA computation applies, so a saved calendar can always run a timer.
  try {
    businessHoursRowToCalendar(values);
  } catch (error) {
    if (!(error instanceof BusinessCalendarError) && !(error instanceof ZodError)) throw error;
    throw validationFailed([{ path: 'intervals', issue: 'invalid' }]);
  }
  return values;
}

@Injectable()
export class BusinessHoursService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly reapply: SlaReapplyService,
  ) {}

  list(ctx: TenantContext): Promise<BusinessHoursDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => (await new SlaAdminRepository(ctx).listBusinessHours(tx)).map(toDto));
  }

  async create(ctx: TenantContext, input: BusinessHoursInput): Promise<BusinessHoursDto> {
    const values = valuesOf(input);
    // A new calendar is used by no policy yet: nothing to recompute.
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      await this.assertNameFree(repo, tx, values.name);
      const id = await repo.insertBusinessHours(tx, values);
      await this.audit.record(tx, {
        action: 'business_hours.created',
        resourceType: 'business_hours',
        resourceId: id,
        details: { name: values.name, timezone: values.timezone },
      });
      return toDto(await this.reload(repo, tx, id));
    });
  }

  /** Full replace; SLA times of open tickets are recomputed afterwards. */
  async update(ctx: TenantContext, id: string, input: BusinessHoursInput): Promise<BusinessHoursDto> {
    const values = valuesOf(input);
    const updated = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      if ((await repo.businessHoursById(tx, id)) === undefined) throw notFound('business_hours');
      await this.assertNameFree(repo, tx, values.name, id);
      await repo.updateBusinessHours(tx, id, values);
      await this.audit.record(tx, {
        action: 'business_hours.updated',
        resourceType: 'business_hours',
        resourceId: id,
        details: { name: values.name, timezone: values.timezone },
      });
      return toDto(await this.reload(repo, tx, id));
    });
    await this.reapply.reapplyToOpenTickets(ctx);
    return updated;
  }

  /** 409 `IN_USE` while a policy or the tenant settings use the calendar. */
  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      const row = await repo.businessHoursById(tx, id);
      if (row === undefined) throw notFound('business_hours');
      if (await repo.businessHoursInUse(tx, id)) {
        throw conflict('IN_USE', 'This business-hours calendar is used by an SLA policy or the workspace settings');
      }
      await repo.deleteBusinessHours(tx, id);
      await this.audit.record(tx, {
        action: 'business_hours.deleted',
        resourceType: 'business_hours',
        resourceId: id,
        details: { name: row.name },
      });
    });
  }

  private async assertNameFree(repo: SlaAdminRepository, tx: TenantTransaction, name: string, exceptId?: string): Promise<void> {
    if (await repo.businessHoursNameTaken(tx, name, exceptId)) {
      throw conflict('BUSINESS_HOURS_NAME_TAKEN', 'A calendar with this name already exists');
    }
  }

  private async reload(repo: SlaAdminRepository, tx: TenantTransaction, id: string): Promise<BusinessHoursRecord> {
    const row = await repo.businessHoursById(tx, id);
    if (row === undefined) throw new Error('Business hours vanished inside their own transaction');
    return row;
  }
}
