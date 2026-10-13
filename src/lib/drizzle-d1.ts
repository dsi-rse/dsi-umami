/**
 * Drizzle-backed replacement for src/lib/prisma-d1.ts. Same default-export
 * shape (`{ client, transaction, rawQuery, parseFilters, getDateSQL, ... }`)
 * so src/lib/prisma.ts's dispatch and the existing src/queries/sql/ + sqlite/
 * call sites continue to work.
 *
 * Why Drizzle and not Prisma: Cloudflare Workers blocks runtime
 * `new WebAssembly.Module()` ("Wasm code generation disallowed"). Prisma 7's
 * generated D1 client compiles a 4.6MB SQLite query-compiler WASM at request
 * time. Drizzle is hand-rolled JS with no WASM dependency on D1.
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
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS, SESSION_COLUMNS } from './constants';
import { filtersObjectToArray } from './params';
import type { Operator, QueryFilters, QueryOptions } from './types';

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
//     updateMany, delete, deleteMany, count (no upsert: nothing calls it)
//   ✓ where: equality, null/notNull, in/notIn, gt/gte/lt/lte, contains,
//     startsWith, endsWith, AND, OR, NOT, and the relation filters listed in
//     RELATIONS. Unknown keys/operators throw.
//   ✓ transaction([...]) and transaction(async tx => ...) as one atomic
//     db.batch() (writes only)
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
// so objects pass through for Drizzle to stringify.
function prepareWriteData(data: any): any {
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
      const data = prepareWriteData(args.data);
      // Nothing left to set (all undefined): Prisma returns the row unchanged.
      if (isEmpty(data)) return deferred([db.select(cols).from(table).where(cond).limit(1)], first);
      return deferred([db.update(table).set(data).where(cond).returning(cols)], first);
    },
    updateMany(args: any) {
      const cond = buildCondition(table, args?.where);
      const data = prepareWriteData(args.data);
      if (isEmpty(data)) {
        const q: any = db.select({ n: sql<number>`count(*)` }).from(table);
        return deferred([cond ? q.where(cond) : q], ([rows]) => ({ count: Number(rows[0].n) }));
      }
      const q: any = db.update(table).set(data);
      return deferred([cond ? q.where(cond) : q], changes);
    },
    delete(args: any) {
      const cond = requireCondition(buildCondition(table, args?.where), modelName, 'delete');
      const cols = projection(table, args, modelName, 'delete');
      return deferred([db.delete(table).where(cond).returning(cols)], first);
    },
    deleteMany(args: any = {}) {
      const cond = buildCondition(table, args?.where);
      const q: any = db.delete(table);
      const prelude = BULK_TABLES.has(table) ? () => purgeInChunks(table, cond) : undefined;
      return deferred([cond ? q.where(cond) : q], changes, prelude);
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
// These match the prisma-d1.ts API. Existing src/queries/sqlite/*.ts and the
// 12 src/queries/sql/*.ts dispatch points call these via `prisma.getDateSQL`
// etc. — keep the names and signatures stable.

function getAddIntervalQuery(field: string, interval: string): string {
  return `datetime(${field}, '${interval}')`;
}

function getDayDiffQuery(field1: string, field2: string): string {
  return `CAST(julianday(${field1}) - julianday(${field2}) AS INTEGER)`;
}

function getCastColumnQuery(field: string, type: string): string {
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
      date: 'TEXT',
      timestamp: 'TEXT',
      timestamptz: 'TEXT',
    }[type.toLowerCase()] ?? type.toUpperCase();
  return `CAST(${field} AS ${sqliteType})`;
}

const SQLITE_DATE_FORMATS: Record<string, string> = {
  minute: '%Y-%m-%d %H:%M:00',
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d 00:00:00',
  month: '%Y-%m-01 00:00:00',
  year: '%Y-01-01 00:00:00',
};

function getDateSQL(field: string, unit: string, _timezone?: string): string {
  return `strftime('${SQLITE_DATE_FORMATS[unit]}', ${field})`;
}

function getDateWeeklySQL(field: string, _timezone?: string) {
  return `(strftime('%w', ${field}) || ':' || strftime('%H', ${field}))`;
}

export function getTimestampSQL(field: string) {
  return `unixepoch(${field})`;
}

function getTimestampDiffSQL(field1: string, field2: string): string {
  return `(unixepoch(${field2}) - unixepoch(${field1}))`;
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
            `and (website_event.referrer_domain != replace(website_event.hostname, 'www.', '') or website_event.referrer_domain is null)`,
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
    (select distinct session_id, visit_id
    from website_event
    where website_id = {{websiteId}}
      and created_at between {{startDate}} and {{endDate}}
      and event_type = 1
    group by session_id, visit_id
    having count(*) > 1
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

function parseFilters(filters: Record<string, any>, options?: QueryOptions) {
  const joinSession = Object.keys(filters).find(key => {
    const baseName = key.replace(/\d+$/, '');
    return ['referrer', ...SESSION_COLUMNS].includes(baseName);
  });

  const cohortFilters = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key.startsWith('cohort_')),
  );

  return {
    joinSessionQuery:
      options?.joinSession || joinSession
        ? `inner join session on website_event.session_id = session.session_id and website_event.website_id = session.website_id`
        : '',
    dateQuery: getDateQuery(filters),
    filterQuery: getFilterQuery(filters, options),
    queryParams: getQueryParams(filters),
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

  const params: any[] = [];
  const query = sqlText?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, key] = args;
    params.push(bindable(data[key]));
    return '?';
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
) {
  const { page = 1, pageSize, orderBy, sortDescending = false } = filters;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (+page - 1);
  const direction = sortDescending ? 'desc' : 'asc';

  const statements = [
    orderBy && `order by ${orderBy} ${direction}`,
    +size > 0 && `limit ${+size} offset ${offset}`,
  ]
    .filter(n => n)
    .join('\n');

  const countResult = await rawQuery(`select count(*) as num from (${query}) t`, queryParams);
  const count = Number(countResult?.[0]?.num ?? 0);

  const data = await rawQuery(`${query}${statements}`, queryParams, name);

  return { data, count, page: +page, pageSize: size, orderBy };
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

const TX_WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']);

// Prisma's $transaction on D1. Both forms become a single db.batch(), which
// D1 runs atomically. The callback form records writes rather than running
// them: reads inside it throw, nothing commits until the callback returns
// (side effects in it run first), and an awaited write's result is a
// placeholder that throws if used. Only the write the callback returns
// resolves to its real row.
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
    get: (_, model: string) =>
      new Proxy({} as any, {
        get: (_, op: string) => (args: any) => {
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
      }),
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
  getDateWeeklySQL,
  getFilterQuery,
  getSearchParameters,
  getTimestampDiffSQL,
  getSearchSQL,
  pagedQuery,
  pagedRawQuery,
  parseFilters,
  rawQuery,
};
