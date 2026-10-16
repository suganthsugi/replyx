import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useMemo, useRef, useState } from 'react';

import {
  AUTOMATION_RULE_LIMIT,
  summarizeAutomationActions,
  summarizeAutomationConditions,
  summarizeTrigger,
} from '../../../components/builders/automation-rule-model';
import { toNameMap, type RuleLookups } from '../../../components/builders/rule-model';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import { AutomationRuleEditorDrawer } from './AutomationRuleEditorDrawer';

import type { AutomationRule, AutomationRuleInput } from '../../../api/generated/model';
import type { FilterLookups } from '../../../components/builders/FilterBuilder';

/**
 * The automation rules screen without data access (US17, FR-088, FR-089): each rule with its
 * trigger, conditions and actions in plain words, an enable switch, Edit and Delete, and the add /
 * edit drawer. `AutomationRulesPage` feeds it from the data hooks; tests target this view too.
 */

export interface NamedOption {
  id: string;
  name: string;
}

export interface AutomationRulesViewProps {
  status: 'pending' | 'error' | 'ready';
  /** Mapped, user-facing message for `status: 'error'`. */
  errorMessage?: string;
  onRetry: () => void;
  rules: readonly AutomationRule[];
  groups: readonly (NamedOption & { active: boolean })[];
  /** Staff who can own tickets or be notified. */
  people: readonly NamedOption[];
  tags: readonly NamedOption[];
  lookupsLoading: boolean;
  lookupsFailed: boolean;
  onRetryLookups: () => void;
  canCreate: boolean;
  /** Edit and enable / disable. */
  canEdit: boolean;
  canDelete: boolean;
  /** Creates, or replaces when `id` is given. Rejects with the API error. */
  onSave: (input: AutomationRuleInput, id?: string) => Promise<void>;
  onToggle: (rule: AutomationRule, enabled: boolean) => Promise<void>;
  onDelete: (rule: AutomationRule) => Promise<void>;
}

export function AutomationRulesView({
  status,
  errorMessage,
  onRetry,
  rules,
  groups,
  people,
  tags,
  lookupsLoading,
  lookupsFailed,
  onRetryLookups,
  canCreate,
  canEdit,
  canDelete,
  onSave,
  onToggle,
  onDelete,
}: AutomationRulesViewProps) {
  const toast = useToast();
  const announce = useAnnounce();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationRule | undefined>();
  const [deleting, setDeleting] = useState<AutomationRule | null>(null);

  const names = useMemo(() => ({ groups: toNameMap(groups), people: toNameMap(people), tags: toNameMap(tags) }), [groups, people, tags]);
  const lookups: RuleLookups = useMemo(
    () => ({
      tags,
      owners: [{ id: 'unassigned', name: 'Nobody (unassign)' }, ...people],
      groups: groups.map((group) => ({ id: group.id, name: group.active ? group.name : `${group.name} (inactive)`, disabled: !group.active })),
    }),
    [groups, people, tags],
  );
  const filterLookups: FilterLookups = useMemo(
    () => ({ groups, users: people, tags, allowMe: false, status: lookupsLoading ? 'loading' : lookupsFailed ? 'error' : 'ready', onRetry: onRetryLookups }),
    [groups, people, tags, lookupsLoading, lookupsFailed, onRetryLookups],
  );

  const openEditor = (rule?: AutomationRule) => {
    setEditing(rule);
    setEditorOpen(true);
  };

  const toggle = (rule: AutomationRule, enabled: boolean) => {
    onToggle(rule, enabled).then(
      () => announce(`${rule.name} ${enabled ? 'enabled' : 'disabled'}.`),
      (caught: unknown) => {
        const mapped = mapError(caught);
        const invalid = mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined;
        toast({
          message: invalid ? `${rule.name} was not changed. Something it uses no longer exists or is inactive: edit the rule to fix it.` : `${rule.name} was not changed. ${mapped.message}`,
          severity: 'error',
        });
      },
    );
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
            Automation rules
          </Typography>
          {canCreate && status === 'ready' && (
            <Button variant="contained" onClick={() => openEditor()} disabled={rules.length >= AUTOMATION_RULE_LIMIT}>
              Add rule
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Rules act on tickets for you: when a ticket is created or updated, when the customer writes, or after a ticket has waited
          for a while. Every enabled rule whose conditions match runs, and its changes show in the ticket history under the rule&apos;s
          name. Rules can start other rules, up to three in a row.
        </Typography>

        {status === 'pending' && <Skeleton variant="list" rows={4} label="automation rules" />}

        {status === 'error' && <EmptyState variant="error" title="Couldn't load automation rules" message={errorMessage} onRetry={onRetry} />}

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
                Couldn&apos;t load the groups, people or tags, so some names below may be missing.
              </Alert>
            )}

            {rules.length === 0 ? (
              <EmptyState
                title="No automation rules yet"
                message='Add a rule to take care of routine work, for example "when a ticket has waited 2 days for the customer, send a reminder and set it to close".'
                action={canCreate ? { label: 'Add rule', onClick: () => openEditor() } : undefined}
              />
            ) : (
              <List aria-label="Automation rules" disablePadding sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
                {rules.map((rule, index) => (
                  <ListItem key={rule.id} divider={index < rules.length - 1} sx={{ py: 3 }}>
                    <RuleRow
                      rule={rule}
                      summary={summarizeAutomationActions(rule.actions, names)}
                      canEdit={canEdit}
                      canDelete={canDelete}
                      onToggle={(enabled) => toggle(rule, enabled)}
                      onEdit={() => openEditor(rule)}
                      onDelete={() => setDeleting(rule)}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </>
        )}

        <AutomationRuleEditorDrawer
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          rule={editing}
          lookups={lookups}
          filterLookups={filterLookups}
          lookupsLoading={lookupsLoading}
          onSave={onSave}
        />

        {deleting !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${deleting.name}`}
            message="The rule is removed for good. Changes it already made to tickets stay."
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
  summary,
  canEdit,
  canDelete,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: AutomationRule;
  summary: string;
  canEdit: boolean;
  canDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
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
        </Box>
        <Typography variant="body2" color="text.secondary">
          {summarizeTrigger(rule.trigger)} · {summarizeAutomationConditions(rule.conditions)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {summary}
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
