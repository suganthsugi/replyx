import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import { useId, type ReactNode } from 'react';

import { CloseIcon } from '../foundations/icons';

/**
 * A titled dialog. MUI traps focus inside while open and returns it to the trigger on close
 * (ui-components rule 4); Escape and the close button call `onClose`.
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons for the footer. */
  actions?: ReactNode;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg';
  /** While true, Escape, the backdrop and the close button do nothing (e.g. while saving). */
  busy?: boolean;
}

export function Modal({ open, onClose, title, children, actions, maxWidth = 'sm', busy = false }: ModalProps) {
  const titleId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog open={open} onClose={close} aria-labelledby={titleId} maxWidth={maxWidth} fullWidth>
      <DialogTitle id={titleId} sx={{ pr: 12 }}>
        {title}
      </DialogTitle>
      <IconButton aria-label="Close" onClick={close} disabled={busy} sx={{ position: 'absolute', right: 8, top: 8 }}>
        <CloseIcon />
      </IconButton>
      <DialogContent>{children}</DialogContent>
      {actions !== undefined && <DialogActions sx={{ px: 6, pb: 4 }}>{actions}</DialogActions>}
    </Dialog>
  );
}
