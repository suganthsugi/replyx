import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'ReplyX Docs',
      social: {
        github: 'https://github.com/replyx/replyx',
      },
      sidebar: [
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Admin',
          autogenerate: { directory: 'admin' },
        },
        {
          label: 'Operators',
          autogenerate: { directory: 'operators' },
        },
        {
          label: 'Developers',
          autogenerate: { directory: 'developers' },
        },
        {
          label: 'API reference',
          // Rendered by Scalar from apps/api/openapi.yaml — never hand-authored here.
          link: 'http://localhost:3000/api/docs',
          attrs: { target: '_blank' },
        },
      ],
    }),
  ],
});
