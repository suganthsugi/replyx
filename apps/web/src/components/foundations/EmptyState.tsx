import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import type { ReactNode } from 'react';

/**
 * The empty and error branches of every data-bearing component (ui-components rule 2). The
 * error variant renders the mapped `UiError` message with a retry action, never a raw error.
 */

export interface EmptyStateProps {
  variant?: 'empty' | 'error';
  title: string;
  message?: string;
  /** Primary action, e.g. "Create a view". */
  action?: { label: string; onClick: () => void };
  /** Error variant: shows a "Try again" button. */
  onRetry?: () => void;
  icon?: ReactNode;
  /** Heading level for `title` within the page outline; `1` when the state is the whole page. */
  headingLevel?: 1 | 2 | 3 | 4;
}

export function EmptyState({ variant = 'empty', title, message, action, onRetry, icon, headingLevel = 2 }: EmptyStateProps) {
  return (
    <Box
      role={variant === 'error' ? 'alert' : undefined}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 2, py: 8, px: 4 }}
    >
      {icon !== undefined && (
        <Box aria-hidden="true" sx={{ color: variant === 'error' ? 'error.main' : 'text.secondary' }}>
          {icon}
        </Box>
      )}
      <Typography component={`h${headingLevel}`} variant="h6">
        {title}
      </Typography>
      {message !== undefined && (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
          {message}
        </Typography>
      )}
      {(action !== undefined || (variant === 'error' && onRetry !== undefined)) && (
        <Box sx={{ display: 'flex', gap: 2 }}>
          {variant === 'error' && onRetry !== undefined && (
            <Button variant="contained" onClick={onRetry}>
              Try again
            </Button>
          )}
          {action !== undefined && (
            <Button variant={variant === 'error' ? 'text' : 'contained'} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}
