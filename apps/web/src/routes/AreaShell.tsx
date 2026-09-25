import Box from '@mui/material/Box';
import { useLocation } from 'react-router';

import { EmptyState } from '../components/foundations/EmptyState';
import { LiveRegionProvider } from '../components/foundations/LiveRegion';
import { ErrorBoundary } from '../components/shell/ErrorBoundary';
import { ToastProvider } from '../components/shell/Toast';

import type { ReactNode } from 'react';

/**
 * What every route area has: its own live region and toasts (ui-components rule 3: one region
 * per area) and an error boundary that resets when the route changes.
 */
export function AreaShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <LiveRegionProvider>
      <ToastProvider>
        <ErrorBoundary resetKeys={[pathname]}>{children}</ErrorBoundary>
      </ToastProvider>
    </LiveRegionProvider>
  );
}

/** The page for an unknown path inside an area. */
export function NotFoundPage() {
  return (
    <Box component="main" sx={{ py: 8 }}>
      <EmptyState title="Page not found" message="Check the address, or go back to the previous page." headingLevel={2} />
    </Box>
  );
}
