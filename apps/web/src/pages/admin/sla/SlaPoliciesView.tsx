import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useMemo, useRef, useState } from 'react';

import { OrderedList } from '../../../components/builders/OrderedList';
import {
  summarizeSlaConditions,
  summarizeTargets,
  type CalendarOption,
  type SlaPolicyBody,
  type SlaPolicyRecord,
} from '../../../components/builders/sla-policy-model';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import { SlaPolicyEditorDrawer } from './SlaPolicyEditorDrawer';

/**
 * The SLA policies screen, without data access (US12, FR-084): the policies in evaluation order
 * with a summary of what each covers and its targets, Move up / Move down, Edit and Delete, and
 * the add / edit drawer. `SlaPoliciesPage` feeds it from the data hooks; tests target this view.
 */

export interface SlaPoliciesViewProps {
  status: 'pending' | 'error' | 'ready';
  /** Mapped, user-facing message for `status: 'error'`. */
  errorMessage?: string;
  onRetry: () => void;
  /** In evaluation order. */
  policies: readonly SlaPolicyRecord[];
  calendars: readonly CalendarOption[];
  groups: readonly { id: string; name: string; disabled?: boolean }[];
  lookupsLoading: boolean;
  /** The group or calendar list failed to load; names may be missing. */
  lookupsFailed: boolean;
  onRetryLookups: () => void;
  canCreate: boolean;
  /** Edit and reorder. */
  canEdit: boolean;
  canDelete: boolean;
  /** Creates, or replaces when `id` is given. Rejects with the API error. */
  onSave: (body: SlaPolicyBody, id?: string) => Promise<void>;
  /** The full new order of policies. */
  onReorder: (ordered: SlaPolicyRecord[]) => Promise<void>;
  onDelete: (policy: SlaPolicyRecord) => Promise<void>;
}

export function SlaPoliciesView({
  status,
  errorMessage,
  onRetry,
  policies,
  calendars,
  groups,
  lookupsLoading,
  lookupsFailed,
  onRetryLookups,
  canCreate,
  canEdit,
  canDelete,
  onSave,
  onReorder,
  onDelete,
}: SlaPoliciesViewProps) {
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SlaPolicyRecord | undefined>();
  const [deleting, setDeleting] = useState<SlaPolicyRecord | null>(null);
  // The order after a move, shown at once until the list itself changes (or the save fails).
  const [moved, setMoved] = useState<{ base: readonly SlaPolicyRecord[]; ids: string[] } | null>(null);

  const ordered = useMemo(() => {
    if (moved === null || moved.base !== policies) return policies;
    const byId = new Map(policies.map((policy) => [policy.id, policy]));
    return moved.ids.map((id) => byId.get(id)).filter((policy): policy is SlaPolicyRecord => policy !== undefined);
  }, [policies, moved]);

  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const calendarNames = useMemo(() => new Map(calendars.map((calendar) => [calendar.id, calendar.name])), [calendars]);

  const openEditor = (policy?: SlaPolicyRecord) => {
    setEditing(policy);
    setEditorOpen(true);
  };

  const move = (from: number, to: number) => {
    const next = [...ordered];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    setMoved({ base: policies, ids: next.map((policy) => policy.id) });
    onReorder(next).catch((caught: unknown) => {
      setMoved(null);
      toast({ message: `The new order was not saved. ${mapError(caught).message}`, severity: 'error' });
    });
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
            SLA policies
          </Typography>
          {canCreate && status === 'ready' && (
            <Button variant="contained" onClick={() => openEditor()}>
              Add policy
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          A policy sets how fast tickets must get a first reply, a next reply and a resolution, counted in the hours of a business-hours
          calendar. A ticket follows the first policy from the top of the list whose conditions match its priority and group.
        </Typography>

        {status === 'pending' && <Skeleton variant="list" rows={4} label="SLA policies" />}

        {status === 'error' && <EmptyState variant="error" title="Couldn't load SLA policies" message={errorMessage} onRetry={onRetry} />}

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
                Couldn&apos;t load the groups or calendars, so some names below may be missing.
              </Alert>
            )}

            {policies.length === 0 ? (
              <EmptyState
                title="No SLA policies yet"
                message="Without a policy, tickets have no response or resolution deadlines. Add one to start tracking."
                action={canCreate ? { label: 'Add policy', onClick: () => openEditor() } : undefined}
              />
            ) : (
              <OrderedList<SlaPolicyRecord>
                label="SLA policies, in evaluation order"
                noun="policy"
                items={ordered}
                getKey={(policy) => policy.id}
                getLabel={(policy) => policy.name}
                disabled={!canEdit}
                onMove={move}
                renderItem={(policy) => (
                  <PolicyRow
                    policy={policy}
                    conditions={summarizeSlaConditions(policy.conditions, groupNames)}
                    calendar={lookupsLoading || lookupsFailed ? undefined : (calendarNames.get(policy.businessHoursId) ?? null)}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    onEdit={() => openEditor(policy)}
                    onDelete={() => setDeleting(policy)}
                  />
                )}
              />
            )}
          </>
        )}

        <SlaPolicyEditorDrawer
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          policy={editing}
          calendars={calendars}
          groups={groups}
          lookupsLoading={lookupsLoading}
          onSave={onSave}
        />

        {deleting !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${deleting.name}`}
            message="The policy is removed for good. Open tickets that followed it are matched against the remaining policies and may lose their deadlines."
            confirmLabel="Delete policy"
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

function PolicyRow({
  policy,
  conditions,
  calendar,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: SlaPolicyRecord;
  conditions: string;
  /** The calendar's name; `null` = deleted, `undefined` = not known yet. */
  calendar: string | null | undefined;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <Box sx={{ flex: 1, minWidth: 220 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {policy.name}
          </Typography>
          {calendar === null && <Chip size="small" label="Calendar deleted" sx={{ bgcolor: 'warning.light', color: 'warning.main' }} />}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {conditions}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {summarizeTargets(policy)}
          {typeof calendar === 'string' ? `, ${calendar} hours` : ''}
        </Typography>
      </Box>
      {canEdit && (
        <Button size="small" onClick={onEdit} aria-label={`Edit ${policy.name}`}>
          Edit
        </Button>
      )}
      {canDelete && (
        <Button size="small" color="error" onClick={onDelete} aria-label={`Delete ${policy.name}`}>
          Delete
        </Button>
      )}
    </Box>
  );
}
