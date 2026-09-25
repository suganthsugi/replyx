import Box from '@mui/material/Box';
import { ThemeProvider } from '@mui/material/styles';
import { useMemo } from 'react';

import { createDesignSystemTheme, type ColorMode } from '../../theme/theme';

import type { ReactNode } from 'react';

/**
 * Puts the screens built from Phase 5 on under the design-system theme (ui-components rule 9)
 * without touching the global theme that Phase 1–4 screens use. It also paints the page
 * background, since `CssBaseline` sits outside and keeps the older theme's color.
 */
export function DesignSystemScope({
  children,
  mode = 'light',
  tenantColor,
  fill = true,
}: {
  children: ReactNode;
  mode?: ColorMode;
  tenantColor?: string | null;
  /** Paints a full-height page background; `false` for part of a page, like the admin rail. */
  fill?: boolean;
}) {
  const theme = useMemo(() => createDesignSystemTheme(mode, tenantColor), [mode, tenantColor]);
  return (
    <ThemeProvider theme={theme}>
      <Box sx={fill ? { bgcolor: 'background.default', color: 'text.primary', minHeight: '100vh', typography: 'body2' } : { display: 'contents' }}>
        {children}
      </Box>
    </ThemeProvider>
  );
}
