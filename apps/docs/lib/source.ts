import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({
  dir: 'content/docs',
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

// Docs live at the site root so every Starlight URL keeps working (research R2).
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
