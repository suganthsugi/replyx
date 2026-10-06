import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useId, type ReactNode } from 'react';

import { formatDurationShort } from '../../../components/data-display/duration';
import { StatGrid, StatTile } from '../../../components/data-display/StatTile';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';

/**
 * The workspace dashboard without data access (US12, FR-086): the operational numbers over the
 * tickets the person can open. `DashboardPage` feeds it from `useDashboard`, which keeps the
 * figures live; this view just renders what it is given. A missing figure is "—", never a zero:
 * an average with nothing behind it and satisfaction before ratings exist (US16).
 */

/** The `/dashboard` response (contracts/operations.yaml). */
export interface DashboardData {
  counts: {
    open: number;
    ungrouped: number;
    unassigned: number;
    waitingOnCustomer: number;
    waitingOnSupport: number;
    urgent: number;
    slaBreached: number;
  };
  today: { created: number; resolved: number };
  averages: { firstResponseMinutes: number | null; resolutionMinutes: number | null; window?: string };
  satisfaction?: { average: number | null; responses: number };
}

export interface DashboardViewProps {
  status: 'pending' | 'error' | 'ready';
  /** Mapped, user-facing message for `status: 'error'`. */
  errorMessage?: string;
  onRetry: () => void;
  data?: DashboardData;
  /** When the figures were last fetched (ms), shown as a quiet "Updated" note. */
  updatedAt?: number;
}

const WINDOW_LABELS: Record<string, string> = { P7D: 'last 7 days' };

function windowLabel(window: string | undefined): string {
  return (window !== undefined ? WINDOW_LABELS[window] : undefined) ?? 'last 7 days';
}

function average(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? '—' : formatDurationShort(minutes);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Box component="section" aria-labelledby={id} sx={{ mb: 6 }}>
      <Typography id={id} component="h2" variant="overline" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function DashboardView({ status, errorMessage, onRetry, data, updatedAt }: DashboardViewProps) {
  const updated = updatedAt === undefined ? undefined : new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <Box component="main" id="desk-main" tabIndex={-1} sx={{ height: '100%', overflow: 'auto', px: { xs: 4, sm: 8 }, py: 6, outline: 'none' }}>
      <Box sx={{ maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1">
            Dashboard
          </Typography>
          {status === 'ready' && updated !== undefined && (
            <Typography variant="caption" color="text.secondary">
              Updated {updated}
            </Typography>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Live numbers for the tickets you can open. A group you have no access to adds nothing here.
        </Typography>

        {status === 'pending' && <Skeleton variant="block" label="dashboard" />}

        {status === 'error' && <EmptyState variant="error" title="Couldn't load the dashboard" message={errorMessage} onRetry={onRetry} />}

        {status === 'ready' && data === undefined && (
          <EmptyState title="No figures yet" message="Numbers appear here once there are tickets you can open." />
        )}

        {status === 'ready' && data !== undefined && <DashboardTiles data={data} />}
      </Box>
    </Box>
  );
}

function DashboardTiles({ data }: { data: DashboardData }) {
  const { counts, today, averages } = data;
  const satisfaction = data.satisfaction;
  const rating = satisfaction?.average ?? null;

  return (
    <>
      <Section title="Open tickets">
        <StatGrid>
          <StatTile label="Open" value={counts.open} />
          <StatTile label="Unassigned" value={counts.unassigned} note="No owner yet" />
          <StatTile label="Ungrouped" value={counts.ungrouped} note="Waiting for triage" />
          <StatTile label="Waiting on customer" value={counts.waitingOnCustomer} />
          <StatTile label="Waiting on support" value={counts.waitingOnSupport} />
          <StatTile label="Urgent" value={counts.urgent} tone={counts.urgent > 0 ? 'alert' : 'default'} />
          <StatTile label="SLA breached" value={counts.slaBreached} tone={counts.slaBreached > 0 ? 'alert' : 'default'} />
        </StatGrid>
        {counts.open === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
            Nothing is open right now.
          </Typography>
        )}
      </Section>

      <Section title="Today">
        <StatGrid>
          <StatTile label="Created today" value={today.created} />
          <StatTile label="Resolved today" value={today.resolved} />
        </StatGrid>
      </Section>

      <Section title={`Averages, ${windowLabel(averages.window)}`}>
        <StatGrid>
          <StatTile label="First response time" value={average(averages.firstResponseMinutes)} note={averages.firstResponseMinutes === null ? 'No replies yet' : undefined} />
          <StatTile label="Resolution time" value={average(averages.resolutionMinutes)} note={averages.resolutionMinutes === null ? 'Nothing resolved yet' : undefined} />
        </StatGrid>
      </Section>

      <Section title="Customer satisfaction">
        <StatGrid>
          <StatTile
            label="Average rating"
            value={rating === null ? '—' : rating.toFixed(1)}
            note={rating === null || satisfaction === undefined ? 'Not yet available' : `${satisfaction.responses} ${satisfaction.responses === 1 ? 'response' : 'responses'}`}
          />
        </StatGrid>
      </Section>
    </>
  );
}
