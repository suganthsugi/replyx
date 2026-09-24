import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'ReplyX Docs',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/replyx/replyx' },
      ],
      sidebar: [
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Admin',
          items: [{ autogenerate: { directory: 'admin' } }],
        },
        {
          label: 'Operators',
          items: [{ autogenerate: { directory: 'operators' } }],
        },
        {
          label: 'Developers',
          items: [{ autogenerate: { directory: 'developers' } }],
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
