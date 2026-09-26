import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS_PER_MESSAGE, attachmentProblem } from '../chat/attachment-rules';
import { AttachIcon, CloseIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';

import type { ComposerAttachment } from '../chat/types';

/**
 * Where staff write on a ticket (docs/design-system "Workspace Inbox", the composer and status
 * strip controls). Reply and internal note are never told apart by colour alone: the mode toggle
 * carries a distinct label and icon, and the text area itself takes a tinted background in note
 * mode. Typing `@` opens a listbox of the staff who can see the ticket (`mentionCandidates`,
 * passed in by the caller — this component never fetches who can view anything).
 */

export type ComposerMode = 'reply' | 'note';

export interface MentionCandidate {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface MessageComposerProps {
  /** Sends the written text in the current mode; the caller decides what that means (visibility). */
  onSend: (body: string, mode: ComposerMode) => void;
  attachments: ComposerAttachment[];
  /** Files that passed the type and size checks; the caller uploads them. */
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  /** Staff who can view this ticket; the `@name` picker's candidate list. */
  mentionCandidates: readonly MentionCandidate[];
  defaultMode?: ComposerMode;
  disabled?: boolean;
}

const MAX_BODY = 10_000;
const MAX_MENTION_RESULTS = 8;

interface MentionQuery {
  /** Index of the `@` that opened the query. */
  start: number;
  query: string;
  activeIndex: number;
}

export function MessageComposer({
  onSend,
  attachments,
  onAttach,
  onRemoveAttachment,
  mentionCandidates,
  defaultMode = 'reply',
  disabled = false,
}: MessageComposerProps) {
  const [mode, setMode] = useState<ComposerMode>(defaultMode);
  const [body, setBody] = useState('');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldWrapper = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const errorId = useId();
  const listboxId = useId();
  const announce = useAnnounce();

  const uploading = attachments.some((attachment) => attachment.status === 'uploading');
  const canSend = !disabled && !uploading && body.trim().length > 0;

  const mentionResults = useMemo(() => {
    if (mention === null) return [];
    const query = mention.query.toLowerCase();
    return mentionCandidates.filter((candidate) => candidate.name.toLowerCase().includes(query)).slice(0, MAX_MENTION_RESULTS);
  }, [mention, mentionCandidates]);
  const mentionOpen = mention !== null;
  const activeOptionId = mentionOpen && mentionResults.length > 0 ? `${listboxId}-option-${mention.activeIndex}` : undefined;

  const send = () => {
    if (!canSend) return;
    onSend(body.trim(), mode);
    setBody('');
    setFileErrors([]);
    setMention(null);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const insertMention = (candidate: MentionCandidate) => {
    if (mention === null) return;
    const caretEnd = mention.start + 1 + mention.query.length;
    const inserted = `@${candidate.name} `;
    const next = `${body.slice(0, mention.start)}${inserted}${body.slice(caretEnd)}`;
    setBody(next);
    setMention(null);
    const caret = mention.start + inserted.length;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
      textareaRef.current?.focus();
    });
  };

  const onBodyChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setBody(next);
    const caret = event.target.selectionStart ?? next.length;
    setMention(findMentionQuery(next, caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mention !== null && mentionResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMention({ ...mention, activeIndex: (mention.activeIndex + 1) % mentionResults.length });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMention({ ...mention, activeIndex: (mention.activeIndex - 1 + mentionResults.length) % mentionResults.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = mentionResults[mention.activeIndex];
        if (candidate !== undefined) insertMention(candidate);
        return;
      }
    }
    if (mention !== null && event.key === 'Escape') {
      event.preventDefault();
      setMention(null);
    }
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of picked) {
      const problem = attachmentProblem(file);
      if (problem !== undefined) problems.push(problem);
      else if (accepted.length < room) accepted.push(file);
      else problems.push(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
    }
    setFileErrors([...new Set(problems)]);
    if (problems.length > 0) announce(problems.join(' '), 'assertive');
    if (accepted.length > 0) onAttach(accepted);
  };

  const describedBy = fileErrors.length > 0 ? errorId : undefined;
  const noteMode = mode === 'note';

  return (
    <Box
      component="form"
      aria-label={noteMode ? 'Add an internal note' : 'Reply to the customer'}
      onSubmit={onSubmit}
      sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <ToggleButtonGroup
        value={mode}
        exclusive
        disabled={disabled}
        size="small"
        aria-label="Message type"
        onChange={(_event: MouseEvent<HTMLElement>, next: ComposerMode | null) => {
          if (next !== null) setMode(next);
        }}
      >
        <ToggleButton value="reply">
          <ReplyIcon fontSize="small" sx={{ mr: 1 }} />
          Reply
        </ToggleButton>
        <ToggleButton value="note">
          <NoteIcon fontSize="small" sx={{ mr: 1 }} />
          Internal note
        </ToggleButton>
      </ToggleButtonGroup>

      {noteMode && (
        <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
          Only visible to staff, not the customer.
        </Typography>
      )}

      {fileErrors.length > 0 && (
        <Box id={errorId}>
          {fileErrors.map((problem) => (
            <Typography key={problem} variant="caption" component="p" color="error">
              {problem}
            </Typography>
          ))}
        </Box>
      )}

      {attachments.length > 0 && (
        <Box component="ul" aria-label="Attachments" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {attachments.map((attachment) => (
            <Box component="li" key={attachment.localId} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, maxWidth: 240 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  pl: 3,
                  borderRadius: '9999px',
                  border: 1,
                  borderColor: attachment.status === 'failed' ? 'error.main' : 'divider',
                  bgcolor: 'action.hover',
                }}
              >
                <Typography variant="caption" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {attachment.fileName}
                </Typography>
                <IconButton size="small" aria-label={`Remove ${attachment.fileName}`} onClick={() => onRemoveAttachment(attachment.localId)}>
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
              {attachment.status === 'uploading' && (
                <LinearProgress variant="determinate" value={attachment.progress} aria-label={`Uploading ${attachment.fileName}`} />
              )}
              {attachment.status === 'failed' && attachment.error !== undefined && (
                <Typography variant="caption" color="error">
                  {attachment.error}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      )}

      <Box ref={fieldWrapper} sx={{ position: 'relative' }}>
        <TextField
          value={body}
          onChange={onBodyChange}
          onKeyDown={onKeyDown}
          placeholder={noteMode ? 'Add an internal note (not visible to the customer)…' : 'Type a reply to the customer…'}
          multiline
          minRows={2}
          maxRows={8}
          fullWidth
          disabled={disabled}
          inputRef={textareaRef}
          slotProps={{
            htmlInput: {
              role: 'combobox',
              'aria-label': noteMode ? 'Internal note' : 'Reply',
              'aria-expanded': mentionOpen,
              'aria-controls': mentionOpen ? listboxId : undefined,
              'aria-activedescendant': activeOptionId,
              'aria-autocomplete': 'list',
              'aria-describedby': describedBy,
              maxLength: MAX_BODY,
            },
          }}
          sx={{ '& .MuiOutlinedInput-root': { bgcolor: noteMode ? 'warning.light' : 'action.hover' } }}
        />
        <Popper open={mentionOpen} anchorEl={fieldWrapper.current} placement="top-start" style={{ width: fieldWrapper.current?.clientWidth, zIndex: 1300 }}>
          <Paper variant="outlined" sx={{ mb: 1, maxHeight: 240, overflowY: 'auto' }}>
            <Box component="ul" role="listbox" id={listboxId} aria-label="Mention a staff member" sx={{ listStyle: 'none', m: 0, p: 1 }}>
              {mentionResults.length === 0 ? (
                <Box component="li" sx={{ px: 2, py: 1.5 }}>
                  <Typography variant="body2" color="text.secondary">
                    No one matches “{mention?.query}”.
                  </Typography>
                </Box>
              ) : (
                mentionResults.map((candidate, index) => (
                  <Box
                    component="li"
                    key={candidate.id}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === mention?.activeIndex}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(candidate);
                    }}
                    sx={{
                      px: 2,
                      py: 1.5,
                      borderRadius: 1,
                      cursor: 'pointer',
                      bgcolor: index === mention?.activeIndex ? 'action.selected' : 'transparent',
                    }}
                  >
                    <Typography variant="body2">{candidate.name}</Typography>
                  </Box>
                ))
              )}
            </Box>
          </Paper>
        </Popper>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'space-between' }}>
        <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={onFiles} hidden tabIndex={-1} aria-hidden="true" />
        <IconButton aria-label="Attach a file" onClick={() => fileInput.current?.click()} disabled={disabled} sx={{ bgcolor: 'action.hover' }}>
          <AttachIcon fontSize="small" />
        </IconButton>
        <Button type="submit" variant="contained" disabled={!canSend} sx={{ flexShrink: 0 }}>
          {noteMode ? 'Add note' : 'Send reply'}
        </Button>
      </Box>
    </Box>
  );
}

/**
 * The `@name` query around `caret`, or `null` when the caret isn't inside one. A query starts at
 * an `@` that is either the first character or preceded by whitespace, and runs to the caret
 * without any whitespace in between.
 */
function findMentionQuery(value: string, caret: number): MentionQuery | null {
  let index = caret;
  while (index > 0) {
    const char = value[index - 1];
    if (char === undefined) return null;
    if (char === '@') {
      const before = value[index - 2];
      if (index - 1 > 0 && before !== undefined && !/\s/.test(before)) return null;
      return { start: index - 1, query: value.slice(index, caret), activeIndex: 0 };
    }
    if (/\s/.test(char)) return null;
    index -= 1;
  }
  return null;
}

function ReplyIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
    </SvgIcon>
  );
}

function NoteIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5L13 3.5zM7 12h10v1.5H7V12zm0 4h10v1.5H7V16zm0-8h6v1.5H7V8z" />
    </SvgIcon>
  );
}
