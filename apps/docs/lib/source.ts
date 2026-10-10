import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // GitHub's high-contrast code themes keep every token >= 4.5:1 in both themes (FR-017); the
    // default github-light/-dark have orange and comment colors below AA.
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: { themes: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' } },
    }),
  },
  meta: { schema: metaSchema },
});

// Docs live at the site root so every Starlight URL keeps working (research R2). Fumadocs
// normalizes page URLs without a trailing slash (search results use them); Next adds the slash to
// rendered links, and the static server answers both forms (apps/docs/Caddyfile).
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
