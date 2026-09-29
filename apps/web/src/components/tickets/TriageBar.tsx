import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useEligibleOwners, useGroupDestinations } from '../../data/groups';
import { useCreateTag, useTags } from '../../data/tags';
import { useTriageTicket } from '../../data/triage';
import { useAnnounce } from '../foundations/LiveRegion';
import { GroupSelector, type GroupOption } from '../inputs/GroupSelector';
import { PrioritySelector } from '../inputs/PrioritySelector';
import { TagInput } from '../inputs/TagInput';
import { UserSelector, type UserOption } from '../inputs/UserSelector';

import type { TagRef } from '../../data/tags';
import type { Priority } from '../../data/tickets';

/**
 * Triage (US5, FR-063, SC-005): sets an ungrouped ticket's group and, optionally, owner, priority
 * and tags in one step, shown by `TicketFocus` in place of the regular group control while the
 * ticket has no group. Matches docs/design-system "Workspace Inbox" triage bar: a row of pill
 * fields and an Assign button, with `G`/`O`/`Enter` shortcuts so the whole flow fits SC-005's
 * three actions (focus Group, pick one, Assign).
 */

export interface TriageBarProps {
  ticketId: string;
  /** Called when the triaged ticket is no longer visible to this caller (`useTriageTicket`). */
  onClose: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function TriageBar({ ticketId, onClose }: TriageBarProps) {
  const announce = useAnnounce();
  const groups = useGroupDestinations();
  const tags = useTags();
  const createTag = useCreateTag();
  const triage = useTriageTicket(ticketId);

  const [group, setGroup] = useState<GroupOption | null>(null);
  const [owner, setOwner] = useState<UserOption | null>(null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [ticketTags, setTicketTags] = useState<TagRef[]>([]);

  const eligibleOwners = useEligibleOwners(group?.id);

  const groupInputRef = useRef<HTMLInputElement>(null);
  const ownerInputRef = useRef<HTMLInputElement>(null);

  // The owner list depends on the chosen group; an owner picked for a previous group is no
  // longer necessarily eligible, so clear it whenever the group changes.
  useEffect(() => {
    setOwner(null);
  }, [group?.id]);

  const handleAssign = useCallback(async () => {
    if (group === null || triage.isPending) return;
    const destination = group;
    try {
      const result = await triage.mutateAsync({
        groupId: destination.id,
        ownerId: owner?.id,
        priority: priority ?? undefined,
        tagIds: ticketTags.length > 0 ? ticketTags.map((tag) => tag.id) : undefined,
      });
      if (result.alreadyTriaged) {
        announce('Someone else already triaged this ticket.', 'assertive');
        onClose();
        return;
      }
      announce(`Ticket sent to ${destination.name}`, 'polite');
      if (!result.visibleToCaller) onClose();
    } catch {
      // `triage.error` (mapped below) carries the message; nothing further to do here.
    }
  }, [group, owner, priority, ticketTags, triage, announce, onClose]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;

      if (event.key === 'Enter') {
        if (group === null) return;
        // Only from our own Group/Owner field once its listbox is closed (a value is picked, so
        // Enter is the next step of G -> pick -> Enter, SC-005). Everywhere else Enter keeps its
        // own meaning: picking an option, committing a tag, sending a reply, opening a list row,
        // pressing a focused button.
        const isOwnIdleField =
          (target === groupInputRef.current || target === ownerInputRef.current) &&
          !(target instanceof HTMLElement && target.getAttribute('aria-expanded') === 'true');
        if (!isOwnIdleField) return;
        event.preventDefault();
        void handleAssign();
        return;
      }

      if (isTypingTarget(target)) return;
      const key = event.key.toLowerCase();
      if (key === 'g') {
        event.preventDefault();
        groupInputRef.current?.focus();
      } else if (key === 'o') {
        if (group === null) return;
        event.preventDefault();
        ownerInputRef.current?.focus();
      }
    }
    // Capture phase: the check above must see the listbox as it was before Autocomplete handles
    // this Enter, or the Enter that picks an option (closing the listbox) would also assign.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [group, handleAssign]);

  return (
    <Box
      role="region"
      aria-label="Triage"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        gap: 2,
        px: 4,
        py: 2.5,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ minWidth: 180 }}>
        <GroupSelector
          label="Group"
          value={group}
          options={groups.data ?? []}
          loading={groups.isPending}
          onChange={setGroup}
          inputRef={groupInputRef}
          helperText="Shortcut: G"
        />
      </Box>
      <Box sx={{ minWidth: 180 }}>
        <UserSelector
          label="Owner"
          value={owner}
          options={eligibleOwners.data ?? []}
          loading={eligibleOwners.isPending}
          disabled={group === null}
          onChange={setOwner}
          inputRef={ownerInputRef}
          helperText={group === null ? 'Pick a group first' : 'Shortcut: O'}
        />
      </Box>
      <PrioritySelector value={priority} onChange={setPriority} />
      <Box sx={{ minWidth: 220, flex: 1 }}>
        <TagInput
          value={ticketTags}
          options={tags.data ?? []}
          onCreateTag={(name) => void createTag.mutateAsync({ name })}
          onChange={setTicketTags}
        />
      </Box>
      {triage.error !== undefined && (
        <Typography role="alert" variant="caption" color="error.main" sx={{ width: '100%' }}>
          {triage.error.message}
        </Typography>
      )}
      <Button type="button" variant="contained" onClick={() => void handleAssign()} disabled={group === null || triage.isPending}>
        Assign
        <Box component="span" aria-hidden sx={{ opacity: 0.7, fontSize: 10, ml: 0.75 }}>
          ↵
        </Box>
      </Button>
    </Box>
  );
}
