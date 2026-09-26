import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { ChatComposer } from '../../components/chat/ChatComposer';
import { ChatThread } from '../../components/chat/ChatThread';
import { EmptyState } from '../../components/foundations/EmptyState';
import { ChatIcon, MoreIcon } from '../../components/foundations/icons';
import { Skeleton } from '../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../components/shell/DesignSystemScope';
import { useAttachmentUploads } from '../../data/attachments';
import {
  useConnection,
  useConversation,
  useConversationEvents,
  useMarkRead,
  useSendMessage,
  useSupportTyping,
  useTypingSignal,
} from '../../data/conversation';

import { ProfileSheet } from './ProfileSheet';

import type { Branding, CustomerMe } from '../../api/generated/model';

/**
 * The customer's chat (spec US1, docs/design-system "Customer Chat"): the workspace's name and
 * logo on top, one continuous conversation, and the composer. Full height on a phone, a centered
 * 720 px column on a desktop. There is no ticket anywhere in it (constitution XI): the thread
 * comes only from the customer conversation projection.
 */
export default function ChatPage({ me, branding }: { me: CustomerMe; branding: Branding }) {
  const [profileOpen, setProfileOpen] = useState(false);
  useConversationEvents();
  const connected = useConnection();

  return (
    <DesignSystemScope tenantColor={branding.colors?.primary ?? null}>
      <Box component="main" sx={{ height: '100dvh', display: 'flex', justifyContent: 'center', p: { xs: 0, md: 6 } }}>
        <Box
          sx={{
            width: '100%',
            maxWidth: 720,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.paper',
            overflow: 'hidden',
            borderRadius: { xs: 0, md: '16px' },
            border: { xs: 0, md: 1 },
            borderColor: { md: 'divider' },
            boxShadow: { xs: 'none', md: 1 },
          }}
        >
          <Box component="header" sx={{ display: 'flex', alignItems: 'center', gap: 3, px: 4, py: 3, borderBottom: 1, borderColor: 'divider' }}>
            <Avatar src={branding.logoUrl ?? undefined} alt="" variant="rounded" sx={{ width: 36, height: 36, bgcolor: 'primary.main', color: 'primary.contrastText', borderRadius: '10px', fontFamily: 'h1.fontFamily', fontWeight: 700 }}>
              {branding.tenantName.charAt(0).toUpperCase()}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography component="h1" variant="h3" noWrap>
                {branding.tenantName} Support
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p">
                {connected ? `Signed in as ${me.name}` : 'Reconnecting…'}
              </Typography>
            </Box>
            <IconButton aria-label="Your profile" onClick={() => setProfileOpen(true)} sx={{ bgcolor: 'action.hover' }}>
              <MoreIcon fontSize="small" />
            </IconButton>
          </Box>

          {!connected && (
            <Typography variant="caption" component="p" sx={{ px: 4, py: 2, textAlign: 'center', bgcolor: 'warning.light', color: 'warning.main', borderBottom: 1, borderColor: 'divider' }}>
              Reconnecting… Messages you send will reach us once you're back online.
            </Typography>
          )}

          <Conversation welcomeMessage={branding.welcomeMessage ?? null} />
        </Box>
      </Box>
      <ProfileSheet open={profileOpen} onClose={() => setProfileOpen(false)} me={me} />
    </DesignSystemScope>
  );
}

function Conversation({ welcomeMessage }: { welcomeMessage: string | null }) {
  const conversation = useConversation();
  const typing = useSupportTyping();
  const { send, retry, rateLimitedUntil } = useSendMessage();
  const uploads = useAttachmentUploads();
  const { onTyping, stopTyping } = useTypingSignal();
  useMarkRead(conversation.items);

  if (conversation.isPending) {
    return (
      <Box sx={{ flex: 1, p: 4, bgcolor: 'background.default' }}>
        <Skeleton variant="list" rows={6} label="your conversation" />
      </Box>
    );
  }

  if (conversation.isError) {
    return (
      <Box sx={{ flex: 1, bgcolor: 'background.default' }}>
        <EmptyState variant="error" title="Couldn't load your conversation" message={conversation.error?.message} onRetry={() => void conversation.refetch()} />
      </Box>
    );
  }

  return (
    <>
      <ChatThread
        items={conversation.items}
        status={conversation.status}
        typing={typing}
        hasOlder={conversation.hasOlder}
        loadingOlder={conversation.loadingOlder}
        onLoadOlder={conversation.loadOlder}
        onRetry={(message) => void retry(message.clientMessageId ?? message.id)}
        emptyState={<WelcomeCard message={welcomeMessage} />}
      />
      <ChatComposer
        onSend={(body) => {
          stopTyping();
          void send(body, uploads.ready);
          uploads.clearReady();
        }}
        attachments={uploads.attachments}
        onAttach={uploads.add}
        onRemoveAttachment={uploads.remove}
        rateLimitedUntil={rateLimitedUntil}
        onTyping={onTyping}
      />
    </>
  );
}

function WelcomeCard({ message }: { message: string | null }) {
  return (
    <Box sx={{ maxWidth: 280, mx: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textAlign: 'center' }}>
      <Box aria-hidden="true" sx={{ width: 48, height: 48, borderRadius: '12px', display: 'grid', placeItems: 'center', bgcolor: 'primary.light', color: 'primary.main' }}>
        <ChatIcon />
      </Box>
      <Typography component="h2" variant="h2">
        Hi there, how can we help?
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {message ?? 'Send a message and our team will get back to you shortly.'}
      </Typography>
    </Box>
  );
}
