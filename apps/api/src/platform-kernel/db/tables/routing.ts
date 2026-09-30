import type { ColumnType, Generated, GeneratedTimestamp } from './column-types.js';
import type { TicketPriority } from './tickets.js';

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

export interface RoutingTables {
  routing_rules: RoutingRulesTable;
}
