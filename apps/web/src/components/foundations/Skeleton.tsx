import Box from '@mui/material/Box';
import MuiSkeleton from '@mui/material/Skeleton';

import { VisuallyHidden } from './VisuallyHidden';

/**
 * The loading branch of data-bearing components (ui-components rule 2): placeholder shapes that
 * match the content's layout, announced once as "Loading …" to screen readers.
 */

export interface SkeletonProps {
  variant?: 'list' | 'text' | 'block';
  rows?: number;
  /** What is loading, e.g. "tickets"; announced as "Loading tickets". */
  label?: string;
}

export function Skeleton({ variant = 'text', rows = 3, label }: SkeletonProps) {
  return (
    <Box role="status" aria-busy="true" sx={{ display: 'flex', flexDirection: 'column', gap: 2, py: 2 }}>
      <VisuallyHidden>{label === undefined ? 'Loading' : `Loading ${label}`}</VisuallyHidden>
      {variant === 'block' ? (
        <MuiSkeleton variant="rounded" height={160} aria-hidden="true" />
      ) : (
        Array.from({ length: rows }, (_, index) =>
          variant === 'list' ? (
            <Box key={index} aria-hidden="true" sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <MuiSkeleton variant="circular" width={32} height={32} />
              <Box sx={{ flex: 1 }}>
                <MuiSkeleton variant="text" width="60%" />
                <MuiSkeleton variant="text" width="35%" />
              </Box>
            </Box>
          ) : (
            <MuiSkeleton key={index} variant="text" width={index === rows - 1 ? '70%' : '100%'} aria-hidden="true" />
          ),
        )
      )}
    </Box>
  );
}
