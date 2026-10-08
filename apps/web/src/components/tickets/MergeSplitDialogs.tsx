import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, useState } from 'react';

import { Modal } from '../shell/Modal';

/**
 * Merge and split dialogs for the ticket screen (US14, FR-039). They only collect the input and
 * show the server's error: the caller runs the mutation (`useMergeTicket` / `useSplitTicket`) and
 * resolves a ticket number to a ticket, so these stay free of data access.
 */

export interface MergeTicketDialogProps {
  open: boolean;
  sourceNumber: number;
  onClose: () => void;
  /** Merges into the ticket with this number; rejects with a readable message on failure. */
  onMerge: (targetNumber: number) => Promise<void>;
}

export function MergeTicketDialog({ open, sourceNumber, onClose, onMerge }: MergeTicketDialogProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  const close = () => {
    setValue('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    const number = Number(value.trim().replace(/^#/, ''));
    if (!Number.isInteger(number) || number <= 0) {
      setError('Enter the number of the ticket to merge into, like 1042.');
      return;
    }
    if (number === sourceNumber) {
      setError('Choose a different ticket to merge into.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onMerge(number);
      setValue('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The tickets could not be merged.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Merge #${sourceNumber} into another ticket`}
      busy={busy}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void submit()} disabled={busy || value.trim() === ''}>
            Merge
          </Button>
        </>
      }
    >
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        <Typography variant="body2" color="text.secondary">
          #{sourceNumber} will be closed and its messages shown in the other ticket. Both tickets must belong to the same customer.
        </Typography>
        <NumberField value={value} onChange={setValue} invalid={error !== null} describedBy={error === null ? undefined : errorId} />
        {error !== null && (
          <Typography id={errorId} role="alert" variant="body2" color="error">
            {error}
          </Typography>
        )}
      </Box>
    </Modal>
  );
}

/**
 * The merge target field. It focuses itself from its own mount effect: it mounts with the dialog
 * content (after MUI's Portal), and a descendant's effect runs ahead of the focus trap's, which
 * then leaves focus inside the panel alone (`autoFocus` loses to the trap; see ViewBuilder).
 */
function NumberField({ value, onChange, invalid, describedBy }: { value: string; onChange: (next: string) => void; invalid: boolean; describedBy?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <TextField
      label="Ticket number to merge into"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      inputRef={inputRef}
      error={invalid}
      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-describedby': describedBy } }}
    />
  );
}

export interface SplitCandidate {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export interface SplitTicketDialogProps {
  open: boolean;
  /** Public messages of the ticket, oldest first; internal notes can't be split. */
  messages: readonly SplitCandidate[];
  onClose: () => void;
  onSplit: (input: { messageId: string; title?: string }) => Promise<void>;
}

const PREVIEW_CHARS = 120;

export function SplitTicketDialog({ open, messages, onClose, onSplit }: SplitTicketDialogProps) {
  const [messageId, setMessageId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelId = useId();

  const close = () => {
    setMessageId('');
    setTitle('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (messageId === '') return;
    setBusy(true);
    setError(null);
    try {
      await onSplit({ messageId, ...(title.trim() === '' ? {} : { title: title.trim() }) });
      setMessageId('');
      setTitle('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The message could not be split.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Split a message into a new ticket"
      busy={busy}
      maxWidth="md"
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void submit()} disabled={busy || messageId === ''}>
            Split
          </Button>
        </>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {messages.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            This ticket has no customer-visible messages to split.
          </Typography>
        ) : (
          <>
            <Typography id={labelId} variant="body2" color="text.secondary">
              Choose the message that starts the new ticket. The customer&apos;s next message goes to the new ticket.
            </Typography>
            <RadioGroup aria-labelledby={labelId} value={messageId} onChange={(event) => setMessageId(event.target.value)} sx={{ gap: 1 }}>
              {messages.map((message) => (
                <FormControlLabel
                  key={message.id}
                  value={message.id}
                  control={<Radio />}
                  label={
                    <Box sx={{ py: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">
                        {message.authorName} · {new Date(message.createdAt).toLocaleString()}
                      </Typography>
                      <Typography variant="body2">{message.body.length > PREVIEW_CHARS ? `${message.body.slice(0, PREVIEW_CHARS)}…` : message.body}</Typography>
                    </Box>
                  }
                  sx={{ alignItems: 'flex-start', border: 1, borderColor: 'divider', borderRadius: 2, m: 0, pr: 2 }}
                />
              ))}
            </RadioGroup>
            <TextField
              label="New ticket title (optional)"
              helperText="Leave empty to use the first line of the message."
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 200 } }}
            />
          </>
        )}
        {error !== null && (
          <Typography role="alert" variant="body2" color="error">
            {error}
          </Typography>
        )}
      </Box>
    </Modal>
  );
}
