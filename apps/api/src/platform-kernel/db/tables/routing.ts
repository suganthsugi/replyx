import type { Generated, GeneratedTimestamp } from './column-types.js';
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
  conditions: Generated<RoutingConditions>;
  actions: RoutingActions;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RoutingTables {
  routing_rules: RoutingRulesTable;
}
