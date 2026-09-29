import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Drawer } from '../../../components/shell/Drawer';
import { useAuditLogs, type AuditLog, type AuditLogFilters } from '../../../data/audit';

/**
 * The audit log (FR-092): an append-only, newest-first list of who did what, with filters and a
 * detail drawer. Filters apply on submit, so typing doesn't fire a request per keystroke; an
 * applied change swaps the query key, which resets the list to its first page. Entry `details`
 * are shown as text only, never as markup.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FilterDraft {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  from: string;
  to: string;
}

const EMPTY_DRAFT: FilterDraft = { actorId: '', action: '', resourceType: '', resourceId: '', from: '', to: '' };

type DraftErrors = Partial<Record<keyof FilterDraft, string>>;

function validate(draft: FilterDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.actorId.trim() !== '' && !UUID.test(draft.actorId.trim())) errors.actorId = 'Enter the actor’s ID, like 3f2c…';
  if (draft.resourceId.trim() !== '' && !UUID.test(draft.resourceId.trim())) errors.resourceId = 'Enter the resource’s ID, like 3f2c…';
  if (draft.from !== '' && draft.to !== '' && new Date(draft.from) > new Date(draft.to)) errors.to = 'Choose a time after From';
  return errors;
}

function toFilters(draft: FilterDraft): AuditLogFilters {
  const text = (value: string) => (value.trim() === '' ? undefined : value.trim());
  return {
    actorId: text(draft.actorId),
    action: text(draft.action),
    resourceType: text(draft.resourceType),
    resourceId: text(draft.resourceId),
    from: draft.from === '' ? undefined : new Date(draft.from).toISOString(),
    to: draft.to === '' ? undefined : new Date(draft.to).toISOString(),
  };
}

const hasFilters = (filters: AuditLogFilters) => Object.values(filters).some((value) => value !== undefined);

/** "ticket.state_changed" reads as "Ticket state changed"; the raw code stays visible beside it. */
function actionLabel(action: string): string {
  const words = action.replace(/[._-]+/g, ' ').trim();
  return words === '' ? action : words.charAt(0).toUpperCase() + words.slice(1);
}

function actorLabel(actor: AuditLog['actor']): string {
  if (actor.name !== undefined && actor.name !== '') return actor.name;
  switch (actor.kind) {
    case 'system':
      return 'System';
    case 'operator':
      return 'Operator';
    case 'automation':
      return 'Automation';
    case 'user':
      return actor.id ?? 'Unknown user';
  }
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();

const resourceLabel = (entry: AuditLog) => (entry.resourceId === null ? entry.resourceType : `${entry.resourceType} · ${entry.resourceId}`);

function detailText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export default function AuditLogPage() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const logsQuery = useAuditLogs(filters);
  const announce = useAnnounce();

  const entries = logsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const applyFilters = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) setFilters(toFilters(draft));
  };

  const clearFilters = () => {
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setFilters({});
  };

  const open = (entry: AuditLog) => {
    setSelected(entry);
    setDrawerOpen(true);
  };

  const field = (name: keyof FilterDraft) => ({
    value: draft[name],
    onChange: (event: { target: { value: string } }) => setDraft((prev) => ({ ...prev, [name]: event.target.value })),
    error: errors[name] !== undefined,
    helperText: errors[name],
  });

  const loadMore = async () => {
    await logsQuery.fetchNextPage();
    announce('More entries loaded');
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1180 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          Audit log
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 640 }}>
          Who changed what in this workspace, newest first. Entries can&apos;t be edited or removed.
        </Typography>

        <Box
          component="form"
          aria-label="Filter the audit log"
          noValidate
          onSubmit={applyFilters}
          sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'flex-start', mb: 6 }}
        >
          <TextField label="Actor ID" size="small" sx={{ width: 260 }} {...field('actorId')} />
          <TextField label="Action" size="small" sx={{ width: 200 }} placeholder="ticket.assigned" {...field('action')} />
          <TextField label="Resource type" size="small" sx={{ width: 170 }} {...field('resourceType')} />
          <TextField label="Resource ID" size="small" sx={{ width: 260 }} {...field('resourceId')} />
          <TextField label="From" type="datetime-local" size="small" sx={{ width: 220 }} slotProps={{ inputLabel: { shrink: true } }} {...field('from')} />
          <TextField label="To" type="datetime-local" size="small" sx={{ width: 220 }} slotProps={{ inputLabel: { shrink: true } }} {...field('to')} />
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button type="submit" variant="contained">
              Apply filters
            </Button>
            <Button type="button" onClick={clearFilters}>
              Clear
            </Button>
          </Box>
        </Box>

        {logsQuery.isPending && <Skeleton variant="list" rows={8} label="audit log" />}

        {logsQuery.isError && (
          <EmptyState
            variant="error"
            title="Couldn't load the audit log"
            message={logsQuery.error?.message}
            onRetry={() => void logsQuery.refetch()}
          />
        )}

        {!logsQuery.isPending && !logsQuery.isError && entries.length === 0 && (
          <EmptyState
            title={hasFilters(filters) ? 'No entries match these filters' : 'No audit entries yet'}
            message={hasFilters(filters) ? 'Widen the time range or clear a filter.' : 'Changes to users, roles, groups and settings appear here.'}
          />
        )}

        {!logsQuery.isPending && !logsQuery.isError && entries.length > 0 && (
          <>
            <TableContainer sx={{ maxWidth: '100%', border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}>
              <Table aria-label="Audit log" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Time</TableCell>
                    <TableCell>Actor</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Resource</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id} hover onClick={() => open(entry)} sx={{ cursor: 'pointer' }}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Button
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation();
                            open(entry);
                          }}
                          sx={{ fontWeight: 500 }}
                        >
                          {formatTime(entry.occurredAt)}
                          <VisuallyHidden>, view details of {actionLabel(entry.action)}</VisuallyHidden>
                        </Button>
                      </TableCell>
                      <TableCell>{actorLabel(entry.actor)}</TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {actionLabel(entry.action)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {entry.action}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>{resourceLabel(entry)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {logsQuery.hasNextPage && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
                <Button onClick={() => void loadMore()} disabled={logsQuery.isFetchingNextPage}>
                  {logsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </Box>
            )}
          </>
        )}

        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Audit entry" width={480}>
          {selected !== null && <EntryDetails entry={selected} />}
        </Drawer>
      </Box>
    </DesignSystemScope>
  );
}

function EntryDetails({ entry }: { entry: AuditLog }) {
  const detailEntries = Object.entries(entry.details);
  const rows: Array<[string, string]> = [
    ['Time', formatTime(entry.occurredAt)],
    ['Actor', actorLabel(entry.actor)],
    ['Actor type', entry.actor.kind],
    ['Actor ID', entry.actor.id ?? '—'],
    ['Action', actionLabel(entry.action)],
    ['Action code', entry.action],
    ['Resource type', entry.resourceType],
    ['Resource ID', entry.resourceId ?? '—'],
    ['IP address', entry.ip ?? '—'],
    ['Entry ID', entry.id],
  ];
  return (
    <>
      <KeyValueList rows={rows} />
      <Typography component="h3" variant="overline" color="text.secondary" sx={{ display: 'block', mt: 6, mb: 2 }}>
        Details
      </Typography>
      {detailEntries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No further details were recorded.
        </Typography>
      ) : (
        <KeyValueList rows={detailEntries.map(([key, value]) => [key, detailText(value)])} />
      )}
    </>
  );
}

function KeyValueList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(96px, 1fr) 2fr', columnGap: 3, rowGap: 2 }}>
      {rows.map(([key, value]) => (
        <Box key={key} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {key}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
