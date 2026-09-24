import { defineConfig } from 'orval';

// Generates the typed API client from the single source of truth
// (apps/api/openapi.yaml) into apps/web/src/api/generated/, split into one
// file per OpenAPI tag. See scripts/generate-api-client.sh for the regen
// entry point and specs/001-multi-tenant-helpdesk/contracts/README.md for
// the tag -> area mapping (identity, access, tickets, operations, customer,
// platform, common).
//
// Requests are routed through the `http` mutator in src/data/http.ts
// (T052), which owns credentials, the X-CSRF-Token header, tenant-relative
// base URL resolution and error-envelope parsing. Assumed contract:
//
//   export const http = <T>(url: string, options?: RequestInit): Promise<T>
//
// matching orval's fetch-client mutator shape: called as
// `http<ResponseType>(requestUrl, { ...options, method, headers, body })`,
// where `requestUrl` already includes the querystring and `body` (when
// present) is a JSON.stringify'd request payload. The mutator must reject
// with an error the generated hooks' `onError` can use, carrying at least
// the parsed `{ error: { code, message, details? } }` envelope from
// contracts/README.md.
export default defineConfig({
  api: {
    input: {
      target: '../api/openapi.yaml',
    },
    output: {
      mode: 'tags-split',
      target: 'src/api/generated/endpoints.ts',
      schemas: 'src/api/generated/model',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      prettier: true,
      override: {
        mutator: {
          path: './src/data/http.ts',
          name: 'http',
        },
        query: {
          useQuery: true,
          useMutation: true,
        },
      },
    },
  },
});
