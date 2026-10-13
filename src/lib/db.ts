export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';
export const D1 = 'd1';

// Fixes issue with converting bigint values
BigInt.prototype.toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  if (process.env.DATABASE_FLAVOR === 'd1') {
    return D1;
  }

  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

export async function runQuery(queries: any) {
  if (process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA]) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === D1) {
    // Fall back to the PRISMA branch when no explicit D1 implementation is
    // provided. Most queries use prisma.{rawQuery,parseFilters,getDateSQL,...}
    // which are dispatched to SQLite-flavored helpers via src/lib/drizzle-d1.ts,
    // so the PG-branch SQL is already SQLite-compatible. Files with inline PG
    // syntax (extract(epoch), date_trunc, ilike, ~*, ANY()) supply a [D1] key
    // pointing at a sibling in src/queries/sqlite/.
    if (queries[D1]) {
      return queries[D1]();
    }
    return queries[PRISMA]();
  }

  if (db === POSTGRESQL) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
