import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { VisuallyHidden } from '../foundations/VisuallyHidden';

import { formatFileSize } from './attachment-rules';
import { formatChatTime } from './format';

import type { ChatAttachment, ChatDelivery, ChatMessage } from './types';

/**
 * One message in the customer chat (docs/design-system "Customer chat"): the customer's own
 * messages on the right in the accent color with their delivery status (✓ sent, ✓✓ delivered or
 * read), support replies on the left with the agent's name and avatar. System messages sit in
 * the middle as plain text. A message that failed to send offers "Try again".
 */

const DELIVERY_TEXT: Record<ChatDelivery, { label: string; ticks: string }> = {
  sending: { label: 'Sending…', ticks: '' },
  failed: { label: 'Not sent', ticks: '' },
  sent: { label: 'Sent', ticks: '✓' },
  delivered: { label: 'Delivered', ticks: '✓✓' },
  read: { label: 'Read', ticks: '✓✓' },
};

export interface ChatBubbleProps {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
}

export function ChatBubble({ message, onRetry }: ChatBubbleProps) {
  if (message.from === 'system') {
    return (
      <Box component="li" sx={{ listStyle: 'none', textAlign: 'center', my: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {message.body}
        </Typography>
      </Box>
    );
  }

  const mine = message.from === 'me';
  const name = message.sender?.name ?? 'Support';
  const time = formatChatTime(message.createdAt);
  const delivery = DELIVERY_TEXT[message.delivery];

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        alignItems: 'flex-end',
        gap: 2,
        // Off-screen bubbles skip layout and paint, which keeps long threads cheap to render.
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 72px',
      }}
    >
      {!mine && (
        <Avatar src={message.sender?.avatarUrl ?? undefined} alt="" sx={{ width: 28, height: 28, fontSize: '0.75rem', bgcolor: 'primary.light', color: 'text.primary' }}>
          {name.charAt(0).toUpperCase()}
        </Avatar>
      )}
      <Box
        sx={{
          maxWidth: '75%',
          px: 3,
          py: 2,
          borderRadius: '16px',
          ...(mine
            ? { bgcolor: 'primary.main', color: 'primary.contrastText', borderBottomRightRadius: '4px' }
            : { bgcolor: 'background.paper', color: 'text.primary', border: 1, borderColor: 'divider', borderBottomLeftRadius: '4px' }),
        }}
      >
        {mine ? (
          <VisuallyHidden>You:</VisuallyHidden>
        ) : (
          <Typography variant="caption" component="p" sx={{ fontWeight: 600, mb: 0.5 }}>
            {name}
          </Typography>
        )}
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.body}
        </Typography>
        {message.attachments.length > 0 && (
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {message.attachments.map((attachment) => (
              <AttachmentLine key={attachment.id} attachment={attachment} />
            ))}
          </Box>
        )}
        {/* Full-strength colors: faded 10px text fails contrast on the accent bubble. */}
        <Typography variant="caption" component="p" sx={{ mt: 1, fontSize: '0.625rem', color: mine ? 'inherit' : 'text.secondary' }}>
          <time dateTime={message.createdAt}>{time}</time>
          {mine && (
            <>
              {' · '}
              {delivery.label}
              {delivery.ticks !== '' && <span aria-hidden="true"> {delivery.ticks}</span>}
            </>
          )}
        </Typography>
        {mine && message.delivery === 'failed' && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            {message.error !== undefined && (
              <Typography variant="caption" component="p">
                {message.error}
              </Typography>
            )}
            {onRetry !== undefined && (
              <Button size="small" variant="contained" color="inherit" onClick={() => onRetry(message)} sx={{ color: 'text.primary', bgcolor: 'background.paper' }}>
                Try again
              </Button>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AttachmentLine({ attachment }: { attachment: ChatAttachment }) {
  const size = formatFileSize(attachment.sizeBytes);
  if (attachment.scanStatus === 'clean' && attachment.downloadPath) {
    return (
      <li>
        <Link href={attachment.downloadPath} color="inherit" underline="always" sx={{ fontWeight: 600 }}>
          {attachment.fileName}
        </Link>{' '}
        <Typography component="span" variant="caption">
          ({size})
        </Typography>
      </li>
    );
  }
  return (
    <li>
      <Typography component="span" variant="caption" sx={{ fontWeight: 600 }}>
        {attachment.fileName}
      </Typography>{' '}
      <Typography component="span" variant="caption">
        {attachment.scanStatus === 'blocked' ? '(blocked: this file looked unsafe)' : '(checking the file…)'}
      </Typography>
    </li>
  );
}
