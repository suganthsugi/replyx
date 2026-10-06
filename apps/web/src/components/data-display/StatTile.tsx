import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

import type { ReactNode } from 'react';

/**
 * One number on a dashboard (design-system "stat" card): a label, the figure, and an optional
 * note. It is a name/value pair (`dt`/`dd`), so it belongs inside `StatGrid`, which is the `dl`.
 * `tone: 'alert'` colors the figure for counts that need attention; the label always says what the
 * number is, so color never carries meaning alone.
 */

export interface StatTileProps {
  label: string;
  /** The figure, already formatted; `—` when there is none. */
  value: ReactNode;
  note?: string;
  tone?: 'default' | 'alert';
}

export function StatTile({ label, value, note, tone = 'default' }: StatTileProps) {
  return (
    <Paper variant="outlined" sx={{ p: 4, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="h4" sx={{ m: 0, color: tone === 'alert' ? 'error.main' : 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
      {note !== undefined && (
        <Typography component="dd" variant="caption" color="text.secondary" sx={{ m: 0 }}>
          {note}
        </Typography>
      )}
    </Paper>
  );
}

/** The grid of tiles; each tile is a `dt`/`dd` group, wrapped so the list stays valid HTML. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <Box
      component="dl"
      sx={{ m: 0, display: 'grid', gap: 3, gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
    >
      {children}
    </Box>
  );
}
