import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/** Options shared by the home and docs layouts (nav title, links). */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'ReplyX Docs',
    },
  };
}
