import localFont from 'next/font/local';

// Self-hosted variable fonts (no external font origin; research R8). next/font preloads them and
// sizes a matching fallback so text doesn't shift when they load.
export const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  variable: '--font-inter',
  weight: '100 900',
  display: 'swap',
});

export const sora = localFont({
  src: '../node_modules/@fontsource-variable/sora/files/sora-latin-wght-normal.woff2',
  variable: '--font-sora',
  weight: '100 800',
  display: 'swap',
});
