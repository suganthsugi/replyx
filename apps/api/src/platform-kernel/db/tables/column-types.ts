import type { ColumnType } from 'kysely';

export type { ColumnType, Generated } from 'kysely';

/** timestamptz: pg returns a Date; inserts and updates accept a Date or an ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * timestamptz with a database default. Use this, not `Generated<Timestamp>`: Kysely does not
 * unwrap a ColumnType nested inside another.
 */
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
