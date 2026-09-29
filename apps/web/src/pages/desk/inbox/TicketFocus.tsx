import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { CloseIcon } from '../../../components/foundations/icons';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { GroupSelector } from '../../../components/inputs/GroupSelector';
import { MessageComposer } from '../../../components/inputs/MessageComposer';
import { PrioritySelector } from '../../../components/inputs/PrioritySelector';
import { StateSelector } from '../../../components/inputs/StateSelector';
import { TagInput } from '../../../components/inputs/TagInput';
import { UserSelector } from '../../../components/inputs/UserSelector';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { useToast } from '../../../components/shell/Toast';
import { HistoryTimeline } from '../../../components/tickets/HistoryTimeline';
import { PresenceStack } from '../../../components/tickets/PresenceStack';
import { PriorityMark } from '../../../components/tickets/PriorityMark';
import { StatePill } from '../../../components/tickets/StatePill';
import { TicketConversation } from '../../../components/tickets/TicketConversation';
import { TriageBar } from '../../../components/tickets/TriageBar';
import { useAttachmentUploads } from '../../../data/attachments';
import { useMe } from '../../../data/auth';
import { useEligibleOwners, useGroupDestinations } from '../../../data/groups';
import { useSendTicketMessage, useTicketMessages, useTicketMessageEvents } from '../../../data/messages';
import { useRealtime } from '../../../data/realtime';
import { useCreateTag, useTags } from '../../../data/tags';
import {
  useCreateTicketLink,
  useDeleteTicket,
  useDeleteTicketLink,
  useTicket,
  useTicketHistory,
  useTicketPresence,
  useTicketRemovedFromView,
  useTicketRoom,
  useTicketTypingIndicator,
  useTicketTypingSignal,
  useUpdateTicket,
} from '../../../data/tickets';
import { useUsers } from '../../../data/users';

import type { PresenceUser as PresenceRowUser } from '../../../components/tickets/types';
import type { TagRef } from '../../../data/tags';
import type { CreateTicketLinkBodyKind, HistoryEntry, HistoryEntryActor } from '../../../data/tickets';

/**
 * A single ticket's working area (docs/design-system "Workspace Inbox" focus pane): a status
 * strip for state/priority/group/owner/tags, the conversation with its composer, a separate
 * history tab, links to other tickets, and who else has this open. Closes itself (`onClose`)
 * shortly after `ticket.removed_from_view` (moved out of every view the agent can see, deleted,
 * or merged away).
 */

export interface TicketFocusProps {
  ticketId: string;
  onClose: () => void;
  onOpenCustomer: (customerId: string) => void;
}

const LINK_KIND_LABELS: Record<CreateTicketLinkBodyKind, string> = {
  follow_up_of: 'Follow-up of',
  related: 'Related to',
  duplicate_of: 'Duplicate of',
};

export function TicketFocus({ ticketId, onClose, onOpenCustomer }: TicketFocusProps) {
  const client = useRealtime();
  const announce = useAnnounce();
  const toast = useToast();
  const [tab, setTab] = useState<'conversation' | 'history'>('conversation');
  const [removed, setRemoved] = useState<{ reason: 'moved' | 'deleted' | 'merged' } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkKind, setLinkKind] = useState<CreateTicketLinkBodyKind>('related');

  useTicketRoom(client, ticketId);
  useTicketMessageEvents(client, ticketId);
  const connected = useSocketConnected(client);
  const presenceRaw = useTicketPresence(client, ticketId);
  const typingRaw = useTicketTypingIndicator(client, ticketId);
  const { onTyping, stopTyping } = useTicketTypingSignal(client, ticketId, 'public');

  const onRemoved = useCallback(
    (event: { ticketId: string; reason: 'moved' | 'deleted' | 'merged' }) => {
      if (event.ticketId !== ticketId) return;
      setRemoved({ reason: event.reason });
      announce('You no longer have access to this ticket. This view will close shortly.', 'assertive');
    },
    [ticketId, announce],
  );
  useTicketRemovedFromView(client, onRemoved);

  useEffect(() => {
    if (removed === null) return undefined;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [removed, onClose]);

  const meQuery = useMe();
  const ticketQuery = useTicket(ticketId);
  const messages = useTicketMessages(ticketId);
  const history = useTicketHistory(ticketId);
  const { send } = useSendTicketMessage(ticketId);
  const uploads = useAttachmentUploads({ audience: 'staff' });
  const updateTicket = useUpdateTicket();
  const deleteTicket = useDeleteTicket();
  const createLink = useCreateTicketLink();
  const deleteLink = useDeleteTicketLink();

  const groups = useGroupDestinations();
  const groupId = ticketQuery.data?.group?.id;
  const eligibleOwners = useEligibleOwners(groupId);
  const tags = useTags();
  const createTag = useCreateTag();
  const staffUsers = useUsers({ kind: 'staff', status: 'active' });

  const mentionCandidates = useMemo(
    () => (staffUsers.data?.pages ?? []).flatMap((page) => page.items).map((user) => ({ id: user.id, name: user.name })),
    [staffUsers.data],
  );

  const currentOwner = ticketQuery.data?.owner;
  const currentGroup = ticketQuery.data?.group;
  const historyNames = useMemo(() => {
    const userNameById = new Map<string, string>();
    if (currentOwner) userNameById.set(currentOwner.id, currentOwner.name);
    for (const owner of eligibleOwners.data ?? []) userNameById.set(owner.id, owner.name);
    for (const page of staffUsers.data?.pages ?? []) {
      for (const user of page.items) userNameById.set(user.id, user.name);
    }
    const groupNameById = new Map<string, string>();
    if (currentGroup) groupNameById.set(currentGroup.id, currentGroup.name);
    for (const group of groups.data ?? []) groupNameById.set(group.id, group.name);
    return { userNameById, groupNameById };
  }, [currentOwner, currentGroup, eligibleOwners.data, staffUsers.data, groups.data]);

  if (ticketQuery.isPending) {
    return (
      <Box sx={{ p: 4 }}>
        <Skeleton variant="block" label="the ticket" />
      </Box>
    );
  }

  if (ticketQuery.isError) {
    return (
      <EmptyState
        variant="error"
        title="Couldn't load this ticket"
        message={ticketQuery.error?.message}
        onRetry={() => void ticketQuery.refetch()}
        headingLevel={2}
      />
    );
  }

  const ticket = ticketQuery.data;
  const allowed = new Set(ticket.allowedActions);
  const canEdit = allowed.has('edit');
  const canReplyOrNote = allowed.has('reply') || allowed.has('note');
  // FR-063: an ungrouped ticket with edit on Ungrouped (`change_group`) is triaged through
  // TriageBar instead of the strip's Priority, Group, Owner and Tags controls, which it replaces.
  const showTriage = ticket.group === null && allowed.has('change_group');

  const presence: PresenceRowUser[] = [
    ...presenceRaw.viewers.map((viewer) => ({ id: viewer.id, name: viewer.name, status: 'viewing' as const })),
    ...typingRaw.map((user) => ('id' in user ? { id: user.id, name: user.name, status: 'typing' as const } : { id: `customer:${user.name}`, name: user.name, status: 'typing' as const })),
  ];

  const historyEvents = (history.items ?? []).map((entry) => ({ id: entry.id, text: formatHistoryEntry(entry, historyNames), createdAt: entry.occurredAt }));

  const conversationItems = messages.items.map((message) => ({ kind: 'message' as const, id: message.id, message }));

  // One action to resolve, e.g. again after the customer's "thanks" reopened it (US7 scenario 2).
  const canResolve = canEdit && !showTriage && ticket.state !== 'resolved' && ticket.state !== 'closed';
  const resolve = async () => {
    await updateTicket.mutateAsync({ id: ticketId, state: 'resolved' });
    toast({ message: 'Ticket resolved', severity: 'success' });
  };

  const assignToMe = async () => {
    if (meQuery.data === undefined) return;
    await updateTicket.mutateAsync({ id: ticketId, ownerId: meQuery.data.id });
    toast({ message: 'Assigned to you', severity: 'success' });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {removed !== null && (
        <Box role="alert" sx={{ px: 4, py: 2, bgcolor: 'error.light', color: 'error.main', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            You no longer have access to this ticket. This view will close shortly.
          </Typography>
        </Box>
      )}
      {!connected && (
        <Box sx={{ px: 4, py: 1.5, textAlign: 'center', bgcolor: 'warning.light', color: 'warning.main', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="caption">Reconnecting — catching up on the latest activity…</Typography>
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 3, px: 4, py: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            #{ticket.number}
          </Typography>
          <Typography component="h2" variant="h2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ticket.title}
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => onOpenCustomer(ticket.customer.id)}
            sx={{ px: 0, minWidth: 0, textTransform: 'none', fontWeight: 600 }}
          >
            {ticket.customer.name}
          </Button>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <PresenceStack users={presence} />
          {allowed.has('delete') && (
            <IconButton aria-label="Delete ticket" onClick={() => setConfirmingDelete(true)} size="small">
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      </Box>

      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 3,
          px: 4,
          py: 2.5,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <StatePill state={ticket.state} />
        <Box sx={{ minWidth: 160 }}>
          <StateSelector
            value={ticket.state}
            pendingUntil={ticket.pendingUntil}
            disabled={!canEdit}
            onChange={({ state, pendingUntil }) => void updateTicket.mutateAsync({ id: ticketId, state, pendingUntil })}
          />
        </Box>
        {canResolve && (
          <Button size="small" variant="contained" onClick={() => void resolve()} disabled={updateTicket.isPending}>
            Resolve
          </Button>
        )}
        <PriorityMark priority={ticket.priority} />
        {!showTriage && (
          <PrioritySelector value={ticket.priority} disabled={!canEdit} onChange={(priority) => void updateTicket.mutateAsync({ id: ticketId, priority })} />
        )}
        {!showTriage && (
          <Box sx={{ minWidth: 180 }}>
            <GroupSelector
              label="Group"
              value={ticket.group}
              options={groups.data ?? []}
              loading={groups.isPending}
              disabled={!allowed.has('change_group')}
              onChange={(next) => void updateTicket.mutateAsync({ id: ticketId, groupId: next?.id ?? null })}
            />
          </Box>
        )}
        {!showTriage && (
          <>
            <Box sx={{ minWidth: 180 }}>
              <UserSelector
                label="Owner"
                value={ticket.owner}
                options={eligibleOwners.data ?? []}
                loading={eligibleOwners.isPending}
                disabled={!allowed.has('assign')}
                onChange={(next) => void updateTicket.mutateAsync({ id: ticketId, ownerId: next?.id ?? null })}
              />
            </Box>
            {allowed.has('assign') && ticket.owner === null && (
              <Button size="small" variant="outlined" onClick={() => void assignToMe()}>
                Assign to me
              </Button>
            )}
            <Box sx={{ minWidth: 220, flex: 1 }}>
              <TagInput
                value={ticket.tags}
                options={tags.data ?? []}
                disabled={!canEdit}
                onCreateTag={(name) => void createTag.mutateAsync({ name })}
                onChange={(next: TagRef[]) => void updateTicket.mutateAsync({ id: ticketId, tagIds: next.map((tag) => tag.id) })}
              />
            </Box>
          </>
        )}
      </Box>

      {showTriage && <TriageBar ticketId={ticketId} onClose={onClose} />}

      <LinksPanel
        links={ticket.links}
        canEdit={canEdit}
        adding={addingLink}
        onStartAdd={() => setAddingLink(true)}
        onCancelAdd={() => {
          setAddingLink(false);
          setLinkTargetId('');
        }}
        linkTargetId={linkTargetId}
        onLinkTargetIdChange={setLinkTargetId}
        linkKind={linkKind}
        onLinkKindChange={setLinkKind}
        onSubmitAdd={() => {
          if (linkTargetId.trim() === '') return;
          void createLink.mutateAsync(ticketId, { targetTicketId: linkTargetId.trim(), kind: linkKind }).then(() => {
            setAddingLink(false);
            setLinkTargetId('');
          });
        }}
        onRemove={(linkId) => void deleteLink.mutateAsync(ticketId, linkId)}
      />

      <Tabs value={tab} onChange={(_event, next: 'conversation' | 'history') => setTab(next)} sx={{ px: 4, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="conversation" label="Conversation" id="ticket-tab-conversation" aria-controls="ticket-tabpanel-conversation" />
        <Tab value="history" label="History" id="ticket-tab-history" aria-controls="ticket-tabpanel-history" />
      </Tabs>

      {tab === 'conversation' ? (
        <Box id="ticket-tabpanel-conversation" role="tabpanel" aria-labelledby="ticket-tab-conversation" sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {messages.isPending ? (
            <Box sx={{ p: 4 }}>
              <Skeleton variant="list" rows={4} label="the conversation" />
            </Box>
          ) : messages.isError ? (
            <EmptyState variant="error" title="Couldn't load messages" message={messages.error?.message} onRetry={() => void messages.refetch()} />
          ) : (
            <TicketConversation
              items={conversationItems}
              hasOlder={messages.hasOlder}
              loadingOlder={messages.loadingOlder}
              onLoadOlder={messages.loadOlder}
            />
          )}
          <MessageComposer
            onSend={(body, mode) => {
              stopTyping();
              void send({
                visibility: mode === 'note' ? 'internal' : 'public',
                body,
                attachmentIds: uploads.ready.map((attachment) => attachment.id),
              });
              uploads.clearReady();
            }}
            attachments={uploads.attachments}
            onAttach={uploads.add}
            onRemoveAttachment={uploads.remove}
            onTyping={onTyping}
            mentionCandidates={mentionCandidates}
            disabled={!canReplyOrNote}
          />
        </Box>
      ) : (
        <Box id="ticket-tabpanel-history" role="tabpanel" aria-labelledby="ticket-tab-history" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 4 }}>
          {history.isPending ? (
            <Skeleton variant="list" rows={4} label="the ticket's history" />
          ) : history.isError ? (
            <EmptyState variant="error" title="Couldn't load history" message={history.error?.message} onRetry={() => void history.refetch()} />
          ) : (
            <HistoryTimeline events={historyEvents} />
          )}
        </Box>
      )}

      <ConfirmationDialog
        open={confirmingDelete}
        title="Delete this ticket?"
        message="This removes the ticket and its messages from the customer's conversation. This can't be undone."
        confirmLabel="Delete ticket"
        destructive
        onClose={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          await deleteTicket.mutateAsync({ id: ticketId });
          onClose();
        }}
      />
    </Box>
  );
}

function LinksPanel({
  links,
  canEdit,
  adding,
  onStartAdd,
  onCancelAdd,
  linkTargetId,
  onLinkTargetIdChange,
  linkKind,
  onLinkKindChange,
  onSubmitAdd,
  onRemove,
}: {
  links: readonly { id: string; kind: string; direction: 'incoming' | 'outgoing'; ticket: { id?: string; number?: number; title?: string } | null }[];
  canEdit: boolean;
  adding: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  linkTargetId: string;
  onLinkTargetIdChange: (value: string) => void;
  linkKind: CreateTicketLinkBodyKind;
  onLinkKindChange: (value: CreateTicketLinkBodyKind) => void;
  onSubmitAdd: () => void;
  onRemove: (linkId: string) => void;
}) {
  return (
    <Box sx={{ px: 4, py: 2.5, borderBottom: 1, borderColor: 'divider', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
      <Typography variant="overline" color="text.secondary">
        Links
      </Typography>
      {links.length === 0 && !adding && (
        <Typography variant="caption" color="text.secondary">
          No linked tickets.
        </Typography>
      )}
      {links.map((link) => (
        <Chip
          key={link.id}
          label={link.ticket === null ? `${LINK_KIND_LABELS[link.kind as CreateTicketLinkBodyKind] ?? link.kind} (removed)` : `${LINK_KIND_LABELS[link.kind as CreateTicketLinkBodyKind] ?? link.kind} #${link.ticket.number}`}
          size="small"
          onDelete={canEdit ? () => onRemove(link.id) : undefined}
        />
      ))}
      {canEdit && !adding && (
        <Button size="small" variant="text" onClick={onStartAdd}>
          Add link
        </Button>
      )}
      {canEdit && adding && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <TextField
            select
            size="small"
            label="Kind"
            value={linkKind}
            onChange={(event) => onLinkKindChange(event.target.value as CreateTicketLinkBodyKind)}
            sx={{ minWidth: 140 }}
          >
            {(Object.keys(LINK_KIND_LABELS) as CreateTicketLinkBodyKind[]).map((kind) => (
              <MenuItem key={kind} value={kind}>
                {LINK_KIND_LABELS[kind]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Ticket ID"
            helperText="Paste the other ticket's id"
            value={linkTargetId}
            onChange={(event) => onLinkTargetIdChange(event.target.value)}
          />
          <Button size="small" variant="contained" onClick={onSubmitAdd} disabled={linkTargetId.trim() === ''}>
            Add
          </Button>
          <Button size="small" onClick={onCancelAdd}>
            Cancel
          </Button>
        </Box>
      )}
    </Box>
  );
}

function actorName(actor: HistoryEntryActor): string {
  if (actor.kind === 'user') return actor.user?.name ?? 'Someone';
  if (actor.kind === 'automation') return actor.ruleName ?? 'An automation rule';
  if (actor.kind === 'routing') return 'Routing';
  return 'The system';
}

const FIELD_LABELS: Record<string, string> = {
  state: 'State',
  priority: 'Priority',
  group_id: 'Group',
  owner_id: 'Owner',
  title: 'Title',
  tags: 'Tags',
  pending_until: 'Pending until',
  waiting_on: 'Waiting on',
  last_agent_reply_at: 'Last agent reply',
  last_customer_message_at: 'Last customer message',
  message_moved: 'Message moved',
};

/** Turns an unmapped snake_case field name into a readable label, e.g. `follow_up_at` -> `Follow up at`. */
function readableFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

interface HistoryNames {
  userNameById: Map<string, string>;
  groupNameById: Map<string, string>;
}

function formatValue(field: string, value: unknown, names: HistoryNames): string {
  if (value === null || value === undefined) return 'none';
  if (field === 'owner_id' && typeof value === 'string') {
    return names.userNameById.get(value) ?? 'Unknown user';
  }
  if (field === 'group_id' && typeof value === 'string') {
    return names.groupNameById.get(value) ?? 'a removed group';
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatHistoryEntry(entry: HistoryEntry, names: HistoryNames): string {
  const label = readableFieldLabel(entry.field);
  const by = actorName(entry.actor);
  if (entry.oldValue === null || entry.oldValue === undefined) {
    return `${label} set to ${formatValue(entry.field, entry.newValue, names)} by ${by}`;
  }
  return `${label} changed from ${formatValue(entry.field, entry.oldValue, names)} to ${formatValue(entry.field, entry.newValue, names)} by ${by}`;
}

/** Whether `client`'s socket is connected right now (false while reconnecting); local to this page. */
function useSocketConnected(client: ReturnType<typeof useRealtime>): boolean {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    if (client === undefined) return undefined;
    return client.onConnectionChange(setConnected);
  }, [client]);
  return connected;
}
