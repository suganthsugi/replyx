import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

import { useAnnounce } from '../foundations/LiveRegion';

/**
 * Transient confirmations and warnings ("Saved", "You no longer have access to this ticket").
 * One toast at a time, queued. Every toast is also announced through the area's LiveRegion
 * (ui-components rule 3); errors assertively. Must be inside a `LiveRegionProvider`.
 */

export type ToastSeverity = 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  message: string;
  severity?: ToastSeverity;
  action?: { label: string; onClick: () => void };
  /** Milliseconds; errors stay until dismissed. */
  duration?: number;
}

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | undefined>(undefined);

interface QueuedToast extends ToastOptions {
  id: number;
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const announce = useAnnounce();
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const [open, setOpen] = useState(true);
  const current = queue[0];

  const show = useCallback<ShowToast>(
    (options) => {
      nextId += 1;
      setQueue((items) => [...items, { ...options, id: nextId }]);
      announce(options.message, options.severity === 'error' ? 'assertive' : 'polite');
    },
    [announce],
  );

  const dismiss = () => setOpen(false);
  const next = () => {
    setQueue((items) => items.slice(1));
    setOpen(true);
  };

  const severity = current?.severity ?? 'info';
  return (
    <ToastContext.Provider value={show}>
      {children}
      {current !== undefined && (
        <Snackbar
          key={current.id}
          open={open}
          onClose={(_event, reason) => {
            if (reason !== 'clickaway') dismiss();
          }}
          autoHideDuration={current.duration ?? (severity === 'error' ? null : 5_000)}
          slotProps={{ transition: { onExited: next } }}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          {/* The LiveRegion already announced it: keep the visual alert out of the a11y live tree. */}
          <Alert
            severity={severity}
            variant="filled"
            role="presentation"
            onClose={dismiss}
            action={
              current.action === undefined ? undefined : (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    current.action?.onClick();
                    dismiss();
                  }}
                >
                  {current.action.label}
                </Button>
              )
            }
          >
            {current.message}
          </Alert>
        </Snackbar>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (show === undefined) throw new Error('useToast must be used inside a ToastProvider');
  return show;
}
