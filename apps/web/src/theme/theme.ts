/**
 * Builds the MUI theme from the design tokens (`tokens.ts`) and an optional resolved brand
 * accent (`brand-accent.ts`). Components must read colors/spacing/type through this theme
 * (`useTheme`, `sx`), never import `tokens.ts` directly (see the `ui-components` skill).
 */

import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';

import { defaultSurfacesForMode, resolveBrandAccent } from './brand-accent';
import { colorTokens, elevationTokens, radiusTokens, spacingTokens, typeScaleTokens } from './tokens';

export type ColorMode = 'light' | 'dark';

const reducedMotionOverride = {
  '@media (prefers-reduced-motion: reduce)': {
    '*, *::before, *::after': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important',
      scrollBehavior: 'auto !important',
    },
  },
};

function focusVisibleOutline(mode: ColorMode) {
  const color = mode === 'dark' ? colorTokens.focusRingOnDark : colorTokens.focusRing;
  return { outline: `2px solid ${color}`, outlineOffset: 2 };
}

function paletteForMode(mode: ColorMode, primaryMain: string): ThemeOptions['palette'] {
  const surfaces = defaultSurfacesForMode(mode);

  // MUI picks `contrastText` for colors without one by this ratio; its default (3) is below
  // WCAG AA for normal text.
  const contrastThreshold = 4.5;

  if (mode === 'dark') {
    return {
      mode,
      contrastThreshold,
      primary: { main: primaryMain, contrastText: surfaces.onAccentText },
      secondary: { main: colorTokens.accent.light, contrastText: colorTokens.neutral[950] },
      success: { main: colorTokens.success.light },
      warning: { main: colorTokens.warning.light },
      error: { main: colorTokens.danger.light },
      background: {
        default: colorTokens.neutral[950],
        paper: colorTokens.neutral[900],
      },
      text: {
        primary: colorTokens.neutral[50],
        secondary: colorTokens.neutral[300],
      },
      divider: colorTokens.neutral[800],
    };
  }

  return {
    mode,
    contrastThreshold,
    primary: { main: primaryMain, contrastText: surfaces.onAccentText },
    // White on the coral accent is ~3.3:1; dark text reaches AA.
    secondary: { main: colorTokens.accent.main, contrastText: colorTokens.neutral[950] },
    success: { main: colorTokens.success.main },
    warning: { main: colorTokens.warning.main },
    error: { main: colorTokens.danger.main },
    background: {
      default: colorTokens.neutral[50],
      paper: colorTokens.neutral[0],
    },
    text: {
      primary: colorTokens.neutral[900],
      secondary: colorTokens.neutral[600],
    },
    divider: colorTokens.neutral[200],
  };
}

/**
 * Creates the app theme for a color mode, optionally with a tenant brand accent.
 *
 * `tenantColor` is the raw, untrusted hex string from tenant settings (or `undefined`). It is
 * resolved to an AA-compliant shade via `resolveBrandAccent` before being used as
 * `palette.primary.main` — callers never need to validate or adjust it themselves.
 */
export function createAppTheme(mode: ColorMode, tenantColor?: string | null): Theme {
  const surfaces = defaultSurfacesForMode(mode);
  const { color: primaryMain } = resolveBrandAccent(tenantColor, mode, surfaces);

  return createTheme({
    palette: paletteForMode(mode, primaryMain),

    typography: {
      fontFamily: typeScaleTokens.fontFamily.base,
      fontWeightRegular: typeScaleTokens.fontWeight.regular,
      fontWeightMedium: typeScaleTokens.fontWeight.medium,
      fontWeightBold: typeScaleTokens.fontWeight.bold,
      h3: { fontSize: typeScaleTokens.size.h3, fontWeight: typeScaleTokens.fontWeight.semibold, lineHeight: typeScaleTokens.lineHeight.tight },
      h4: { fontSize: typeScaleTokens.size.h4, fontWeight: typeScaleTokens.fontWeight.semibold, lineHeight: typeScaleTokens.lineHeight.tight },
      h5: { fontSize: typeScaleTokens.size.h5, fontWeight: typeScaleTokens.fontWeight.semibold, lineHeight: typeScaleTokens.lineHeight.tight },
      h6: { fontSize: typeScaleTokens.size.h6, fontWeight: typeScaleTokens.fontWeight.semibold, lineHeight: typeScaleTokens.lineHeight.normal },
      subtitle1: { fontSize: typeScaleTokens.size.subtitle, fontWeight: typeScaleTokens.fontWeight.medium, lineHeight: typeScaleTokens.lineHeight.normal },
      body1: { fontSize: typeScaleTokens.size.body1, fontWeight: typeScaleTokens.fontWeight.regular, lineHeight: typeScaleTokens.lineHeight.relaxed },
      body2: { fontSize: typeScaleTokens.size.body2, fontWeight: typeScaleTokens.fontWeight.regular, lineHeight: typeScaleTokens.lineHeight.normal },
      caption: { fontSize: typeScaleTokens.size.caption, fontWeight: typeScaleTokens.fontWeight.regular, lineHeight: typeScaleTokens.lineHeight.normal },
      button: { fontWeight: typeScaleTokens.fontWeight.medium, textTransform: 'none' },
    },

    spacing: spacingTokens.unit,

    shape: {
      borderRadius: radiusTokens.md,
    },

    shadows: [
      elevationTokens.flat,
      elevationTokens.raised,
      elevationTokens.raised,
      elevationTokens.raised,
      elevationTokens.overlay,
      elevationTokens.overlay,
      elevationTokens.overlay,
      elevationTokens.overlay,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
      elevationTokens.modal,
    ],

    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ...reducedMotionOverride,
          body: {
            backgroundColor: mode === 'dark' ? colorTokens.neutral[950] : colorTokens.neutral[50],
          },
        },
      },

      // Visible focus ring for every interactive control built on ButtonBase (Button, IconButton,
      // MenuItem, Tab, ListItemButton, ...), so keyboard focus is never invisible (FR-071a).
      MuiButtonBase: {
        defaultProps: {
          disableRipple: false,
        },
        styleOverrides: {
          root: {
            '&.Mui-focusVisible': focusVisibleOutline(mode),
          },
        },
      },

      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderColor: mode === 'dark' ? colorTokens.focusRingOnDark : colorTokens.focusRing,
              borderWidth: 2,
            },
          },
        },
      },

      // Native inputs/links/anything with a focus-visible pseudo-class that ButtonBase doesn't
      // cover (e.g. links rendered by MuiLink).
      MuiLink: {
        styleOverrides: {
          root: {
            '&:focus-visible': focusVisibleOutline(mode),
          },
        },
      },

      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: radiusTokens.sm,
          },
        },
      },

      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: radiusTokens.pill,
          },
        },
      },

      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },

      MuiTooltip: {
        defaultProps: {
          arrow: true,
        },
      },
    },
  });
}

export const lightTheme = createAppTheme('light');
export const darkTheme = createAppTheme('dark');
