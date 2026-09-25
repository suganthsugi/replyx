import Box from '@mui/material/Box';

import type { ReactNode } from 'react';

/** Hides content visually while keeping it available to screen readers. */
export const visuallyHiddenStyle = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

export function VisuallyHidden({ children, component = 'span' }: { children: ReactNode; component?: 'span' | 'div' | 'h1' | 'h2' }) {
  return (
    <Box component={component} sx={visuallyHiddenStyle}>
      {children}
    </Box>
  );
}
