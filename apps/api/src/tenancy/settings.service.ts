import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { validationFailed } from '../platform-kernel/http/app-error.js';

import { AA_NORMAL_TEXT_CONTRAST, meetsAAContrast, nearestAACompliantShade } from './contrast.js';
import { isShortening, type AuditRetention, type RetentionPeriod } from './retention/retention-period.js';
import { retentionConfirmationRequired, RetentionService } from './retention/retention.service.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Tenant settings (T183, contracts/operations.yaml `/settings`, FR-005, `tenant_settings.view` /
 * `tenant_settings.edit`). Retention (`retentionPeriod`, `auditRetention`, T193, FR-005a) is part of
 * the DTO; `businessHoursId` and `notificationDefaults` (its own route,
 * `/notification-preferences`) are not yet — they arrive with US12.
 *
 * Shortening `retentionPeriod` deletes closed tickets on the next daily purge, so it needs
 * `confirmPurgeCount` (a request-only field) equal to the number of tickets that would go; a
 * missing or stale count answers 409 `RETENTION_CONFIRMATION_REQUIRED` with the current count and
 * changes nothing.
 */

export interface BrandColorsDto {
  primary?: string;
  accent?: string;
}

export interface TenantSettingsDto {
  name: string;
  logoAttachmentId: string | null;
  brandColors: BrandColorsDto;
  welcomeMessage: string | null;
  timezone: string;
  selfRegistration: boolean;
  gracePeriodHours: number;
  afterCloseBehavior: 'new_follow_up' | 'reopen_previous';
  offlineCustomerNotification: 'email' | 'off';
  outOfHoursMessage: string | null;
  retentionPeriod: RetentionPeriod;
  auditRetention: AuditRetention;
}

export interface TenantSettingsUpdate {
  name?: string;
  logoAttachmentId?: string | null;
  brandColors?: BrandColorsDto;
  welcomeMessage?: string | null;
  timezone?: string;
  selfRegistration?: boolean;
  gracePeriodHours?: number;
  afterCloseBehavior?: 'new_follow_up' | 'reopen_previous';
  offlineCustomerNotification?: 'email' | 'off';
  outOfHoursMessage?: string | null;
  retentionPeriod?: RetentionPeriod;
  auditRetention?: AuditRetention;
  /** Not stored: the confirmation for a shortened `retentionPeriod`. */
  confirmPurgeCount?: number;
}

interface SettingsRow {
  logo_attachment_id: string | null;
  brand_colors: JsonValue;
  welcome_message: string | null;
  timezone: string;
  self_registration: boolean;
  grace_period_hours: number;
  after_close_behavior: 'new_follow_up' | 'reopen_previous';
  offline_customer_notification: 'email' | 'off';
  out_of_hours_message: string | null;
  retention_period: string;
  audit_retention: string;
}

@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
  ) {}

  get(ctx: TenantContext): Promise<TenantSettingsDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.load(tx, ctx));
  }

  async update(ctx: TenantContext, input: TenantSettingsUpdate): Promise<TenantSettingsDto> {
    if (input.brandColors?.primary !== undefined) {
      this.assertPrimaryContrast(input.brandColors.primary);
    }

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SettingsRepository(ctx);
      const before = await this.load(tx, ctx);
      await this.assertPurgeConfirmed(tx, before, input);

      const values: Partial<SettingsRow> = {};
      if (input.logoAttachmentId !== undefined) values.logo_attachment_id = input.logoAttachmentId;
      if (input.brandColors !== undefined) values.brand_colors = JSON.stringify({ ...before.brandColors, ...input.brandColors });
      if (input.welcomeMessage !== undefined) values.welcome_message = input.welcomeMessage;
      if (input.timezone !== undefined) values.timezone = input.timezone;
      if (input.selfRegistration !== undefined) values.self_registration = input.selfRegistration;
      if (input.gracePeriodHours !== undefined) values.grace_period_hours = input.gracePeriodHours;
      if (input.afterCloseBehavior !== undefined) values.after_close_behavior = input.afterCloseBehavior;
      if (input.offlineCustomerNotification !== undefined) values.offline_customer_notification = input.offlineCustomerNotification;
      if (input.outOfHoursMessage !== undefined) values.out_of_hours_message = input.outOfHoursMessage;
      if (input.retentionPeriod !== undefined) values.retention_period = input.retentionPeriod;
      if (input.auditRetention !== undefined) values.audit_retention = input.auditRetention;
      if (Object.keys(values).length > 0) await repo.update(tx, values);

      if (input.name !== undefined) await repo.renameTenant(tx, ctx.tenantId, input.name);

      const after = await this.load(tx, ctx);
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(tx, {
          action: 'tenant_settings.changed',
          resourceType: 'tenant_settings',
          resourceId: ctx.tenantId,
          details: changes,
        });
      }
      return after;
    });
  }

  /** FR-005a: a shorter retention period is applied to already-closed tickets, so the admin confirms the count first. */
  private async assertPurgeConfirmed(tx: TenantTransaction, before: TenantSettingsDto, input: TenantSettingsUpdate): Promise<void> {
    if (input.retentionPeriod === undefined || !isShortening(before.retentionPeriod, input.retentionPeriod)) return;
    const purgeCount = await this.retention.countPurgeable(tx, input.retentionPeriod);
    if (purgeCount > 0 && input.confirmPurgeCount !== purgeCount) throw retentionConfirmationRequired(purgeCount);
  }

  /** FR-071a: the primary brand color fills the customer chat bubble/button, read as white text. */
  private assertPrimaryContrast(primary: string): void {
    if (meetsAAContrast(primary)) return;
    throw validationFailed([
      {
        path: 'brandColors.primary',
        issue: 'insufficient_contrast',
        suggestion: nearestAACompliantShade(primary, undefined, AA_NORMAL_TEXT_CONTRAST),
      },
    ]);
  }

  private async load(tx: TenantTransaction, ctx: TenantContext): Promise<TenantSettingsDto> {
    const repo = new SettingsRepository(ctx);
    const row = await repo.get(tx);
    return {
      name: row.name,
      logoAttachmentId: row.logo_attachment_id,
      brandColors: brandColorsOf(row.brand_colors),
      welcomeMessage: row.welcome_message,
      timezone: row.timezone,
      selfRegistration: row.self_registration,
      gracePeriodHours: row.grace_period_hours,
      afterCloseBehavior: row.after_close_behavior,
      offlineCustomerNotification: row.offline_customer_notification,
      outOfHoursMessage: row.out_of_hours_message,
      // The table's CHECK constraints allow only these values.
      retentionPeriod: row.retention_period as RetentionPeriod,
      auditRetention: row.audit_retention as AuditRetention,
    };
  }
}

/** Only known string keys reach the client; `brand_colors` is free-form json in the database. */
function brandColorsOf(value: JsonValue): BrandColorsDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const { primary, accent } = value as { primary?: unknown; accent?: unknown };
  return {
    ...(typeof primary === 'string' ? { primary } : {}),
    ...(typeof accent === 'string' ? { accent } : {}),
  };
}

/** One audit entry's `details`: every changed field, old and new value. */
function diff(before: TenantSettingsDto, after: TenantSettingsDto): Record<string, JsonValue> {
  const changes: Record<string, JsonValue> = {};
  for (const key of Object.keys(after) as (keyof TenantSettingsDto)[]) {
    const oldValue = before[key] as JsonValue;
    const newValue = after[key] as JsonValue;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = { old: oldValue, new: newValue };
    }
  }
  return changes;
}

class SettingsRepository extends TenantRepository {
  async get(tx: TenantTransaction): Promise<SettingsRow & { name: string }> {
    const row = await this.selectFrom(tx, 'tenant_settings')
      .innerJoin('tenants', 'tenants.id', 'tenant_settings.tenant_id')
      .select([
        'tenants.name',
        'tenant_settings.logo_attachment_id',
        'tenant_settings.brand_colors',
        'tenant_settings.welcome_message',
        'tenant_settings.timezone',
        'tenant_settings.self_registration',
        'tenant_settings.grace_period_hours',
        'tenant_settings.after_close_behavior',
        'tenant_settings.offline_customer_notification',
        'tenant_settings.out_of_hours_message',
        'tenant_settings.retention_period',
        'tenant_settings.audit_retention',
      ])
      .executeTakeFirstOrThrow();
    return row;
  }

  async update(tx: TenantTransaction, values: Partial<SettingsRow>): Promise<void> {
    await this.updateTable(tx, 'tenant_settings').set(values).execute();
  }

  /** `tenants` is global (no `tenant_id`): the `tenants_guard_name` trigger is what stops a
   * cross-tenant rename, not this repository's usual tenant filter. */
  async renameTenant(tx: TenantTransaction, tenantId: string, name: string): Promise<void> {
    await tx.updateTable('tenants').set({ name }).where('id', '=', tenantId).execute();
  }
}
