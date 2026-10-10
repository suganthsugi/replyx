import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({
  dir: 'content/docs',
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

// Docs live at the site root so every Starlight URL keeps working (research R2). Fumadocs
// normalizes page URLs without a trailing slash (search results use them); Next adds the slash to
// rendered links, and the static server answers both forms (apps/docs/Caddyfile).
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
