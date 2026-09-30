import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useMemo, useRef, useState } from 'react';

import { OrderedList } from '../../../components/builders/OrderedList';
import {
  ROUTING_RULE_LIMIT,
  summarizeActions,
  summarizeConditions,
  toNameMap,
  type RuleLookups,
} from '../../../components/builders/rule-model';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import { RoutingTestPanel } from './RoutingTestPanel';
import { RuleEditorDrawer } from './RuleEditorDrawer';

import type { RoutingDryRun, RoutingRule, RoutingRuleInput, TestRoutingRulesBody } from '../../../api/generated/model';

/**
 * The routing rules screen, without data access (FR-059, FR-060): the rules in evaluation order
 * with their summaries, an enable switch, Move up / Move down, Edit and Delete, the add / edit
 * drawer and the "Try a message" panel. `RoutingRulesPage` feeds it from the data hooks; tests
 * target this view.
 */

export interface RoutingGroupOption {
  id: string;
  name: string;
  active: boolean;
}

export interface RoutingRulesViewProps {
  status: 'pending' | 'error' | 'ready';
  /** Mapped, user-facing message for `status: 'error'`. */
  errorMessage?: string;
  onRetry: () => void;
  /** In evaluation order. */
  rules: readonly RoutingRule[];
  groups: readonly RoutingGroupOption[];
  tags: readonly { id: string; name: string }[];
  lookupsLoading: boolean;
  /** The group or tag list failed to load; names may be missing. */
  lookupsFailed: boolean;
  onRetryLookups: () => void;
  canCreate: boolean;
  /** Edit, enable / disable and reorder. */
  canEdit: boolean;
  canDelete: boolean;
  /** Creates, or replaces when `id` is given. Rejects with the API error. */
  onSave: (input: RoutingRuleInput, id?: string) => Promise<void>;
  onToggle: (rule: RoutingRule, enabled: boolean) => Promise<void>;
  /** The full new order of rule ids. */
  onReorder: (ids: string[]) => Promise<void>;
  onDelete: (rule: RoutingRule) => Promise<void>;
  onTest: (body: TestRoutingRulesBody) => Promise<RoutingDryRun>;
}

export function RoutingRulesView({
  status,
  errorMessage,
  onRetry,
  rules,
  groups,
  tags,
  lookupsLoading,
  lookupsFailed,
  onRetryLookups,
  canCreate,
  canEdit,
  canDelete,
  onSave,
  onToggle,
  onReorder,
  onDelete,
  onTest,
}: RoutingRulesViewProps) {
  const toast = useToast();
  const announce = useAnnounce();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<RoutingRule | undefined>();
  const [deleting, setDeleting] = useState<RoutingRule | null>(null);
  // The order after a move, shown at once until the list itself changes (or the save fails).
  const [moved, setMoved] = useState<{ base: readonly RoutingRule[]; ids: string[] } | null>(null);

  const ordered = useMemo(() => {
    if (moved === null || moved.base !== rules) return rules;
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return moved.ids.map((id) => byId.get(id)).filter((rule): rule is RoutingRule => rule !== undefined);
  }, [rules, moved]);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const groupNames = useMemo(() => toNameMap(groups), [groups]);
  const tagNames = useMemo(() => toNameMap(tags), [tags]);
  const lookups: RuleLookups = useMemo(
    () => ({
      tags,
      groups: groups.map((group) => ({ id: group.id, name: group.active ? group.name : `${group.name} (inactive)`, disabled: !group.active })),
    }),
    [groups, tags],
  );

  const openEditor = (rule?: RoutingRule) => {
    setEditing(rule);
    setEditorOpen(true);
  };

  const move = (from: number, to: number) => {
    const ids = ordered.map((rule) => rule.id);
    const [id] = ids.splice(from, 1);
    if (id === undefined) return;
    ids.splice(to, 0, id);
    setMoved({ base: rules, ids });
    onReorder(ids).catch((caught: unknown) => {
      setMoved(null);
      const message = `The new order was not saved. ${mapError(caught).message}`;
      toast({ message, severity: 'error' });
    });
  };

  const toggle = (rule: RoutingRule, enabled: boolean) => {
    onToggle(rule, enabled).then(
      () => announce(`${rule.name} ${enabled ? 'enabled' : 'disabled'}.`),
      (caught: unknown) => {
        const mapped = mapError(caught);
        const groupIssue = mapped.code === 'VALIDATION_FAILED' ? mapped.fieldErrors?.['actions.groupId'] : undefined;
        toast({
          message: groupIssue === undefined ? `${rule.name} was not changed. ${mapped.message}` : `${rule.name} was not enabled. Its group is not active: edit the rule to choose an active group.`,
          severity: 'error',
        });
      },
    );
  };

  const header = (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
        <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
          Routing rules
        </Typography>
        {canCreate && status === 'ready' && (
          <Button variant="contained" onClick={() => openEditor()} disabled={rules.length >= ROUTING_RULE_LIMIT}>
            Add rule
          </Button>
        )}
      </Box>
      <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
        When a customer&apos;s first message starts a ticket, the rules run from top to bottom. The first enabled rule that matches
        and whose group is active decides the group, and optionally the priority and tags. Tickets no rule catches go to Needs Triage.
      </Typography>
    </>
  );

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        {header}

        {status === 'pending' && <Skeleton variant="list" rows={4} label="routing rules" />}

        {status === 'error' && <EmptyState variant="error" title="Couldn't load routing rules" message={errorMessage} onRetry={onRetry} />}

        {status === 'ready' && (
          <>
            {lookupsFailed && (
              <Alert
                severity="warning"
                sx={{ mb: 4 }}
                action={
                  <Button color="inherit" size="small" onClick={onRetryLookups}>
                    Retry
                  </Button>
                }
              >
                Couldn&apos;t load the groups or tags, so some names below may be missing.
              </Alert>
            )}

            {rules.length === 0 ? (
              <EmptyState
                title="No routing rules yet"
                message="Without rules, every new ticket goes to Needs Triage for someone to sort by hand. Add a rule to send matching tickets straight to a group."
                action={canCreate ? { label: 'Add rule', onClick: () => openEditor() } : undefined}
              />
            ) : (
              <OrderedList<RoutingRule>
                label="Routing rules, in evaluation order"
                noun="rule"
                items={ordered}
                getKey={(rule) => rule.id}
                getLabel={(rule) => rule.name}
                disabled={!canEdit}
                onMove={move}
                renderItem={(rule) => (
                  <RuleRow
                    rule={rule}
                    group={groupById.get(rule.actions.groupId)}
                    lookupsReady={!lookupsLoading && !lookupsFailed}
                    groupNames={groupNames}
                    tagNames={tagNames}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    onToggle={(enabled) => toggle(rule, enabled)}
                    onEdit={() => openEditor(rule)}
                    onDelete={() => setDeleting(rule)}
                  />
                )}
              />
            )}

            <RoutingTestPanel ruleIds={ordered.map((rule) => rule.id)} groupNames={groupNames} tags={tags} tagsLoading={lookupsLoading} onTest={onTest} />
          </>
        )}

        <RuleEditorDrawer
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          rule={editing}
          lookups={lookups}
          lookupsLoading={lookupsLoading}
          onSave={onSave}
        />

        {deleting !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${deleting.name}`}
            message="The rule is removed for good and the rules after it move up one place. Tickets already routed are not changed."
            confirmLabel="Delete rule"
            destructive
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              await onDelete(deleting);
              toast({ message: `${deleting.name} deleted`, severity: 'success' });
              // The Delete button is gone: keep the keyboard user in the page.
              window.setTimeout(() => headingRef.current?.focus(), 0);
            }}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}

function RuleRow({
  rule,
  group,
  lookupsReady,
  groupNames,
  tagNames,
  canEdit,
  canDelete,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: RoutingRule;
  group: RoutingGroupOption | undefined;
  lookupsReady: boolean;
  groupNames: ReadonlyMap<string, string>;
  tagNames: ReadonlyMap<string, string>;
  canEdit: boolean;
  canDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Only judge the group once the lists are in: a missing entry while loading is not a deleted group.
  const groupProblem = !lookupsReady ? null : group === undefined ? 'Group deleted - skipped' : group.active ? null : 'Group inactive - skipped';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <Switch
        size="small"
        checked={rule.enabled}
        disabled={!canEdit}
        onChange={(event) => onToggle(event.target.checked)}
        slotProps={{ input: { 'aria-label': `Enable ${rule.name}` } }}
      />
      <Box sx={{ flex: 1, minWidth: 220 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} color={rule.enabled ? 'text.primary' : 'text.secondary'}>
            {rule.name}
          </Typography>
          {!rule.enabled && <Chip size="small" label="Disabled" />}
          {groupProblem !== null && <Chip size="small" label={groupProblem} sx={{ bgcolor: 'warning.light', color: 'warning.main' }} />}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {summarizeConditions(rule.conditions, tagNames)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {summarizeActions(rule.actions, groupNames, tagNames)}
        </Typography>
      </Box>
      {canEdit && (
        <Button size="small" onClick={onEdit} aria-label={`Edit ${rule.name}`}>
          Edit
        </Button>
      )}
      {canDelete && (
        <Button size="small" color="error" onClick={onDelete} aria-label={`Delete ${rule.name}`}>
          Delete
        </Button>
      )}
    </Box>
  );
}
