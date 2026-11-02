/**
 * D1 (SQLite) implementation of src/lib/prisma.ts's default export
 * (`{ client, transaction, rawQuery, parseFilters, getDateSQL, ... }`), swapped
 * in when DATABASE_FLAVOR=d1. `client` translates Prisma calls to Drizzle;
 * the helpers emit SQLite. See D1_FORK.md.
 *
 * Why Drizzle and not Prisma: Workers blocks runtime WebAssembly compilation,
 * and Prisma 7's D1 client as generated here compiled its query engine at
 * request time. Drizzle has no WASM. (D1_FORK.md notes an untried Prisma
 * option.)
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';
import debug from 'debug';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  getTableName,
  gt,
  gte,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/d1/schema';
import {
  DATA_TYPE,
  DEFAULT_PAGE_SIZE,
  FILTER_COLUMNS,
  OPERATORS,
  SESSION_COLUMNS,
} from './constants';
import { filtersObjectToArray } from './params';
import type { Operator, PropertyFilter, QueryFilters, QueryOptions } from './types';

const log = debug('umami:drizzle-d1');

type DB = DrizzleD1Database<typeof schema>;

const DRIZZLE_D1 = 'drizzle-d1';

function getClient(): DB {
  const { env } = getCloudflareContext();
  const db = drizzle((env as any).DB as D1Database, { schema, logger: !!process.env.LOG_QUERY });
  log('Drizzle D1 initialized');
  return db;
}

// Lazy db via Proxy — getCloudflareContext only works inside a request.
const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    globalThis[DRIZZLE_D1] ??= getClient();
    const instance = globalThis[DRIZZLE_D1];
    return Reflect.get(instance, prop, instance);
  },
});

// ---------- Prisma-compat proxy ----------
//
// Translates Prisma's `client.{model}.{method}(...)` API to Drizzle ops so
// the ~14 src/queries/prisma/*.ts callsites and the few inline `prisma.client
// .X` calls inside src/queries/sql/* relationalQuery functions work without
// per-file rewrites.
//
// Coverage:
//   ✓ findUnique, findFirst, findMany, create, createMany, update,
//     updateMany, delete, deleteMany, count, upsert (on a unique where)
//   ✓ where: equality, null/notNull, in/notIn, gt/gte/lt/lte, contains,
//     startsWith, endsWith, AND, OR, NOT, and the relation filters listed in
//     RELATIONS. Unknown keys/operators throw.
//   ✓ transaction([...]) and transaction(async tx => ...) as one atomic
//     db.batch() (see transaction() for what the callback form allows)
//   ✓ `{ increment }` / `{ decrement }` in update data
//   ✓ compound unique keys (`websiteId_visitId: { websiteId, visitId }`)
//   ✓ orderBy (single column or array, asc/desc), take, skip, distinct
//   ✓ top-level `select` / `omit` of columns (also on create/update returning)
//   ✓ include (nested include, where, orderBy, scalar select/omit) and
//     _count: { select } over RELATIONS, on find* (not on writes)

const MODEL_TO_TABLE: Record<string, any> = {
  user: schema.user,
  team: schema.team,
  teamUser: schema.teamUser,
  website: schema.website,
  session: schema.session,
  websiteEvent: schema.websiteEvent,
  eventData: schema.eventData,
  sessionData: schema.sessionData,
  report: schema.report,
  segment: schema.segment,
  revenue: schema.revenue,
  link: schema.link,
  pixel: schema.pixel,
  board: schema.board,
  share: schema.share,
  sessionReplay: schema.sessionReplay,
  sessionReplaySaved: schema.sessionReplaySaved,
  sessionLink: schema.sessionLink,
  heatmapEvent: schema.heatmapEvent,
  annotation: schema.annotation,
  apiKey: schema.apiKey,
  twoFactorAuth: schema.twoFactorAuth,
  twoFactorBackupCode: schema.twoFactorBackupCode,
  twoFactorOtpUsed: schema.twoFactorOtpUsed,
  twoFactorRateLimit: schema.twoFactorRateLimit,
  appSetting: schema.appSetting,
};

// Relations reachable from upstream where/include/_count clauses:
// [target table, local column, target column, to-many]. Relation keys not
// listed here throw instead of being dropped.
type Relation = [any, string, string, boolean?];
const RELATIONS = new Map<any, Record<string, Relation>>([
  [
    schema.team,
    {
      members: [schema.teamUser, 'id', 'teamId', true],
      websites: [schema.website, 'id', 'teamId', true],
    },
  ],
  [schema.user, { websites: [schema.website, 'id', 'userId', true] }],
  [schema.teamUser, { user: [schema.user, 'userId', 'id'], team: [schema.team, 'teamId', 'id'] }],
  [
    schema.report,
    { user: [schema.user, 'userId', 'id'], website: [schema.website, 'websiteId', 'id'] },
  ],
  [
    schema.website,
    {
      user: [schema.user, 'userId', 'id'],
      createUser: [schema.user, 'createdBy', 'id'],
      team: [schema.team, 'teamId', 'id'],
    },
  ],
]);

// prisma/schema.prisma's `onDelete: Cascade` relations. With relationMode =
// "prisma", Prisma deletes these children itself, so the compat layer does too,
// in the same batch as the parent delete: [child table, column referencing id].
const CASCADES = new Map<any, [any, string][]>([
  [
    schema.user,
    [
      [schema.apiKey, 'userId'],
      [schema.twoFactorAuth, 'userId'],
      [schema.twoFactorBackupCode, 'userId'],
      [schema.twoFactorOtpUsed, 'userId'],
      [schema.twoFactorRateLimit, 'userId'],
    ],
  ],
]);

function cascadeDeletes(table: any, cond: any) {
  const parents = sql`select ${table.id} from ${table}${cond ? sql` where ${cond}` : sql``}`;
  return (CASCADES.get(table) ?? []).map(([child, col]) =>
    db.delete(child).where(sql`${child[col]} in (${parents})`),
  );
}

const WHERE_OPS: Record<string, (col: any, v: any) => any> = {
  equals: (c, v) => (v === null ? isNull(c) : eq(c, bindable(v))),
  not: (c, v) => (v === null ? isNotNull(c) : ne(c, bindable(v))),
  // One bound param however long the list; D1 caps a statement at 100.
  in: (c, v) => sql`${c} in (select value from json_each(${JSON.stringify(v.map(bindable))}))`,
  notIn: (c, v) =>
    sql`${c} not in (select value from json_each(${JSON.stringify(v.map(bindable))}))`,
  gt: (c, v) => gt(c, bindable(v)),
  gte: (c, v) => gte(c, bindable(v)),
  lt: (c, v) => lt(c, bindable(v)),
  lte: (c, v) => lte(c, bindable(v)),
  // SQLite LIKE is already case-insensitive for ASCII, so `mode` is ignored.
  contains: (c, v) => like(c, `%${v}%`),
  startsWith: (c, v) => like(c, `${v}%`),
  endsWith: (c, v) => like(c, `%${v}`),
};

// Prisma relation filter → correlated EXISTS. To-one relations take a nested
// where (or null); to-many relations take `{ some: where }`.
function relationCondition(
  table: any,
  key: string,
  [target, local, remote, many]: Relation,
  value: any,
) {
  if (!many && value === null) return isNull(table[local]);
  if (many && !(value && Object.keys(value).length === 1 && 'some' in value)) {
    throw new Error(`drizzle-compat: only \`${key}: { some }\` is supported for to-many relations`);
  }
  const link = eq(target[remote], table[local]);
  const inner = buildCondition(target, many ? value.some : value);
  return sql`exists (select 1 from ${target} where ${inner ? and(link, inner) : link})`;
}

// Prisma `where` → Drizzle condition. Anything it can't translate throws:
// silently dropping a filter widens the query (e.g. every team instead of
// the user's teams).
function buildCondition(table: any, where: any): any {
  if (!where) return undefined;
  const parts: any[] = [];
  for (const [key, value] of Object.entries(where)) {
    // Prisma treats undefined as "no filter".
    if (value === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const sub = (Array.isArray(value) ? value : [value]).map(
        c => buildCondition(table, c) ?? sql`1`,
      );
      if (key === 'AND') sub.length && parts.push(and(...sub));
      else if (key === 'OR') parts.push(sub.length ? or(...sub) : sql`0`);
      else sub.length && parts.push(sql`not (${or(...sub)})`);
      continue;
    }
    const relation = RELATIONS.get(table)?.[key];
    if (relation) {
      parts.push(relationCondition(table, key, relation, value));
      continue;
    }
    const col = table[key];
    // Prisma compound unique key: `a_b: { a, b }`.
    if (!col && isPlainObject(value) && key.split('_').every(k => table[k])) {
      const inner = buildCondition(table, value);
      if (inner) parts.push(inner);
      continue;
    }
    if (!col) {
      throw new Error(`drizzle-compat: unsupported where key '${key}' on ${getTableName(table)}`);
    }
    if (value === null) {
      parts.push(isNull(col));
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      for (const [op, arg] of Object.entries(value)) {
        if (op === 'mode' || arg === undefined) continue;
        const fn = WHERE_OPS[op];
        if (!fn) throw new Error(`drizzle-compat: unsupported operator '${op}' on '${key}'`);
        parts.push(fn(col, arg));
      }
    } else {
      parts.push(eq(col, bindable(value)));
    }
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

const isEmpty = (data: any) => !data || Object.keys(data).length === 0;

function isPlainObject(v: any) {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
}

// Column projection for top-level `select` / `omit`. Ignoring them would
// leak columns the caller excluded (e.g. user.password).
function projection(table: any, args: any, model: string, op: string) {
  const { select, omit } = args ?? {};
  if (!select && !omit) return undefined;
  const all = getTableColumns(table);
  const keys = select
    ? Object.keys(select).filter(k => select[k])
    : Object.keys(all).filter(k => !omit[k]);
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (!all[k]) {
      throw new Error(`drizzle-compat: ${model}.${op}() can't select '${k}' (not a column)`);
    }
    out[k] = all[k];
  }
  return out;
}

// findUnique/update/delete must hit a specific row. With undefined filters
// skipped, `{ id: undefined }` would otherwise match the whole table.
function requireCondition(cond: any, model: string, op: string) {
  if (!cond) throw new Error(`drizzle-compat: ${model}.${op}() needs a where condition`);
  return cond;
}

function buildOrderBy(table: any, orderBy: any): any[] {
  if (!orderBy) return [];
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out: any[] = [];
  for (const ob of list) {
    for (const [key, dir] of Object.entries(ob)) {
      const col = table[key];
      if (!col) continue;
      out.push(dir === 'desc' ? desc(col) : asc(col));
    }
  }
  return out;
}

function ensureNoInclude(args: any, model: string, op: string) {
  if (args?.include) {
    throw new Error(`drizzle-compat: client.${model}.${op}() with \`include\` is not supported`);
  }
}

// Scalar `select` / `omit` on an included relation, applied after grouping
// (the join column may not be selected).
function pickColumns(table: any, row: any, { select, omit }: any) {
  if (select) {
    const cols = getTableColumns(table);
    for (const k of Object.keys(select)) {
      if (select[k] && !cols[k]) {
        throw new Error(`drizzle-compat: can't select '${k}' on ${getTableName(table)}`);
      }
    }
    return Object.fromEntries(Object.entries(row).filter(([k]) => select[k]));
  }
  if (omit) return Object.fromEntries(Object.entries(row).filter(([k]) => !omit[k]));
  return row;
}

const relationFor = (table: any, key: string, what: string) => {
  const relation = RELATIONS.get(table)?.[key];
  if (!relation) {
    throw new Error(`drizzle-compat: unsupported ${what} '${key}' on ${getTableName(table)}`);
  }
  return relation;
};

const joinKeys = (rows: any[], local: string) => [
  ...new Set(rows.map(r => r[local]).filter(v => v !== null && v !== undefined)),
];

// Prisma `include` (nested include, where, orderBy, select/omit) and
// `_count: { select }`. One batched query per relation per level, keyed by
// the parent rows — no N+1.
async function attachIncludes(table: any, rows: any[], include: Record<string, any>) {
  for (const [key, spec] of Object.entries(include)) {
    if (!spec || rows.length === 0) continue;
    if (key === '_count') {
      await attachCounts(table, rows, spec === true ? {} : (spec.select ?? {}));
      continue;
    }
    const [target, local, remote, many] = relationFor(table, key, 'include');
    const opts = spec === true ? {} : spec;
    const keys = joinKeys(rows, local);
    let related: any[] = [];
    if (keys.length) {
      let q: any = db
        .select()
        .from(target)
        .where(and(WHERE_OPS.in(target[remote], keys), buildCondition(target, opts.where)));
      const order = buildOrderBy(target, opts.orderBy);
      if (order.length) q = q.orderBy(...order);
      related = await q;
      if (opts.include) await attachIncludes(target, related, opts.include);
    }
    const byKey = new Map<any, any[]>();
    for (const r of related) {
      if (!byKey.has(r[remote])) byKey.set(r[remote], []);
      byKey.get(r[remote]).push(pickColumns(target, r, opts));
    }
    for (const row of rows) {
      const matches = byKey.get(row[local]) ?? [];
      row[key] = many ? matches : (matches[0] ?? null);
    }
  }
}

async function attachCounts(table: any, rows: any[], select: Record<string, any>) {
  for (const row of rows) row._count ??= {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    const [target, local, remote, many] = relationFor(table, key, '_count');
    if (!many) throw new Error(`drizzle-compat: _count '${key}' needs a to-many relation`);
    const keys = joinKeys(rows, local);
    const where = spec === true ? undefined : spec.where;
    const found: any[] = keys.length
      ? await db
          .select({ k: target[remote], n: sql<number>`count(*)` })
          .from(target)
          .where(and(WHERE_OPS.in(target[remote], keys), buildCondition(target, where)))
          .groupBy(target[remote])
      : [];
    const byKey = new Map(found.map(f => [f.k, Number(f.n)]));
    for (const row of rows) row._count[key] = byKey.get(row[local]) ?? 0;
  }
}

async function withIncludes(table: any, rows: any[], args: any) {
  if (args?.include) await attachIncludes(table, rows, args.include);
  return rows;
}

// D1's bind() only accepts primitives. Drizzle's plain `text()` / `integer()`
// columns pass values through to bind() without coercion, so a Date / BigInt
// in args.data will silently hang the request on Workers (the driver awaits a
// promise that the runtime then cancels). Coerce common JS types the Prisma
// callsites pass — Date → ISO, BigInt → Number, boolean → 0/1. `undefined`
// keys are dropped, as Prisma does: partial updates keep existing values and
// inserts get column defaults. JSON columns are `mode: 'json'` in the schema,
// so objects pass through for Drizzle to stringify. With `table` (updates),
// Prisma's `{ increment: n }` / `{ decrement: n }` become column arithmetic.
function prepareWriteData(data: any, table?: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object' || data instanceof Date) return data;
  const out: any = Array.isArray(data) ? [] : {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) {
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (typeof v === 'bigint') {
      out[k] = Number(v);
    } else if (typeof v === 'boolean') {
      out[k] = v ? 1 : 0;
    } else if (
      table?.[k] &&
      isPlainObject(v) &&
      typeof ((v as any).increment ?? (v as any).decrement) === 'number'
    ) {
      const { increment, decrement } = v as any;
      out[k] =
        increment !== undefined ? sql`${table[k]} + ${increment}` : sql`${table[k]} - ${decrement}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Writes return Prisma-style lazy promises: nothing runs until awaited, so
// transaction() can collect the queries and send them as one db.batch(). An
// op can span several statements (chunked createMany); they still commit
// together.
const BATCH = Symbol('drizzle-compat-batch');
type BatchItem = {
  queries: any[];
  map: (results: any[]) => any;
  prelude?: () => Promise<void>;
};

function deferred(queries: any[], map: (results: any[]) => any, prelude?: () => Promise<void>) {
  let p: Promise<any> | undefined;
  const run = () => (p ??= runBatch([{ queries, map, prelude }]).then(([res]) => res));
  return {
    [BATCH]: { queries, map, prelude } as BatchItem,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable, like PrismaPromise
    then: (ok?: any, err?: any) => run().then(ok, err),
    catch: (err?: any) => run().catch(err),
    finally: (fn?: any) => run().finally(fn),
  };
}

const first = ([rows]: any[]) => rows[0];
const changes = ([res]: any[]) => ({ count: res?.meta?.changes ?? 0 });

// Prisma applies `distinct` after ordering; keep the first row per key.
function applyDistinct(rows: any[], distinct: string[] | string) {
  const keys = Array.isArray(distinct) ? distinct : [distinct];
  const seen = new Set<string>();
  return rows.filter(r => {
    const id = JSON.stringify(keys.map(k => r[k]));
    return !seen.has(id) && seen.add(id);
  });
}

function modelOps(modelName: string) {
  const table = MODEL_TO_TABLE[modelName];
  if (!table) {
    throw new Error(`drizzle-compat: unknown model '${modelName}'`);
  }
  return {
    async findUnique(args: any) {
      const cond = requireCondition(buildCondition(table, args?.where), modelName, 'findUnique');
      const cols = projection(table, args, modelName, 'findUnique');
      const rows: any[] = await db.select(cols).from(table).where(cond).limit(1);
      return (await withIncludes(table, rows, args))[0] ?? null;
    },
    async findFirst(args: any = {}) {
      const cond = buildCondition(table, args?.where);
      const order = buildOrderBy(table, args?.orderBy);
      let q: any = db.select(projection(table, args, modelName, 'findFirst')).from(table);
      if (cond) q = q.where(cond);
      if (order.length) q = q.orderBy(...order);
      const rows: any[] = await q.limit(1);
      return (await withIncludes(table, rows, args))[0] ?? null;
    },
    async findMany(args: any = {}) {
      const cond = buildCondition(table, args?.where);
      const order = buildOrderBy(table, args?.orderBy);
      let q: any = db.select(projection(table, args, modelName, 'findMany')).from(table);
      if (cond) q = q.where(cond);
      if (order.length) q = q.orderBy(...order);
      if (args?.distinct) {
        const skip = args.skip ?? 0;
        const rows = applyDistinct(await q, args.distinct);
        return withIncludes(
          table,
          rows.slice(skip, args.take ? skip + args.take : undefined),
          args,
        );
      }
      if (args?.take) q = q.limit(args.take);
      if (args?.skip) q = q.offset(args.skip);
      return withIncludes(table, await q, args);
    },
    create(args: any) {
      ensureNoInclude(args, modelName, 'create');
      const cols = projection(table, args, modelName, 'create');
      return deferred(
        [db.insert(table).values(prepareWriteData(args.data)).returning(cols)],
        first,
      );
    },
    createMany(args: any) {
      const data = Array.isArray(args.data) ? args.data : [args.data];
      // D1 caps a statement at 100 bound params; one row binds up to one per column.
      const perStatement = Math.max(
        1,
        Math.floor(100 / Object.keys(getTableColumns(table)).length),
      );
      const queries = [];
      for (let i = 0; i < data.length; i += perStatement) {
        queries.push(
          db.insert(table).values(data.slice(i, i + perStatement).map(prepareWriteData)),
        );
      }
      return deferred(queries, () => ({ count: data.length }));
    },
    update(args: any) {
      ensureNoInclude(args, modelName, 'update');
      const cond = requireCondition(buildCondition(table, args?.where), modelName, 'update');
      const cols = projection(table, args, modelName, 'update');
      const data = prepareWriteData(args.data, table);
      // Nothing left to set (all undefined): Prisma returns the row unchanged.
      if (isEmpty(data)) return deferred([db.select(cols).from(table).where(cond).limit(1)], first);
      return deferred([db.update(table).set(data).where(cond).returning(cols)], first);
    },
    updateMany(args: any) {
      const cond = buildCondition(table, args?.where);
      const data = prepareWriteData(args.data, table);
      if (isEmpty(data)) {
        const q: any = db.select({ n: sql<number>`count(*)` }).from(table);
        return deferred([cond ? q.where(cond) : q], ([rows]) => ({ count: Number(rows[0].n) }));
      }
      const q: any = db.update(table).set(data);
      return deferred([cond ? q.where(cond) : q], changes);
    },
    // INSERT … ON CONFLICT (where's unique columns) DO UPDATE, one statement.
    upsert(args: any) {
      ensureNoInclude(args, modelName, 'upsert');
      const cols = projection(table, args, modelName, 'upsert');
      // `a: v` or compound `a_b: { a, b }`; the columns need a unique index.
      const keys = Object.entries(args.where ?? {}).flatMap(([key, value]) =>
        table[key] ? [key] : isPlainObject(value) ? Object.keys(value as object) : [key],
      );
      if (!keys.length || keys.some(k => !table[k])) {
        throw new Error(`drizzle-compat: ${modelName}.upsert() needs a unique where`);
      }
      const update = prepareWriteData(args.update, table);
      // An empty update still has to return the existing row: set a key to itself.
      const set = isEmpty(update) ? { [keys[0]]: sql`${table[keys[0]]}` } : update;
      const target = keys.map(k => table[k]);
      return deferred(
        [
          db
            .insert(table)
            .values(prepareWriteData(args.create))
            .onConflictDoUpdate({ target, set })
            .returning(cols),
        ],
        first,
      );
    },
    delete(args: any) {
      const cond = requireCondition(buildCondition(table, args?.where), modelName, 'delete');
      const cols = projection(table, args, modelName, 'delete');
      return deferred(
        [...cascadeDeletes(table, cond), db.delete(table).where(cond).returning(cols)],
        results => first(results.slice(-1)),
      );
    },
    deleteMany(args: any = {}) {
      const cond = buildCondition(table, args?.where);
      const q: any = db.delete(table);
      const prelude = BULK_TABLES.has(table) ? () => purgeInChunks(table, cond) : undefined;
      return deferred(
        [...cascadeDeletes(table, cond), cond ? q.where(cond) : q],
        results => changes(results.slice(-1)),
        prelude,
      );
    },
    async count(args: any = {}) {
      const cond = buildCondition(table, args?.where);
      let q: any = db.select({ n: sql<number>`count(*)` }).from(table);
      if (cond) q = q.where(cond);
      const rows: any[] = await q;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// The Prisma-compat client: a Proxy that returns model-ops on first property
// access. Cached per model for stable identity.
const opsCache = new Map<string, any>();
const client = new Proxy({} as any, {
  get(_, modelName: string) {
    // Allow direct Drizzle access via `client.$db` for new code that wants it.
    if (modelName === '$db') return db;
    if (modelName === 'then') return undefined; // not a thenable
    let ops = opsCache.get(modelName);
    if (!ops) {
      ops = modelOps(modelName);
      opsCache.set(modelName, ops);
    }
    return ops;
  },
});

// ---------- SQL fragment helpers (SQLite-flavored) ----------
//
// Same names and signatures as the PG helpers in src/lib/prisma.ts; the
// queries in src/queries/sql/** and src/queries/sqlite/** call them through
// `prisma.getDateSQL` etc.

// Timestamps are stored as ISO strings ('YYYY-MM-DDTHH:MM:SS.sssZ'), and range
// filters compare them as text, so date math has to produce the same format.
const SQLITE_ISO_FORMAT = '%Y-%m-%dT%H:%M:%fZ';

function getAddIntervalQuery(field: string, interval: string): string {
  return `strftime('${SQLITE_ISO_FORMAT}', ${field}, '${interval}')`;
}

// PG: field1::date - field2::date (whole calendar days).
function getDayDiffQuery(field1: string, field2: string): string {
  return `CAST(julianday(${field1}, 'start of day') - julianday(${field2}, 'start of day') AS INTEGER)`;
}

function getCastColumnQuery(field: string, type: string): string {
  const t = type.toLowerCase();
  if (t === 'date') return `date(${field})`;
  if (t === 'timestamp' || t === 'timestamptz') return `strftime('${SQLITE_ISO_FORMAT}', ${field})`;
  const sqliteType =
    {
      uuid: 'TEXT',
      text: 'TEXT',
      varchar: 'TEXT',
      int: 'INTEGER',
      integer: 'INTEGER',
      bigint: 'INTEGER',
      float: 'REAL',
      double: 'REAL',
      numeric: 'REAL',
      decimal: 'REAL',
    }[t] ?? type.toUpperCase();
  return `CAST(${field} AS ${sqliteType})`;
}

// Same output strings as PG's DATE_FORMATS (src/lib/prisma.ts): always
// Z-suffixed, holding local wall time for a named timezone.
const SQLITE_DATE_FORMATS: Record<string, string> = {
  minute: '%Y-%m-%dT%H:%M:00Z',
  hour: '%Y-%m-%dT%H:00:00Z',
  day: '%Y-%m-%dT00:00:00Z',
  month: '%Y-%m-01T00:00:00Z',
  year: '%Y-01-01T00:00:00Z',
};

// SQLite has no IANA zone support, so `AT TIME ZONE` becomes a strftime
// modifier picked from the zone's UTC-offset history, computed with Intl.
// Covers 2015-01-01 through Jan 1 two years out; earlier timestamps use the
// offset in effect at the start of 2015. The timezone string never reaches
// the SQL: only computed offsets and ISO instants do, and Intl throws on an
// unknown zone.
const TZ_RANGE_START = Date.UTC(2015, 0, 1);
const tzTransitionCache = new Map<string, { offsets: number[]; instants: string[] }>();

function getTimezoneTransitions(timezone: string) {
  let cached = tzTransitionCache.get(timezone);
  if (cached) return cached;

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  // Offset in minutes at a minute-aligned instant.
  const offsetAt = (t: number) => {
    const p: Record<string, number> = {};
    for (const { type, value } of dtf.formatToParts(t)) p[type] = +value;
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - t) / 60000;
  };

  // Weekly probes: no zone has two transitions closer than 28 days since 2015
  // (checked against every Intl zone), so a week can't hide a round trip.
  const STEP = 7 * 86400000;
  const MINUTE = 60000;
  const end = Date.UTC(new Date().getUTCFullYear() + 2, 0, 1);
  // offsets[i] applies from instants[i - 1] (inclusive) up to instants[i].
  const offsets = [offsetAt(TZ_RANGE_START)];
  const instants: string[] = [];

  for (let t = TZ_RANGE_START + STEP; t <= end; t += STEP) {
    const offset = offsetAt(t);
    if (offset !== offsets[offsets.length - 1]) {
      // Binary search the first minute in (t - STEP, t] with the new offset.
      let lo = t - STEP;
      let hi = t;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
        if (offsetAt(mid) === offset) hi = mid;
        else lo = mid;
      }
      instants.push(new Date(hi).toISOString());
      offsets.push(offset);
    }
  }

  cached = { offsets, instants };
  tzTransitionCache.set(timezone, cached);
  return cached;
}

const toModifier = (minutes: number) => `'${minutes >= 0 ? '+' : ''}${minutes} minutes'`;

// Returns `, <modifier>` to append to strftime() args, or '' for UTC.
function getTimezoneModifier(field: string, timezone?: string): string {
  if (!timezone || timezone.toLowerCase() === 'utc') return '';

  const { offsets, instants } = getTimezoneTransitions(timezone);

  if (instants.length === 0) {
    return offsets[0] === 0 ? '' : `, ${toModifier(offsets[0])}`;
  }

  // Newest transition first: most queried rows are recent.
  const whens = instants
    .map((instant, i) => `WHEN ${field} >= '${instant}' THEN ${toModifier(offsets[i + 1])}`)
    .reverse();

  return `, CASE ${whens.join(' ')} ELSE ${toModifier(offsets[0])} END`;
}

function getDateSQL(field: string, unit: string, timezone?: string): string {
  return `strftime('${SQLITE_DATE_FORMATS[unit]}', ${field}${getTimezoneModifier(field, timezone)})`;
}

// PG: to_char(field at time zone tz, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'); 'utc' and
// 'second' are the same format.
function getDateStringSQL(field: string, _unit: 'utc' | 'second' = 'utc', timezone?: string) {
  return `strftime('%Y-%m-%dT%H:%M:%SZ', ${field}${getTimezoneModifier(field, timezone)})`;
}

// PG: concat(extract(dow ...), ':', to_char(..., 'HH24')), e.g. '0:09'.
function getDateWeeklySQL(field: string, timezone?: string) {
  return `strftime('%w:%H', ${field}${getTimezoneModifier(field, timezone)})`;
}

export function getTimestampSQL(field: string) {
  return `unixepoch(${field})`;
}

// PG: floor(extract(epoch from (field2 - field1))). Diff in integer
// milliseconds so sub-second parts count and float error can't drop a second.
function getTimestampDiffSQL(field1: string, field2: string): string {
  const ms = (field: string) => `CAST(round(unixepoch(${field}, 'subsec') * 1000) AS INTEGER)`;
  return `((${ms(field2)} - ${ms(field1)}) / 1000)`;
}

function getSearchSQL(column: string, param: string = 'search'): string {
  return `and ${column} LIKE {{${param}}} COLLATE NOCASE`;
}

function mapFilter(
  column: string,
  operator: string,
  name: string,
  type: string = '',
  paramName?: string,
) {
  const param = paramName ?? name;
  const value = `{{${param}${type ? `::${type}` : ''}}}`;

  if (name.startsWith('cohort_')) {
    name = name.slice('cohort_'.length);
  }

  const table = SESSION_COLUMNS.includes(name) ? 'session' : 'website_event';

  switch (operator) {
    case OPERATORS.equals:
      return `${table}.${column} IN (SELECT value FROM json_each(${value}))`;
    case OPERATORS.notEquals:
      return `${table}.${column} NOT IN (SELECT value FROM json_each(${value}))`;
    case OPERATORS.contains:
      return `${table}.${column} LIKE ${value} COLLATE NOCASE`;
    case OPERATORS.doesNotContain:
      return `${table}.${column} NOT LIKE ${value} COLLATE NOCASE`;
    case OPERATORS.regex:
    case OPERATORS.notRegex:
      throw new Error(`D1 does not support regex operator: ${operator}`);
    default:
      return '';
  }
}

function getFilterQuery(filters: Record<string, any>, options: QueryOptions = {}): string {
  const { isCohort, cohortMatch, cohortActionName } = options;
  const isOr = isCohort ? cohortMatch === 'any' : filters.match === 'any';
  const orClauses: string[] = [];
  const andClauses: string[] = [];

  filtersObjectToArray(filters, options).forEach(
    ({ name, column, operator, prefix = '', paramName }) => {
      if (isCohort) {
        column = FILTER_COLUMNS[name.slice('cohort_'.length)];
      }

      if (column) {
        const clause = mapFilter(`${prefix}${column}`, operator, name, '', paramName);
        const isAlwaysAnd = name === 'eventType' || (isCohort && name === cohortActionName);

        if (isAlwaysAnd) {
          andClauses.push(`and ${clause}`);
        } else if (isOr) {
          orClauses.push(clause);
        } else {
          andClauses.push(`and ${clause}`);
        }

        if (name === 'referrer') {
          andClauses.push(
            // PG: regexp_replace(website_event.hostname, '^www.', '')
            `and (website_event.referrer_domain != case when substr(website_event.hostname, 1, 3) = 'www' and length(website_event.hostname) > 3 then substr(website_event.hostname, 5) else website_event.hostname end or website_event.referrer_domain is null)`,
          );
        }
      }
    },
  );

  const parts: string[] = [];

  if (orClauses.length > 0) {
    parts.push(`and (\n  ${orClauses.join('\n  or ')}\n)`);
  }

  parts.push(...andClauses);

  return parts.join('\n');
}

function getCohortQuery(filters: QueryFilters = {}) {
  if (!filters || Object.keys(filters).length === 0) {
    return '';
  }

  const cohortMatch = (filters as any).cohort_match;
  const cohortActionName = (filters as any).cohort_actionName;

  const filterQuery = getFilterQuery(filters, { isCohort: true, cohortMatch, cohortActionName });

  return `join
    (select distinct website_event.session_id
    from website_event
    join session on session.session_id = website_event.session_id
      and session.website_id = website_event.website_id
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{cohort_startDate}} and {{cohort_endDate}}
      ${filterQuery}
    ) cohort
    on cohort.session_id = website_event.session_id
    `;
}

function getExcludeBounceQuery(filters: Record<string, any>) {
  if (filters.excludeBounce !== true) {
    return '';
  }

  return `join
    (select session_id, visit_id
    from website_event
    where website_id = {{websiteId}}
      and created_at between {{startDate}} and {{endDate}}
      and event_type != 5
    group by session_id, visit_id
    having sum(case when event_type NOT IN (2, 5) then 1 else 0 end) > 1
      or (
        sum(case when event_type NOT IN (2, 5) then 1 else 0 end) = 1
        and sum(case when event_type = 2 then 1 else 0 end) > 0
      )
    ) excludeBounce
    on excludeBounce.session_id = website_event.session_id
      and excludeBounce.visit_id = website_event.visit_id
    `;
}

function getDateQuery(filters: Record<string, any>) {
  const { startDate, endDate } = filters;

  if (startDate) {
    if (endDate) {
      return `and website_event.created_at between {{startDate}} and {{endDate}}`;
    } else {
      return `and website_event.created_at >= {{startDate}}`;
    }
  }

  return '';
}

function getQueryParams(filters: Record<string, any>) {
  return {
    ...filters,
    ...filtersObjectToArray(filters).reduce((obj, { name, column, operator, value, paramName }) => {
      const resolvedColumn =
        column || (name?.startsWith('cohort_') && FILTER_COLUMNS[name.slice('cohort_'.length)]);

      if (!resolvedColumn) return obj;

      const key = paramName ?? name;

      if (([OPERATORS.contains, OPERATORS.doesNotContain] as Operator[]).includes(operator)) {
        obj[key] = `%${value}%`;
      } else if (([OPERATORS.equals, OPERATORS.notEquals] as Operator[]).includes(operator)) {
        obj[key] = JSON.stringify(Array.isArray(value) ? value : [value]);
      } else {
        obj[key] = value;
      }

      return obj;
    }, {}),
  };
}

// One property filter as a SQLite condition on event_data/session_data
// columns, or undefined to skip it (as PG does for empty values). Same params
// as PG; arrays bind as JSON (see bindable).
function getPropertyCondition(
  { dataType, operator, value }: PropertyFilter,
  valParam: string,
  params: Record<string, any>,
  timezone?: string,
): string | undefined {
  const val = `{{${valParam}}}`;

  switch (dataType) {
    case DATA_TYPE.number: {
      const col = 'CAST(number_value AS REAL)';
      params[valParam] = parseFloat(value) || 0;
      const ops: Record<string, string> = {
        [OPERATORS.notEquals]: '!=',
        [OPERATORS.greaterThan]: '>',
        [OPERATORS.lessThan]: '<',
        [OPERATORS.greaterThanEquals]: '>=',
        [OPERATORS.lessThanEquals]: '<=',
      };
      return `${col} ${ops[operator] ?? '='} ${val}`;
    }
    case DATA_TYPE.date: {
      if (!value) return;
      params[valParam] = value;
      const col = `date(date_value${getTimezoneModifier('date_value', timezone)})`;
      const op = operator === OPERATORS.before ? '<' : operator === OPERATORS.after ? '>' : '=';
      return `${col} ${op} date(${val})`;
    }
    case DATA_TYPE.array: {
      if (!value) return;
      params[valParam] = value;
      // PG's ::jsonb cast fails the query on a malformed value; skip the row
      // instead. Elements compare as jsonb_array_elements_text would render
      // them: json_each's `value` is REAL for 1.50 and 1 for true.
      const exists = `exists (
                select 1
                from json_each(case when json_valid(string_value) then string_value else '[]' end) as item
                where (case item.type when 'text' then item.value when 'null' then null
                  else string_value -> item.fullkey end) = ${val}
              )`;
      return operator === OPERATORS.contains ? exists : `not ${exists}`;
    }
    default: {
      if (operator === OPERATORS.equals || operator === OPERATORS.notEquals) {
        const vals = value.split(',').filter(Boolean);
        if (!vals.length) return;
        params[valParam] = vals;
        return `string_value ${operator === OPERATORS.equals ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(${val}))`;
      }
      if (operator === OPERATORS.regex || operator === OPERATORS.notRegex) {
        throw new Error(`D1 does not support regex operator: ${operator}`);
      }
      if (!value) return;
      params[valParam] = `%${value}%`;
      return `string_value ${operator === OPERATORS.contains ? 'LIKE' : 'NOT LIKE'} ${val} COLLATE NOCASE`;
    }
  }
}

function getPropertyFilterQuery(
  filters: PropertyFilter[] = [],
  propertyType: 'event' | 'session' = 'event',
  timezone?: string,
): { sql: string; params: Record<string, any> } {
  const parts: string[] = [];
  const params: Record<string, any> = {};

  filters.forEach((filter, i) => {
    const keyParam = `pf_key_${i}`;
    const condition = getPropertyCondition(filter, `pf_val_${i}`, params, timezone);
    if (!condition) return;
    params[keyParam] = filter.propertyName;

    const match = `data_key = {{${keyParam}}}
        and data_type = ${Number(filter.dataType)}
        and ${condition}`;

    parts.push(
      propertyType === 'session'
        ? `and exists (
      select 1
      from session_data
      where website_id = website_event.website_id
        and session_id = website_event.session_id
        and ${match}
    )`
        : `and website_event.event_id in (
      select website_event_id
      from event_data
      where website_id = {{websiteId}}
        and created_at between {{startDate}} and {{endDate}}
        and ${match}
    )`,
    );
  });

  return { sql: parts.join('\n'), params };
}

// PG groups the property rows and requires bool_or(match) per filter; SQLite
// has no bool_or, so each filter is max(case when match then 1 else 0 end) = 1.
function getGroupedPropertyFilterQuery(
  filters: PropertyFilter[] = [],
  prefix: 'epf' | 'spf',
  timezone?: string,
): { clauses: string[]; keyRefs: string[]; params: Record<string, any> } {
  const clauses: string[] = [];
  const keyRefs: string[] = [];
  const params: Record<string, any> = {};

  filters.forEach((filter, i) => {
    const keyParam = `${prefix}_key_${i}`;
    params[keyParam] = filter.propertyName;
    keyRefs.push(`{{${keyParam}}}`);
    const condition = getPropertyCondition(filter, `${prefix}_val_${i}`, params, timezone);
    if (!condition) return;
    clauses.push(
      `max(case when data_key = {{${keyParam}}} and data_type = ${Number(filter.dataType)} and ${condition} then 1 else 0 end) = 1`,
    );
  });

  return { clauses, keyRefs, params };
}

function getEventPropertyFilterQuery(filters: PropertyFilter[] = [], timezone?: string) {
  const { clauses, keyRefs, params } = getGroupedPropertyFilterQuery(filters, 'epf', timezone);
  if (!clauses.length) return { sql: '', params: {} };

  return {
    sql: `and website_event.event_id in (
      select website_event_id
      from event_data
      where website_id = {{websiteId}}
        and created_at between {{startDate}} and {{endDate}}
        and data_key in (${keyRefs.join(', ')})
      group by website_event_id
      having ${clauses.join('\n        and ')}
    )`,
    params,
  };
}

function getSessionPropertyFilterQuery(filters: PropertyFilter[] = [], timezone?: string) {
  const { clauses, keyRefs, params } = getGroupedPropertyFilterQuery(filters, 'spf', timezone);
  if (!clauses.length) return { sql: '', params: {} };

  return {
    sql: `and exists (
      select 1
      from session_data
      where website_id = website_event.website_id
        and session_id = website_event.session_id
        and data_key in (${keyRefs.join(', ')})
      group by website_id, session_id
      having ${clauses.join('\n        and ')}
    )`,
    params,
  };
}

function parseFilters(filters: Record<string, any>, options?: QueryOptions) {
  const joinSession = Object.keys(filters).find(key => {
    const baseName = key.replace(/\d+$/, '');
    return ['referrer', ...SESSION_COLUMNS].includes(baseName);
  });

  const cohortFilters = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key.startsWith('cohort_')),
  );

  const eventProperty = getEventPropertyFilterQuery(filters.eventPropertyFilters, filters.timezone);
  const sessionProperty = getSessionPropertyFilterQuery(
    filters.sessionPropertyFilters,
    filters.timezone,
  );

  return {
    joinSessionQuery:
      options?.joinSession || joinSession
        ? `inner join session on website_event.session_id = session.session_id and website_event.website_id = session.website_id`
        : '',
    dateQuery: getDateQuery(filters),
    filterQuery: [getFilterQuery(filters, options), eventProperty.sql, sessionProperty.sql]
      .filter(Boolean)
      .join('\n'),
    queryParams: {
      ...getQueryParams(filters),
      ...eventProperty.params,
      ...sessionProperty.params,
    },
    cohortQuery: getCohortQuery(cohortFilters),
    excludeBounceQuery: getExcludeBounceQuery(filters),
  };
}

// ---------- query execution ----------

// D1's bind() only accepts primitives (string/number/null/ArrayBufferView).
// Coerce JS types the umami query layer commonly passes — Date (filter dates),
// BigInt (numeric coercion), undefined (treat as null). Arrays should arrive
// pre-stringified via parseFilters (see getQueryParams above); if one leaks
// through, JSON-stringify it as a defensive fallback.
function bindable(v: any): any {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

async function rawQuery(sqlText: string, data: Record<string, any>, name?: string): Promise<any> {
  if (process.env.LOG_QUERY) {
    log('QUERY:\n', sqlText);
    log('PARAMETERS:\n', data);
    log('NAME:\n', name);
  }

  // One numbered parameter (?1, ?2, ...) per distinct name: D1 caps a
  // statement at 100 bound parameters, and queries repeat names freely.
  const params: any[] = [];
  const indexes = new Map<string, number>();
  const query = sqlText?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, key] = args;
    let index = indexes.get(key);
    if (index === undefined) {
      index = params.push(bindable(data[key]));
      indexes.set(key, index);
    }
    return `?${index}`;
  });

  // Use the raw D1 binding directly — Drizzle's sql.raw doesn't support
  // separate parameter binding cleanly for arbitrary SQL strings.
  const { env } = getCloudflareContext();
  const stmt = (env as any).DB.prepare(query);
  const bound = params.length ? stmt.bind(...params) : stmt;
  const { results } = await bound.all();
  return results;
}

async function pagedRawQuery(
  query: string,
  queryParams: Record<string, any>,
  filters: QueryFilters,
  name?: string,
  defaultOrderBy?: string,
) {
  const { page = 1, pageSize, orderBy, sortDescending = false, maxResults } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);
  const direction = sortDescending ? 'desc' : 'asc';

  const statements = [
    orderBy ? `order by ${orderBy} ${direction}` : defaultOrderBy && `order by ${defaultOrderBy}`,
    +size > 0 && `limit ${+size} offset ${offset}`,
  ]
    .filter(n => n)
    .join('\n');

  const countQuery = maxResults
    ? `select count(*) as num from (select 1 from (${query}) t limit ${+maxResults}) t2`
    : `select count(*) as num from (${query}) t`;
  const countResult = await rawQuery(countQuery, queryParams);
  const count = Number(countResult?.[0]?.num ?? 0);

  const data = await rawQuery(`${query}${statements}`, queryParams, name);

  return {
    data,
    count,
    page: +page,
    pageSize: size,
    orderBy,
    isCapped: !!maxResults && count >= +maxResults,
  };
}

async function pagedQuery<T>(model: string, criteria: T, filters?: QueryFilters): Promise<any> {
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const ops = (client as any)[model];
  if (!ops) {
    throw new Error(`drizzle-compat: pagedQuery unknown model '${model}'`);
  }
  const baseArgs: any = { ...(criteria as any) };
  if (size > 0) {
    baseArgs.take = +size;
    baseArgs.skip = +size * (+page - 1);
  }
  if (orderBy) {
    baseArgs.orderBy = [{ [orderBy as string]: sortDescending ? 'desc' : 'asc' }];
  }
  const data = await ops.findMany(baseArgs);
  const count = await ops.count({ where: (criteria as any).where });
  return { data, count, page: +page, pageSize: size, orderBy, search };
}

function getSearchParameters(query: string, filters: Record<string, any>[]) {
  // Used by src/queries/prisma/* via client.findMany. Returns a Prisma-style
  // where clause with case-insensitive contains across the listed columns —
  // our buildCondition translates `contains` to LIKE which is ASCII-case-
  // insensitive on SQLite. Good enough for our search inputs.
  if (!query) return undefined;
  const parseFilter = (filter: Record<string, any>): any => {
    const [[key, value]] = Object.entries(filter);
    return {
      [key]:
        typeof value === 'string'
          ? { [value]: query, mode: 'insensitive' }
          : parseFilter(value as any),
    };
  };
  const params = filters.map(filter => parseFilter(filter));
  return { AND: { OR: params } };
}

// Analytics tables can hold millions of rows per website, and D1 stops a
// query after 30 s, so a single DELETE (or the atomic batch around it) could
// never finish. deleteMany on these tables first deletes in rowid chunks
// outside the batch; the batch then removes whatever arrived meanwhile,
// atomically with the rest of the transaction.
const BULK_TABLES = new Set<any>([
  schema.websiteEvent,
  schema.eventData,
  schema.sessionData,
  schema.session,
  schema.revenue,
  schema.sessionReplay,
  schema.heatmapEvent,
  schema.sessionLink,
]);
const PURGE_CHUNK = 5000;

async function purgeInChunks(table: any, cond: any) {
  const filter = cond ?? sql`1`;
  for (;;) {
    const res: any = await db.run(
      sql`delete from ${table} where rowid in (select rowid from ${table} where ${filter} limit ${PURGE_CHUNK})`,
    );
    if (!res?.meta?.changes) return;
  }
}

async function runBatch(items: BatchItem[]) {
  for (const item of items) await item.prelude?.();
  const queries = items.flatMap(i => i.queries);
  const results: any[] = queries.length ? await db.batch(queries as any) : [];
  let start = 0;
  return items.map(i => {
    const end = start + i.queries.length;
    const mapped = i.map(results.slice(start, end));
    start = end;
    return mapped;
  });
}

const TX_WRITES = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

// tx.$executeRawUnsafe(): PG SQL with $1-style params. Upstream only sends
// `DELETE FROM a USING b WHERE …` (deleteWebsite), rewritten to a rowid
// subquery so SQLite can drive the join from b's index. Anything else runs
// as-is and fails loudly if it's PG-only.
function rawWrite(query: string, params: any[]): BatchItem {
  const text = query
    .replace(
      /^\s*delete\s+from\s+(\w+)\s+using\s+(\w+)\s+where\s+([\s\S]*?)\s*;?\s*$/i,
      'DELETE FROM $1 WHERE rowid IN (SELECT $1.rowid FROM $1, $2 WHERE $3)',
    )
    .replace(/\$(\d+)/g, '?$1');
  return {
    queries: [],
    map: () => 0,
    // A prelude, so it runs in call order with the chunked purges: by the
    // time the batch runs, deleteWebsite has purged the rows `b` joins on.
    // ponytail: one statement, not chunked; fine for the few rows it's meant
    // to catch, slow past D1's 30 s on a site with tens of millions of events.
    prelude: async () => {
      const stmt = (db as any).$client.prepare(text);
      await (params.length ? stmt.bind(...params.map(bindable)) : stmt).run();
    },
  };
}

// Prisma's $transaction on D1. Both forms become a single db.batch(), which
// D1 runs atomically. The callback form records writes rather than running
// them: nothing commits until the callback returns (side effects in it run
// first), and an awaited write's result is a placeholder that throws if
// used. Only the write the callback returns resolves to its real row. Reads
// need their result, so they run immediately, which is only consistent
// before the first recorded write; after one they throw. An upsert before
// any other write also runs immediately (2FA's rate limit reads its row);
// after one it's batched like other writes.
async function transaction(input: any, _options?: any): Promise<any> {
  if (Array.isArray(input)) {
    return runBatch(
      input.map(op => {
        if (!op?.[BATCH]) throw new Error('drizzle-compat: transaction([...]) only accepts writes');
        return op[BATCH];
      }),
    );
  }

  const recorded: BatchItem[] = [];
  const placeholders = new Map<any, number>();
  const tx = new Proxy({} as any, {
    get: (_, model: string) => {
      if (model === '$executeRawUnsafe') {
        return (query: string, ...params: any[]) => {
          recorded.push(rawWrite(query, params));
          return Promise.resolve(0);
        };
      }
      return new Proxy({} as any, {
        get: (_, op: string) => (args: any) => {
          const immediate =
            op === 'upsert' ? !recorded.length : !TX_WRITES.has(op) && client[model][op];
          if (immediate) {
            if (recorded.length) {
              throw new Error(
                `drizzle-compat: tx.${model}.${op}() after a write isn't supported in a D1 ` +
                  "transaction (it can't see the pending writes)",
              );
            }
            return client[model][op](args);
          }
          const item = TX_WRITES.has(op) && client[model][op](args)[BATCH];
          if (!item) {
            throw new Error(
              `drizzle-compat: tx.${model}.${op}() isn't supported in a D1 transaction`,
            );
          }
          const placeholder = new Proxy(
            {},
            {
              get: (_, prop) => {
                // `then` is probed when the placeholder is awaited/returned.
                if (prop === 'then' || typeof prop === 'symbol') return undefined;
                throw new Error(
                  `drizzle-compat: tx.${model}.${op}() result isn't available until the D1 ` +
                    'transaction commits; return it from the callback instead',
                );
              },
            },
          );
          placeholders.set(placeholder, recorded.push(item) - 1);
          return Promise.resolve(placeholder);
        },
      });
    },
  });

  const ret = await input(tx);
  const results = await runBatch(recorded);
  return placeholders.has(ret) ? results[placeholders.get(ret)] : ret;
}

export default {
  client,
  db,
  transaction,
  getAddIntervalQuery,
  getCastColumnQuery,
  getDayDiffQuery,
  getDateSQL,
  getDateStringSQL,
  getDateWeeklySQL,
  getFilterQuery,
  getPropertyFilterQuery,
  // D1 has no schemas; src/lib/prisma.ts's named getSchema() defers to this.
  getSchema: (): string | null => null,
  getSearchParameters,
  getTimestampDiffSQL,
  getSearchSQL,
  pagedQuery,
  pagedRawQuery,
  parseFilters,
  rawQuery,
  // D1 has one primary; reads and writes go to it.
  writeRawQuery: rawQuery,
};
