import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { Skeleton } from '../components/foundations/Skeleton';
import { lightTheme } from '../theme/theme';

import { isConsoleHost, WORKSPACE_BASE } from './area';

/**
 * The three route areas (research D21), each `React.lazy` so an audience downloads only its own
 * code: the customer bundle never contains workspace or console modules.
 */

const CustomerArea = lazy(() => import('./CustomerArea'));
const WorkspaceArea = lazy(() => import('./WorkspaceArea'));
const ConsoleArea = lazy(() => import('./ConsoleArea'));

/** Picks the area from the host, then the path. Must render inside a router. */
export function AreaRoutes({ hostname }: { hostname: string }) {
  return (
    <Suspense fallback={<Skeleton variant="block" label="page" />}>
      {isConsoleHost(hostname) ? (
        <Routes>
          <Route path="/*" element={<ConsoleArea />} />
        </Routes>
      ) : (
        <Routes>
          <Route path={`${WORKSPACE_BASE}/*`} element={<WorkspaceArea />} />
          <Route path="/*" element={<CustomerArea />} />
        </Routes>
      )}
    </Suspense>
  );
}

export function App({ queryClient, hostname = window.location.hostname }: { queryClient: QueryClient; hostname?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={lightTheme}>
        <CssBaseline />
        <BrowserRouter>
          <AreaRoutes hostname={hostname} />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
