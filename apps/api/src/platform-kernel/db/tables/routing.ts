import type { ColumnType, Generated, GeneratedTimestamp, JsonValue } from './column-types.js';
import type { TicketPriority, TicketState } from './tickets.js';

/** Migration 0013_routing_rules (data-model.md "routing_rules"). */

/** Every present part must match (contracts/operations.yaml RoutingRule.conditions). */
export interface RoutingConditions {
  messageContainsAny?: string[];
  messageContainsAll?: string[];
  customerTagIds?: string[];
  emailDomains?: string[];
}

export interface RoutingActions {
  groupId: string;
  priority?: TicketPriority;
  tagIds?: string[];
}

export interface RoutingRulesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  position: Generated<number>;
  enabled: Generated<boolean>;
  /** Read as an object; written as a JSON string (the pg driver does not serialize objects for jsonb). */
  conditions: ColumnType<RoutingConditions, string | undefined, string>;
  actions: ColumnType<RoutingActions, string, string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Migration 0021_automation_rules (data-model.md "automation_rules", FR-088). */
export type AutomationEvent = 'ticket.created' | 'ticket.updated' | 'message.created' | 'time.elapsed';

/** The ticket timestamp a `time.elapsed` rule counts from. */
export type AutomationSince = 'created_at' | 'updated_at' | 'last_customer_message_at' | 'last_agent_reply_at';

export interface AutomationTrigger {
  event: AutomationEvent;
  /** ISO duration, `time.elapsed` only (e.g. `P2D`). */
  after?: string;
  since?: AutomationSince;
}

/** contracts/operations.yaml `AutomationRule.actions`; every field optional, at least one present. */
export interface AutomationActions {
  groupId?: string | null;
  ownerId?: string | null;
  priority?: TicketPriority;
  state?: TicketState;
  /** Required with a pending `state`: the pending date is this many hours after the rule runs. */
  pendingInHours?: number;
  addTagIds?: string[];
  autoReply?: string;
  notifyUserIds?: string[];
}

export interface AutomationRulesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  enabled: Generated<boolean>;
  position: number;
  trigger: ColumnType<AutomationTrigger, string, string>;
  /** A view condition tree (validated by views/view-compiler.ts on write), or null for every ticket. */
  conditions: ColumnType<JsonValue | null, string | null, string | null>;
  actions: ColumnType<AutomationActions, string, string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AutomationRunsTable {
  id: Generated<string>;
  tenant_id: string;
  rule_id: string;
  ticket_id: string;
  trigger_key: string;
  status: 'done' | 'failed';
  error: string | null;
  created_at: GeneratedTimestamp;
}

export interface RoutingTables {
  routing_rules: RoutingRulesTable;
  automation_rules: AutomationRulesTable;
  automation_runs: AutomationRunsTable;
}
