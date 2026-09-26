import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { formatChatTime } from '../chat/format';

import type { Message } from '../../data/messages';

/**
 * An internal note in the ticket's conversation (docs/design-system "Internal note"): a
 * warning-tinted card with a colored left border, explicitly labelled "Internal note" so the
 * distinction from a customer-visible reply never rests on color alone. Customers never see
 * these (constitution XI) — callers only render this for `message.visibility === 'internal'`.
 */

export interface InternalNoteCardProps {
  message: Message;
}

export function InternalNoteCard({ message }: InternalNoteCardProps) {
  const author = message.author?.name ?? 'Unknown';
  const time = formatChatTime(message.createdAt);

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        px: 3,
        py: 2.5,
        borderRadius: 1.5,
        bgcolor: 'warning.light',
        color: 'warning.main',
        borderLeft: '3px solid',
        borderLeftColor: 'warning.main',
      }}
    >
      <Typography component="p" variant="overline" sx={{ display: 'block', mb: 1 }}>
        Internal note · {author}
      </Typography>
      <Typography variant="body2" color="inherit" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message.body}
      </Typography>
      <Typography variant="caption" component="p" sx={{ mt: 1, opacity: 0.8 }}>
        <time dateTime={message.createdAt}>{time}</time>
      </Typography>
    </Box>
  );
}
