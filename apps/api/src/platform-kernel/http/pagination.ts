import { z } from 'zod';

import { validationFailed } from './app-error.js';

/**
 * Cursor pagination (contracts/README.md "Pagination", api-conventions rule 6). Lists take
 * `?limit=1..100` (default 25) and an opaque `cursor`, fetch `limit + 1` rows ordered by a stable
 * key plus `id`, and answer `{ items, nextCursor }`.
 */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Spread into a list endpoint's query schema: `z.object({ ...paginationQuery, state }).strict()`. */
export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
};

export const PaginationQuery = z.object(paginationQuery).strict();
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The cursor is base64url JSON of the last row's sort key. Opaque to clients, not a secret. */
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Invalid or tampered cursors are a client error: 400 `VALIDATION_FAILED` on `cursor`. */
export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    throw invalidCursor();
  }
  return result.data;
}

/**
 * Builds the page from `limit + 1` fetched rows: the extra row only proves there is a next page,
 * and the cursor points at the last row returned.
 */
export function toPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  positionOf: (row: Row) => unknown,
  toItem: (row: Row) => Item,
): Page<Item> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toItem),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(positionOf(last)) : null,
  };
}

function invalidCursor() {
  return validationFailed([{ path: 'cursor', issue: 'invalid_cursor' }]);
}
