import { sql, type Kysely } from 'kysely';

/**
 * `gen_uuid_v7()` gains sub-millisecond ordering (RFC 9562 section 6.2, method 3): the 12
 * `rand_a` bits now hold the fraction of the millisecond instead of random bits. Rows written one
 * after another in the same millisecond (a role update's three audit rows, a burst of messages)
 * used to sort randomly by id; they now sort in insert order at microsecond resolution.
 *
 * CREATE OR REPLACE keeps the owner and the EXECUTE grants from 0001.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid
    LANGUAGE sql VOLATILE PARALLEL SAFE
    AS $$
      -- 48-bit Unix milliseconds, version 7 with a 12-bit sub-millisecond fraction, then
      -- gen_random_uuid()'s variant and random bits.
      SELECT encode(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(ms)::bigint) FROM 3)
                        || int2send((28672 + floor((ms - floor(ms)) * 4096))::int2)
                FROM 1 FOR 8),
        'hex')::uuid
      FROM (SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms) AS t
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid
    LANGUAGE sql VOLATILE PARALLEL SAFE
    AS $$
      -- 48-bit Unix milliseconds, then gen_random_uuid()'s random bits with version 7.
      SELECT encode(
        set_bit(
          set_bit(
            overlay(uuid_send(gen_random_uuid())
                    PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
            52, 1),
          53, 1),
        'hex')::uuid
    $$
  `.execute(db);
}
