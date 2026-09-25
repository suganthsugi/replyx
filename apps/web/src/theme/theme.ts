/**
 * Builds the MUI theme from the design tokens (`tokens.ts`) and an optional resolved brand
 * accent (`brand-accent.ts`). Components must read colors/spacing/type through this theme
 * (`useTheme`, `sx`), never import `tokens.ts` directly (see the `ui-components` skill).
 */

import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';

import {
  AA_NORMAL_TEXT_CONTRAST,
  CONTRAST_SAFETY_MARGIN,
  defaultSurfacesForMode,
  nearestAACompliantShade,
  resolveBrandAccent,
} from './brand-accent';
import { colorTokens, designSystemTokens, elevationTokens, radiusTokens, spacingTokens, typeScaleTokens } from './tokens';

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
          // `error.main` reaches AA on white but not on the page background, which is where
          // destructive text buttons sit (a row of a table). The darker shade passes on both.
          textError: {
            color: mode === 'dark' ? colorTokens.danger.light : colorTokens.danger.dark,
          },
          outlinedError: {
            color: mode === 'dark' ? colorTokens.danger.light : colorTokens.danger.dark,
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

/**
 * The design-system variant of `createAppTheme` for screens built from Phase 5 on
 * (docs/design-system/README.md, ui-components rule 9). Same contract: the tenant accent goes
 * through `resolveBrandAccent`, starting from the design system's teal, so button text and
 * links reach AA even where the mock's white-on-teal would not. Apply it with
 * `DesignSystemScope`, never globally.
 */
export function createDesignSystemTheme(mode: ColorMode, tenantColor?: string | null): Theme {
  const c = designSystemTokens.color[mode];
  const type = designSystemTokens.type;
  const radius = designSystemTokens.radius;
  const surfaces = { surface: c.surface, onAccentText: c.primaryContrast };
  const { color: resolved } = resolveBrandAccent(tenantColor, mode, surfaces, c.primary);
  // Links and text buttons sit on the page background too, not only on white panes.
  const primaryMain = nearestAACompliantShade(resolved, c.pageBg, AA_NORMAL_TEXT_CONTRAST + CONTRAST_SAFETY_MARGIN);
  const focusRing = { outline: `2px solid ${primaryMain}`, outlineOffset: 2 };
  const heading = { fontFamily: type.heading, fontWeight: 600, lineHeight: 1.3 };

  return createTheme({
    palette: {
      mode,
      contrastThreshold: 4.5,
      primary: { main: primaryMain, contrastText: c.primaryContrast, light: c.primarySoft },
      success: { main: c.successText, light: c.successSoft, contrastText: c.surface },
      warning: { main: c.warningText, light: c.warningSoft, contrastText: c.surface },
      error: { main: c.errorText, light: c.errorSoft, contrastText: c.surface },
      background: { default: c.pageBg, paper: c.surface },
      text: { primary: c.textPrimary, secondary: c.textSecondary },
      divider: c.border,
      action: { hover: c.surface2, selected: c.primarySoft },
    },

    typography: {
      fontFamily: type.base,
      fontSize: 13,
      h1: { ...heading, fontSize: type.size.pageTitle, fontWeight: 700 },
      h2: { ...heading, fontSize: type.size.title },
      h3: { ...heading, fontSize: type.size.paneTitle },
      h4: { ...heading, fontSize: type.size.pageTitle, fontWeight: 700 },
      h5: { ...heading, fontSize: type.size.cardTitle },
      h6: { ...heading, fontSize: type.size.paneTitle },
      subtitle1: { fontSize: type.size.title, fontWeight: 600 },
      subtitle2: { fontSize: type.size.body, fontWeight: 600 },
      body1: { fontSize: type.size.bodyChat, lineHeight: 1.55 },
      body2: { fontSize: type.size.body, lineHeight: 1.5 },
      caption: { fontSize: type.size.meta, lineHeight: 1.4 },
      overline: {
        fontSize: type.sectionLabel.size,
        fontWeight: type.sectionLabel.weight,
        letterSpacing: type.sectionLabel.letterSpacing,
        lineHeight: 1.4,
        textTransform: 'uppercase',
      },
      button: { fontWeight: 600, textTransform: 'none' },
    },

    spacing: spacingTokens.unit,
    shape: { borderRadius: radius.control },
    // Borders separate; only the outer shell casts a shadow (`shadows[1]`).
    shadows: ['none', designSystemTokens.elevation.shell, ...Array<string>(23).fill(designSystemTokens.elevation.shell)] as Theme['shadows'],

    components: {
      MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': focusRing } } },
      MuiLink: { styleOverrides: { root: { '&:focus-visible': focusRing } } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { borderRadius: radius.pill, paddingInline: 16 } },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: radius.pill, fontWeight: 600 },
          filled: { backgroundColor: c.surface2, color: c.textPrimary },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: radius.control,
            backgroundColor: c.surface,
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: primaryMain, borderWidth: 2 },
          },
          notchedOutline: { borderColor: c.border },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' }, outlined: { borderColor: c.border, borderRadius: radius.card } },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: c.border },
          head: { fontSize: type.sectionLabel.size, fontWeight: 600, letterSpacing: type.sectionLabel.letterSpacing, textTransform: 'uppercase', color: c.textSecondary },
        },
      },
      MuiDialog: { styleOverrides: { paper: { borderRadius: radius.shell } } },
      MuiTooltip: { defaultProps: { arrow: true } },
    },
  });
}
