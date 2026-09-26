import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { formatChatDate } from './format';

import type { ChatResolvedMarker } from './types';

/**
 * Where an earlier issue was wrapped up: a dated divider line in the thread
 * (docs/design-system "Past issues are shown as dated divider lines only").
 */
export function ResolvedMarker({ marker }: { marker: ChatResolvedMarker }) {
  return (
    <Box component="li" sx={{ listStyle: 'none', display: 'flex', alignItems: 'center', gap: 3, my: 2, color: 'text.secondary' }}>
      <Box aria-hidden="true" sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
      <Typography variant="caption" component="p" sx={{ textAlign: 'center' }}>
        {marker.text}
        {' · '}
        <time dateTime={marker.createdAt}>{formatChatDate(marker.createdAt)}</time>
      </Typography>
      <Box aria-hidden="true" sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
    </Box>
  );
}
