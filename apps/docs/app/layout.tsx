import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import { inter, sora } from '@/lib/fonts';
import './global.css';

export const metadata: Metadata = {
  title: { default: 'ReplyX Docs', template: '%s · ReplyX Docs' },
  description: 'Guides, admin reference and developer docs for the ReplyX help desk.',
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
};

export const viewport: Viewport = {
  themeColor: '#0D9488',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-[family-name:var(--font-inter)]">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
