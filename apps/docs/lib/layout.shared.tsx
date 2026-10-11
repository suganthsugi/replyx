import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { Logo } from '@/components/Logo';

/** Options shared by the home and docs layouts (nav title, links). */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      transparentMode: 'top',
    },
    // Light, Dark and System (the default) in the theme switch (FR-013).
    themeSwitch: { mode: 'light-dark-system' },
  };
}
