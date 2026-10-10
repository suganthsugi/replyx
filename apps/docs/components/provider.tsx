'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import SearchDialog from '@/components/search';

export function Provider({ children }: { children: ReactNode }) {
  // System is the default for first-time visitors; a manual Light/Dark choice is remembered (FR-013).
  return (
    <RootProvider search={{ SearchDialog }} theme={{ defaultTheme: 'system', enableSystem: true, attribute: 'class' }}>
      {children}
    </RootProvider>
  );
}
