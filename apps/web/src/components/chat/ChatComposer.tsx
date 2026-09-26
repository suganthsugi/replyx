import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';

import { AttachIcon, CloseIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';

import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS_PER_MESSAGE, attachmentProblem } from './attachment-rules';

import type { ComposerAttachment } from './types';

/**
 * Where the customer writes. Enter sends, Shift+Enter starts a new line. "Attach a file" checks
 * type and size before anything uploads and says what's wrong in words. While the customer is
 * rate limited, sending waits with a countdown (the text stays, so nothing is lost).
 */

export interface ChatComposerProps {
  /** Sends the text (and the ready attachments, which the owner holds). */
  onSend: (body: string) => void;
  attachments: ComposerAttachment[];
  /** Files that passed the type and size checks; the owner uploads them. */
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  /** Epoch ms until which sending is paused after a `RATE_LIMITED` answer. */
  rateLimitedUntil?: number;
  /** Called as the customer types (the owner throttles the typing signal). */
  onTyping?: () => void;
  disabled?: boolean;
}

const MAX_BODY = 10_000;

export function ChatComposer({ onSend, attachments, onAttach, onRemoveAttachment, rateLimitedUntil, onTyping, disabled = false }: ChatComposerProps) {
  const [body, setBody] = useState('');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const noticeId = useId();
  const announce = useAnnounce();
  const secondsLeft = useCountdown(rateLimitedUntil);

  const rateLimited = secondsLeft > 0;
  const uploading = attachments.some((attachment) => attachment.status === 'uploading');
  const canSend = !disabled && !rateLimited && !uploading && body.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(body.trim());
    setBody('');
    setFileErrors([]);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
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

  const describedBy = [fileErrors.length > 0 ? errorId : undefined, rateLimited ? noticeId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <Box component="form" aria-label="Send a message" onSubmit={onSubmit} sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      {rateLimited && (
        <Typography id={noticeId} variant="caption" component="p" sx={{ px: 4, py: 2, bgcolor: 'warning.light', color: 'warning.main', textAlign: 'center' }}>
          You're sending messages a bit fast. You can send again in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}.
        </Typography>
      )}
      {fileErrors.length > 0 && (
        <Box id={errorId} sx={{ px: 4, pt: 2 }}>
          {fileErrors.map((problem) => (
            <Typography key={problem} variant="caption" component="p" color="error">
              {problem}
            </Typography>
          ))}
        </Box>
      )}
      {attachments.length > 0 && (
        <Box component="ul" aria-label="Attachments" sx={{ listStyle: 'none', m: 0, px: 4, pt: 2, display: 'flex', flexWrap: 'wrap', gap: 2 }}>
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
      <Box sx={{ display: 'flex', gap: 2, p: 3, alignItems: 'flex-end' }}>
        <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={onFiles} hidden tabIndex={-1} aria-hidden="true" />
        <IconButton aria-label="Attach a file" onClick={() => fileInput.current?.click()} disabled={disabled} sx={{ bgcolor: 'action.hover' }}>
          <AttachIcon fontSize="small" />
        </IconButton>
        <TextField
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            onTyping?.();
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a message…"
          multiline
          maxRows={6}
          fullWidth
          disabled={disabled}
          slotProps={{
            htmlInput: { 'aria-label': 'Message', maxLength: MAX_BODY, 'aria-describedby': describedBy },
          }}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: '12px', bgcolor: 'action.hover' } }}
        />
        <Button type="submit" variant="contained" disabled={!canSend} sx={{ flexShrink: 0 }}>
          Send
        </Button>
      </Box>
    </Box>
  );
}

/** Whole seconds until `until`, ticking down once a second; 0 once it has passed. */
function useCountdown(until: number | undefined): number {
  const remaining = () => (until === undefined ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  const [seconds, setSeconds] = useState(remaining);
  useEffect(() => {
    setSeconds(remaining());
    if (until === undefined || until <= Date.now()) return undefined;
    const timer = setInterval(() => {
      const next = remaining();
      setSeconds(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
    // `remaining` only reads `until`.
  }, [until]);
  return seconds;
}
