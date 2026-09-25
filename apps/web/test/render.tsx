import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { LiveRegionProvider } from '../src/components/foundations/LiveRegion';
import { ToastProvider } from '../src/components/shell/Toast';
import { lightTheme } from '../src/theme/theme';

import type { ReactElement, ReactNode } from 'react';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial URL, for pages that read route params or the query string. */
  route?: string;
}

/**
 * Renders inside the providers every area has (routes/index.tsx): theme, router, query client,
 * live region and toasts. Queries never retry here, so an error case fails on the first response.
 * The returned `queryClient` lets a test seed or read the cache.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const { route = '/', ...renderOptions } = options;
  const queryClient = new QueryClient({
    // No retries, so an error case settles on the first response; the default gcTime stays, or
    // data written for a query nobody observes yet (`setQueryData(['me'])`) is collected at once.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider theme={lightTheme}>
          <CssBaseline />
          <MemoryRouter initialEntries={[route]}>
            <LiveRegionProvider>
              <ToastProvider>{children}</ToastProvider>
            </LiveRegionProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...renderOptions }) };
}
