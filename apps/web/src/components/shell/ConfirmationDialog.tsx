import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState, type ReactNode } from 'react';

import { mapError, type UiError } from '../../data/errors';

import { Modal } from './Modal';

/**
 * Confirms a consequential action (delete, deactivate, erase). `onConfirm` may be async: the
 * dialog stays open and busy until it settles, closes on success and shows the mapped error on
 * failure. `requireText` makes the user type a word first (e.g. `ERASE`).
 */

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireText?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  requireText,
  onConfirm,
  onClose,
}: ConfirmationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | undefined>();
  const [typed, setTyped] = useState('');

  const reset = () => {
    setError(undefined);
    setTyped('');
  };
  const close = () => {
    reset();
    onClose();
  };
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      reset();
      onClose();
    } catch (caught) {
      setError(mapError(caught));
    } finally {
      setBusy(false);
    }
  };
  const blocked = requireText !== undefined && typed !== requireText;

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      busy={busy}
      maxWidth="xs"
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant="contained"
            color={destructive ? 'error' : 'primary'}
            onClick={() => void confirm()}
            disabled={busy || blocked}
            aria-busy={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typeof message === 'string' ? <Typography>{message}</Typography> : message}
      {requireText !== undefined && (
        <TextField
          label={`Type ${requireText} to confirm`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          fullWidth
          margin="normal"
          disabled={busy}
        />
      )}
      {error !== undefined && (
        <Alert severity="error" sx={{ mt: 4 }}>
          {error.message}
        </Alert>
      )}
    </Modal>
  );
}
