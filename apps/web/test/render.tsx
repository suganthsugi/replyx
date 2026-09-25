import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';

import { LiveRegionProvider } from '../src/components/foundations/LiveRegion';
import { ToastProvider } from '../src/components/shell/Toast';
import { lightTheme } from '../src/theme/theme';

import type { ReactElement, ReactNode } from 'react';

/** Renders inside the providers every area has: theme, live region and toasts. */
export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider theme={lightTheme}>
        <CssBaseline />
        <LiveRegionProvider>
          <ToastProvider>{children}</ToastProvider>
        </LiveRegionProvider>
      </ThemeProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}
