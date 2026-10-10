import Box, { type BoxProps } from '@mui/material/Box';

/**
 * The ReplyX mark: a chat bubble holding an X. Its colors are fixed (the design system's default
 * teal) so the product mark stays the same under a tenant's brand accent. `public/favicon.svg`
 * draws the same shape; change both together.
 */
export const LOGO_COLORS = { bubble: '#0D9488', mark: '#FFFFFF' } as const;

export function LogoMark({ size = 28, sx }: { size?: number; sx?: BoxProps['sx'] }) {
  return (
    <Box component="svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false" sx={{ width: size, height: size, flexShrink: 0, display: 'block', ...sx }}>
      <path
        fill={LOGO_COLORS.bubble}
        d="M10 2h12a8 8 0 0 1 8 8v8a8 8 0 0 1-8 8H13l-6.2 4.6a.5.5 0 0 1-.8-.4v-5.3A8 8 0 0 1 2 18v-8a8 8 0 0 1 8-8z"
      />
      <path fill="none" stroke={LOGO_COLORS.mark} strokeWidth={3.4} strokeLinecap="round" d="M11.5 9.5l9 9m0-9l-9 9" />
    </Box>
  );
}

/** The mark with the "ReplyX" wordmark in the heading font. Decorative: the holder names it. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <LogoMark size={size} />
      <Box component="span" sx={{ fontFamily: 'h1.fontFamily', fontWeight: 700, fontSize: size * 0.68, lineHeight: 1, color: 'text.primary', letterSpacing: '-0.01em' }}>
        Reply<Box component="span" sx={{ color: LOGO_COLORS.bubble }}>X</Box>
      </Box>
    </Box>
  );
}
