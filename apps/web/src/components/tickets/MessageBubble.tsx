import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { formatFileSize } from '../chat/attachment-rules';
import { formatChatTime } from '../chat/format';

import type { AttachmentSummary, Message } from '../../data/messages';

/**
 * One public message in the ticket's conversation (docs/design-system "Workspace Inbox" bubbles):
 * the customer's messages on the left in a bordered surface, staff and automation replies on the
 * right in the soft accent, and a system message as centered plain text. Internal notes are
 * `InternalNoteCard`, never this component.
 */

export interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.authorKind === 'system') {
    return (
      <Box component="li" sx={{ listStyle: 'none', textAlign: 'center', my: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {message.body}
        </Typography>
      </Box>
    );
  }

  const fromCustomer = message.authorKind === 'customer';
  const name = message.author?.name ?? (fromCustomer ? 'Customer' : message.authorKind === 'automation' ? 'Automation' : 'Agent');
  const time = formatChatTime(message.createdAt);

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        display: 'flex',
        justifyContent: fromCustomer ? 'flex-start' : 'flex-end',
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 72px',
      }}
    >
      <Box
        sx={{
          maxWidth: '75%',
          px: 3,
          py: 2,
          borderRadius: '14px',
          ...(fromCustomer
            ? { bgcolor: 'background.paper', color: 'text.primary', border: 1, borderColor: 'divider', borderBottomLeftRadius: '4px' }
            : { bgcolor: 'primary.light', color: 'text.primary', borderBottomRightRadius: '4px' }),
        }}
      >
        <Typography variant="caption" component="p" sx={{ fontWeight: 600, mb: 0.5, opacity: 0.75 }}>
          {name}
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.body}
        </Typography>
        {message.attachments.length > 0 && (
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {message.attachments.map((attachment) => (
              <AttachmentLine key={attachment.id} attachment={attachment} />
            ))}
          </Box>
        )}
        <Typography variant="caption" component="p" sx={{ mt: 1, fontSize: '0.625rem', opacity: 0.7 }}>
          <time dateTime={message.createdAt}>{time}</time>
        </Typography>
      </Box>
    </Box>
  );
}

function AttachmentLine({ attachment }: { attachment: AttachmentSummary }) {
  const size = formatFileSize(attachment.sizeBytes);
  if (attachment.scanStatus === 'clean' && attachment.downloadPath != null) {
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
