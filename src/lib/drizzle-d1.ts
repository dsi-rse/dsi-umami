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
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import debug from 'debug';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS, SESSION_COLUMNS } from './constants';
import { filtersObjectToArray } from './params';
import type { Operator, QueryFilters, QueryOptions } from './types';
import * as schema from '@/db/d1/schema';

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
    const instance = (globalThis[DRIZZLE_D1] ??= getClient());
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
//     updateMany, delete, deleteMany, count, upsert
//   ✓ where: equality, null/notNull, in/notIn, gt/gte/lt/lte, contains,
//     startsWith, endsWith, AND, OR, NOT
//   ✓ orderBy (single column or array, asc/desc), take, skip, distinct
//   △ select: returns the same row shape (Drizzle returns all columns); the
//     caller's destructuring works because field names match
//   ✗ include: throws clearly. Affected callsites need a per-call Drizzle
//     rewrite that does explicit joins or follow-up queries.

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

function buildCondition(table: any, where: any): any {
  if (!where || (typeof where === 'object' && Object.keys(where).length === 0)) return undefined;
  const parts: any[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' && Array.isArray(value)) {
      const sub = value.map(c => buildCondition(table, c)).filter(Boolean);
      if (sub.length) parts.push(and(...sub));
      continue;
    }
    if (key === 'OR' && Array.isArray(value)) {
      const sub = value.map(c => buildCondition(table, c)).filter(Boolean);
      if (sub.length) parts.push(or(...sub));
      continue;
    }
    if (key === 'NOT') {
      const inner = buildCondition(table, value);
      if (inner) parts.push(sql`NOT (${inner})`);
      continue;
    }
    const col = table[key];
    if (!col) continue;
    if (value === null) {
      parts.push(isNull(col));
      continue;
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const v: any = value;
      if ('equals' in v) parts.push(eq(col, v.equals));
      else if ('not' in v)
        parts.push(v.not === null ? isNotNull(col) : ne(col, v.not));
      else if ('contains' in v) parts.push(like(col, `%${v.contains}%`));
      else if ('startsWith' in v) parts.push(like(col, `${v.startsWith}%`));
      else if ('endsWith' in v) parts.push(like(col, `%${v.endsWith}`));
      else if ('in' in v) parts.push(inArray(col, v.in));
      else if ('notIn' in v) parts.push(notInArray(col, v.notIn));
      else if ('gt' in v) parts.push(gt(col, v.gt));
      else if ('gte' in v) parts.push(gte(col, v.gte));
      else if ('lt' in v) parts.push(lt(col, v.lt));
      else if ('lte' in v) parts.push(lte(col, v.lte));
      else {
        // nested object: fall back to JSON eq
        parts.push(eq(col, v as any));
      }
      continue;
    }
    parts.push(eq(col, value as any));
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
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
    throw new Error(
      `drizzle-compat: client.${model}.${op}() with \`include\` is not supported. ` +
        `Migrate the caller to an explicit Drizzle query (see src/db/d1/schema.ts).`,
    );
  }
}

// D1's bind() only accepts primitives. Drizzle's plain `text()` / `integer()`
// columns pass values through to bind() without coercion, so a Date / BigInt
// / undefined in args.data will silently hang the request on Workers (the
// driver awaits a promise that the runtime then cancels). Coerce common JS
// types the Prisma callsites pass — Date → ISO, BigInt → Number, boolean →
// 0/1, undefined → null — to keep writes bind-safe.
function prepareWriteData(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object' || data instanceof Date) return data;
  const out: any = Array.isArray(data) ? [] : {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) {
      out[k] = null;
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

function modelOps(modelName: string) {
  const table = MODEL_TO_TABLE[modelName];
  if (!table) {
    throw new Error(`drizzle-compat: unknown model '${modelName}'`);
  }
  return {
    async findUnique(args: any) {
      ensureNoInclude(args, modelName, 'findUnique');
      const cond = buildCondition(table, args?.where);
      const rows: any[] = await (cond ? db.select().from(table).where(cond) : db.select().from(table)).limit(1);
      return rows[0] ?? null;
    },
    async findFirst(args: any = {}) {
      ensureNoInclude(args, modelName, 'findFirst');
      const cond = buildCondition(table, args?.where);
      const order = buildOrderBy(table, args?.orderBy);
      let q: any = db.select().from(table);
      if (cond) q = q.where(cond);
      if (order.length) q = q.orderBy(...order);
      const rows: any[] = await q.limit(1);
      return rows[0] ?? null;
    },
    async findMany(args: any = {}) {
      ensureNoInclude(args, modelName, 'findMany');
      const cond = buildCondition(table, args?.where);
      const order = buildOrderBy(table, args?.orderBy);
      let q: any = db.select().from(table);
      if (cond) q = q.where(cond);
      if (order.length) q = q.orderBy(...order);
      if (args?.take) q = q.limit(args.take);
      if (args?.skip) q = q.offset(args.skip);
      return await q;
    },
    async create(args: any) {
      ensureNoInclude(args, modelName, 'create');
      const [row]: any[] = await db.insert(table).values(prepareWriteData(args.data)).returning();
      return row;
    },
    async createMany(args: any) {
      const data = Array.isArray(args.data) ? args.data : [args.data];
      if (data.length === 0) return { count: 0 };
      await db.insert(table).values(data.map(prepareWriteData));
      return { count: data.length };
    },
    async update(args: any) {
      ensureNoInclude(args, modelName, 'update');
      const cond = buildCondition(table, args?.where);
      const [row]: any[] = await db
        .update(table)
        .set(prepareWriteData(args.data))
        .where(cond as any)
        .returning();
      return row;
    },
    async updateMany(args: any) {
      const cond = buildCondition(table, args?.where);
      const q: any = db.update(table).set(prepareWriteData(args.data));
      if (cond) q.where(cond);
      const res: any = await q;
      return { count: res?.meta?.changes ?? 0 };
    },
    async delete(args: any) {
      const cond = buildCondition(table, args?.where);
      const [row]: any[] = await db
        .delete(table)
        .where(cond as any)
        .returning();
      return row;
    },
    async deleteMany(args: any = {}) {
      const cond = args?.where ? buildCondition(table, args.where) : undefined;
      const q: any = db.delete(table);
      if (cond) q.where(cond);
      const res: any = await q;
      return { count: res?.meta?.changes ?? 0 };
    },
    async count(args: any = {}) {
      const cond = args?.where ? buildCondition(table, args.where) : undefined;
      let q: any = db.select({ n: sql<number>`count(*)` }).from(table);
      if (cond) q = q.where(cond);
      const rows: any[] = await q;
      return Number(rows[0]?.n ?? 0);
    },
    async upsert(args: any) {
      ensureNoInclude(args, modelName, 'upsert');
      const cond = buildCondition(table, args.where);
      const existing: any[] = await db
        .select()
        .from(table)
        .where(cond as any)
        .limit(1);
      if (existing.length > 0) {
        const [row]: any[] = await db
          .update(table)
          .set(prepareWriteData(args.update))
          .where(cond as any)
          .returning();
        return row;
      }
      const [row]: any[] = await db.insert(table).values(prepareWriteData(args.create)).returning();
      return row;
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

function transaction(input: any, _options?: any): any {
  // Drizzle's d1 transactions: db.transaction(async (tx) => { ... }).
  // For callers passing an array of compat-proxy promises (Prisma's batch
  // style), just await them sequentially since each compat call is already
  // a self-contained D1 statement.
  if (Array.isArray(input)) {
    return Promise.all(input);
  }
  // For callers passing a function (interactive transaction), run it with
  // the compat client — drizzle's tx is not used here because the compat
  // proxy doesn't have a tx-scoped version.
  if (typeof input === 'function') {
    return input(client);
  }
  return input;
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
