/**
 * Design tokens: the raw values the theme is built from.
 *
 * These are an original palette and scale (constitution XI) — not a copy of Zammad's or any
 * other product's look. Components must not import this module directly; they read colors,
 * spacing and type through the MUI theme (`useTheme`, `sx`). See `theme.ts`.
 */

/** Base hue: an ink/indigo neutral paired with a warm coral accent, distinct from typical
 * helpdesk blue-on-grey palettes. */
export const colorTokens = {
  primary: {
    lightest: '#EEF0FF',
    light: '#8B93F8',
    main: '#4B4FE0',
    dark: '#3538A8',
    darkest: '#23256E',
  },
  accent: {
    lightest: '#FFEFE8',
    light: '#FF9E78',
    main: '#F45B3B',
    dark: '#C23F24',
  },
  success: {
    light: '#7FE0B4',
    main: '#1F9D6B',
    dark: '#136B49',
  },
  warning: {
    light: '#FFD98A',
    main: '#C9820A',
    dark: '#8F5B02',
  },
  danger: {
    light: '#FFAFAA',
    main: '#D93B34',
    dark: '#9C221D',
  },
  neutral: {
    0: '#FFFFFF',
    50: '#F7F7FB',
    100: '#EDEEF5',
    200: '#DDDFEA',
    300: '#C2C4D6',
    400: '#9799B3',
    500: '#6F7191',
    600: '#54566F',
    700: '#3D3F55',
    800: '#282A3D',
    900: '#181927',
    950: '#0D0E17',
  },
  focusRing: '#4B4FE0',
  /** On dark surfaces the default ring is under 3:1; this one is ~6.4:1 (WCAG 1.4.11). */
  focusRingOnDark: '#8B93F8',
} as const;

/** Type scale: a single modular scale shared by both the workspace and the customer chat. */
export const typeScaleTokens = {
  fontFamily: {
    base: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  size: {
    caption: '0.75rem', // 12px
    body2: '0.8125rem', // 13px
    body1: '0.9375rem', // 15px
    subtitle: '1.0625rem', // 17px
    h6: '1.25rem', // 20px
    h5: '1.5rem', // 24px
    h4: '1.875rem', // 30px
    h3: '2.25rem', // 36px
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.7,
  },
} as const;

/** Spacing unit in px; MUI's `spacing()` multiplies this by the factor passed at each call
 * site (e.g. `theme.spacing(2)` => 8px). */
export const spacingTokens = {
  unit: 4,
} as const;

/** Corner radii, in px. */
export const radiusTokens = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Elevation: box-shadow recipes keyed the same way MUI keys `theme.shadows[n]`, but named for
 * where they're used so component code reads intent, not an index. */
export const elevationTokens = {
  flat: 'none',
  raised: '0 1px 2px rgba(13, 14, 23, 0.06), 0 1px 1px rgba(13, 14, 23, 0.04)',
  overlay: '0 4px 12px rgba(13, 14, 23, 0.10), 0 2px 4px rgba(13, 14, 23, 0.06)',
  modal: '0 16px 40px rgba(13, 14, 23, 0.18), 0 4px 10px rgba(13, 14, 23, 0.08)',
} as const;

/** Motion: durations/easings used by transitions; components respect
 * `prefers-reduced-motion` via the global override in `theme.ts`, not by reading these directly. */
export const motionTokens = {
  duration: {
    fast: 120,
    base: 180,
    slow: 260,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;

/**
 * The design system for screens built from Phase 5 on (docs/design-system/README.md): a
 * teal/slate palette, Sora headings, pill buttons and chips, borders instead of shadows. Phase
 * 1–4 screens keep the tokens above until a retheme task; `createDesignSystemTheme` builds from
 * these and is applied through `DesignSystemScope`.
 */
export const designSystemTokens = {
  color: {
    light: {
      pageBg: '#F1F5F9',
      bg: '#F8FAFC',
      surface: '#FFFFFF',
      surface2: '#F1F5F9',
      border: '#E2E8F0',
      textPrimary: '#0F172A',
      textSecondary: '#475569',
      primary: '#0D9488',
      primaryContrast: '#FFFFFF',
      primarySoft: '#CCFBF1',
      warningText: '#92400E',
      warningSoft: '#FEF3C7',
      errorText: '#991B1B',
      errorSoft: '#FEE2E2',
      successText: '#047857',
      successSoft: '#D1FAE5',
    },
    dark: {
      pageBg: '#0B1120',
      bg: '#0B1120',
      surface: '#0F172A',
      surface2: '#1E293B',
      border: '#1E293B',
      textPrimary: '#F1F5F9',
      textSecondary: '#94A3B8',
      primary: '#2DD4BF',
      primaryContrast: '#0F172A',
      primarySoft: '#134E4A',
      warningText: '#FBBF24',
      warningSoft: '#3F2D0B',
      errorText: '#F87171',
      errorSoft: '#3F1417',
      successText: '#34D399',
      successSoft: '#0B2E22',
    },
  },
  type: {
    heading: '"Sora", "Inter", "Segoe UI", system-ui, sans-serif',
    base: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
    size: {
      timestamp: '0.625rem', // 10px
      meta: '0.75rem', // 12px
      body: '0.8125rem', // 13px, workspace body
      bodyChat: '0.875rem', // 14px, customer chat body
      paneTitle: '0.9375rem', // 15px
      title: '1rem', // 16px
      cardTitle: '1.1875rem', // 19px
      pageTitle: '1.375rem', // 22px
    },
    sectionLabel: { size: '0.75rem', weight: 600, letterSpacing: '0.04em' },
  },
  radius: {
    control: 8,
    card: 12,
    shell: 16,
    pill: 9999,
  },
  elevation: {
    shell: '0 8px 24px rgba(0, 0, 0, 0.08)',
  },
} as const;

export const tokens = {
  color: colorTokens,
  type: typeScaleTokens,
  spacing: spacingTokens,
  radius: radiusTokens,
  elevation: elevationTokens,
  motion: motionTokens,
} as const;

export type Tokens = typeof tokens;
