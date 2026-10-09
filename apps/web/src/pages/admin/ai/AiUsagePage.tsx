import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { StatGrid, StatTile } from '../../../components/data-display/StatTile';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useAiRuns, type AiRun, type AiRunsFilter } from '../../../data/ai/runs';
import { useViews } from '../../../data/views';
import { WORKSPACE_BASE } from '../../../routes/area';

/**
 * AI usage (specs/002-ai-assist US3, FR-017 to FR-019), behind `ai_usage.view`: every AI call with
 * its purpose, model, tokens and cost, newest first, with totals for the chosen date range and
 * purpose. A cost marked "≈" is an estimate (the price was not reported by the provider).
 */

type Purpose = NonNullable<AiRunsFilter['purpose']>;

const PURPOSES: readonly { value: Purpose; label: string }[] = [
  { value: 'reply', label: 'Customer reply' },
  { value: 'draft', label: 'Draft for an agent' },
  { value: 'routing', label: 'Routing' },
  { value: 'complexity', label: 'Complexity check' },
  { value: 'summary', label: 'Summary' },
  { value: 'embedding', label: 'Policy indexing' },
  { value: 'connection_test', label: 'Connection test' },
];

const PURPOSE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(PURPOSES.map(({ value, label }) => [value, label]));

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ok: 'Succeeded',
  auth: 'Key rejected',
  credit: 'No credit',
  rate_limit: 'Rate limited',
  timeout: 'Timed out',
  unavailable: 'Provider unavailable',
  bad_request: 'Request rejected',
};

const formatTime = (iso: string) => new Date(iso).toLocaleString();
const formatCount = (value: number) => value.toLocaleString('en');
const formatUsd = (value: number, digits = 4) => `$${value.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function startOfDay(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

function endOfDay(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

export default function AiUsagePage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [purpose, setPurpose] = useState<Purpose | ''>('');
  const rangeInvalid = from !== '' && to !== '' && from > to;

  const filter = useMemo<AiRunsFilter>(
    () => ({
      ...(from === '' || rangeInvalid ? {} : { from: startOfDay(from) }),
      ...(to === '' || rangeInvalid ? {} : { to: endOfDay(to) }),
      ...(purpose === '' ? {} : { purpose }),
    }),
    [from, to, purpose, rangeInvalid],
  );
  const runs = useAiRuns(filter);
  const views = useViews();
  const viewId = views.data?.[0]?.id;
  const announce = useAnnounce();
  const filtered = from !== '' || to !== '' || purpose !== '';

  // Say what the filters matched (not on first load).
  const lastTotals = useRef<string | undefined>(undefined);
  const totalsKey = runs.totals === undefined ? undefined : `${runs.totals.runs}:${runs.totals.costUsd}`;
  useEffect(() => {
    if (totalsKey === undefined || runs.totals === undefined) return;
    if (lastTotals.current !== undefined && lastTotals.current !== totalsKey) {
      announce(`${formatCount(runs.totals.runs)} ${runs.totals.runs === 1 ? 'run' : 'runs'}, ${formatUsd(runs.totals.costUsd)}`, 'polite');
    }
    lastTotals.current = totalsKey;
  }, [totalsKey, runs.totals, announce]);

  // Say how many rows "Load more" added.
  const countBeforeMore = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (countBeforeMore.current === undefined || runs.loadingMore) return;
    const added = runs.items.length - countBeforeMore.current;
    countBeforeMore.current = undefined;
    if (added > 0) announce(`Loaded ${added} more ${added === 1 ? 'run' : 'runs'}`, 'polite');
  }, [runs.items.length, runs.loadingMore, announce]);

  const clearFilters = () => {
    setFrom('');
    setTo('');
    setPurpose('');
  };

  const hasRows = runs.items.length > 0;

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1180 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          AI usage
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Every AI call with its model, tokens and cost, newest first. A cost marked “≈” is an estimate.
        </Typography>

        <Box component="form" aria-label="Filter AI usage" noValidate onSubmit={(event) => event.preventDefault()} sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'flex-start', mb: 5 }}>
          <TextField
            label="From"
            type="date"
            size="small"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            sx={{ width: 180 }}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="To"
            type="date"
            size="small"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            error={rangeInvalid}
            helperText={rangeInvalid ? 'Choose a date on or after From.' : undefined}
            sx={{ width: 180 }}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField select label="Purpose" size="small" value={purpose} onChange={(event) => setPurpose(event.target.value as Purpose | '')} sx={{ width: 220 }} slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
            <MenuItem value="">All purposes</MenuItem>
            {PURPOSES.map(({ value, label }) => (
              <MenuItem key={value} value={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          {filtered && (
            <Button type="button" onClick={clearFilters} sx={{ mt: 0.5 }}>
              Clear filters
            </Button>
          )}
        </Box>

        {runs.isPending && <Skeleton variant="list" rows={8} label="AI usage" />}
        {runs.isError && !hasRows && <EmptyState variant="error" title="Couldn't load AI usage" message={runs.error?.message} onRetry={() => void runs.refetch()} />}

        {!runs.isPending && !runs.isError && !hasRows && (
          <EmptyState
            title={filtered ? 'No AI calls match these filters' : 'No AI calls yet'}
            message={filtered ? 'Widen the date range or choose another purpose.' : 'Calls appear here once the assistant starts answering or drafting.'}
            action={filtered ? { label: 'Clear filters', onClick: clearFilters } : undefined}
          />
        )}

        {hasRows && (
          <>
            {runs.totals !== undefined && (
              <Box sx={{ mb: 5, maxWidth: 420 }}>
                <StatGrid>
                  <StatTile label="Runs" value={formatCount(runs.totals.runs)} note={filtered ? 'In this selection' : 'All time'} />
                  <StatTile label="Cost (USD)" value={formatUsd(runs.totals.costUsd, 2)} note={filtered ? 'In this selection' : 'All time'} />
                </StatGrid>
              </Box>
            )}
            <TableContainer sx={{ maxWidth: '100%', border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}>
              <Table aria-label="AI calls" sx={{ minWidth: 860 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>When</TableCell>
                    <TableCell>Purpose</TableCell>
                    <TableCell>Model</TableCell>
                    <TableCell>Level</TableCell>
                    <TableCell align="right">Tokens (in / out)</TableCell>
                    <TableCell align="right">Cost</TableCell>
                    <TableCell>Outcome</TableCell>
                    <TableCell>Ticket</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {runs.items.map((run) => (
                    <RunRow key={run.id} run={run} viewId={viewId} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {(runs.hasMore || runs.isError) && (
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2, flexWrap: 'wrap', mt: 4 }}>
                {runs.isError && !runs.loadingMore && (
                  <Typography variant="body2" color="error">
                    Couldn&apos;t load more{runs.error?.message ? `: ${runs.error.message}` : ''}
                  </Typography>
                )}
                <Button
                  onClick={() => {
                    countBeforeMore.current = runs.items.length;
                    runs.loadMore();
                  }}
                  disabled={runs.loadingMore}
                  aria-busy={runs.loadingMore}
                >
                  {runs.loadingMore ? 'Loading…' : runs.isError ? 'Retry' : 'Load more'}
                </Button>
              </Box>
            )}
          </>
        )}
      </Box>
    </DesignSystemScope>
  );
}

function RunRow({ run, viewId }: { run: AiRun; viewId: string | undefined }) {
  const ticket = run.ticket ?? null;
  const ticketLabel = ticket?.number === undefined ? 'Ticket' : `#${ticket.number}`;
  return (
    <TableRow hover>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTime(run.createdAt)}</TableCell>
      <TableCell>{PURPOSE_LABELS[run.purpose] ?? capitalize(run.purpose)}</TableCell>
      <TableCell sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: '0.8125rem' }}>{run.model}</TableCell>
      <TableCell>{run.level == null ? '—' : capitalize(run.level)}</TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {formatCount(run.inputTokens)} / {formatCount(run.outputTokens)}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {run.costUsd == null ? (
          '—'
        ) : run.costEstimated === true ? (
          <>
            <span aria-hidden="true">≈ </span>
            <VisuallyHidden>estimated </VisuallyHidden>
            {formatUsd(run.costUsd)}
          </>
        ) : (
          formatUsd(run.costUsd)
        )}
      </TableCell>
      <TableCell>{OUTCOME_LABELS[run.outcome] ?? run.outcome}</TableCell>
      <TableCell>
        {ticket === null || ticket.id === undefined ? (
          '—'
        ) : viewId === undefined ? (
          ticketLabel
        ) : (
          <Link component={RouterLink} to={`${WORKSPACE_BASE}/inbox/${viewId}/${ticket.id}`}>
            {ticketLabel}
          </Link>
        )}
      </TableCell>
    </TableRow>
  );
}
