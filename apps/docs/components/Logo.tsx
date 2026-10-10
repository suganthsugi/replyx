/**
 * The ReplyX mark: a chat bubble holding an X. Same path data and fixed colors as
 * `apps/web/src/components/foundations/Logo.tsx` and `public/favicon.svg`; change all three together.
 */
export const LOGO_COLORS = { bubble: '#0D9488', mark: '#FFFFFF' } as const;

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0">
      <path
        fill={LOGO_COLORS.bubble}
        d="M10 2h12a8 8 0 0 1 8 8v8a8 8 0 0 1-8 8H13l-6.2 4.6a.5.5 0 0 1-.8-.4v-5.3A8 8 0 0 1 2 18v-8a8 8 0 0 1 8-8z"
      />
      <path fill="none" stroke={LOGO_COLORS.mark} strokeWidth={3.4} strokeLinecap="round" d="M11.5 9.5l9 9m0-9l-9 9" />
    </svg>
  );
}

/** The mark with the "ReplyX Docs" wordmark in the heading font. */
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-[family-name:var(--font-sora)] font-bold tracking-tight">
      <LogoMark />
      <span>
        Reply<span style={{ color: LOGO_COLORS.bubble }}>X</span>
        <span className="ms-1.5 font-medium text-fd-muted-foreground">Docs</span>
      </span>
    </span>
  );
}
