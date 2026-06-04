import { PrismaD1 } from '@prisma/adapter-d1';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import debug from 'debug';
import { PrismaClient } from '@/generated/prisma-d1/client';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS, OPERATORS, SESSION_COLUMNS } from './constants';
import { filtersObjectToArray } from './params';
import type { Operator, QueryFilters, QueryOptions } from './types';

const log = debug('umami:prisma-d1');

const PRISMA_D1 = 'prisma-d1';

// SQLite has no native interval type. We use sqlite datetime modifiers: e.g.
//   datetime(field, '+1 hour'). The caller passes the modifier directly.
function getAddIntervalQuery(field: string, interval: string): string {
  return `datetime(${field}, '${interval}')`;
}

// julianday() returns days as a real number; cast to int for whole-day diff.
function getDayDiffQuery(field1: string, field2: string): string {
  return `CAST(julianday(${field1}) - julianday(${field2}) AS INTEGER)`;
}

function getCastColumnQuery(field: string, type: string): string {
  // Map PG-flavored cast names to SQLite equivalents where possible.
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

// SQLite strftime format strings. No timezone support beyond UTC offsets passed
// via 'utc'/'localtime' modifiers; for now we ignore non-utc timezones.
const SQLITE_DATE_FORMATS = {
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
  // SQLite's strftime('%w', ...) returns day-of-week (0=Sunday). Concatenate with hour.
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
      // SQLite has no array IN with a single placeholder. We pass arrays as
      // JSON strings and unpack with json_each().
      return `${table}.${column} IN (SELECT value FROM json_each(${value}))`;
    case OPERATORS.notEquals:
      return `${table}.${column} NOT IN (SELECT value FROM json_each(${value}))`;
    case OPERATORS.contains:
      return `${table}.${column} LIKE ${value} COLLATE NOCASE`;
    case OPERATORS.doesNotContain:
      return `${table}.${column} NOT LIKE ${value} COLLATE NOCASE`;
    case OPERATORS.regex:
    case OPERATORS.notRegex:
      // D1 / SQLite have no regex by default. Callers using these operators
      // must either disable the filter or move regex evaluation to the app.
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
          // PG used regexp_replace to strip www.; SQLite has no regex. Use
          // a LIKE-based filter that matches the common case.
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
        // D1 mapFilter unpacks with json_each(); pass the array as a JSON string.
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

async function rawQuery(sql: string, data: Record<string, any>, name?: string): Promise<any> {
  if (process.env.LOG_QUERY) {
    log('QUERY:\n', sql);
    log('PARAMETERS:\n', data);
    log('NAME:\n', name);
  }

  const params: any[] = [];

  // Convert {{name}} / {{name::type}} placeholders to positional ? bindings.
  // The ::type cast hint is discarded; SQLite is dynamically typed.
  const query = sql?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, key] = args;
    params.push(data[key]);
    return '?';
  });

  return client.$queryRawUnsafe(query, ...params);
}

async function pagedQuery<T>(model: string, criteria: T, filters?: QueryFilters) {
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = +pageSize || DEFAULT_PAGE_SIZE;

  const data = await client[model].findMany({
    ...criteria,
    ...{
      ...(size > 0 && { take: +size, skip: +size * (+page - 1) }),
      ...(orderBy && {
        orderBy: [
          {
            [orderBy]: sortDescending ? 'desc' : 'asc',
          },
        ],
      }),
    },
  });

  const count = await client[model].count({ where: (criteria as any).where });

  return { data, count, page: +page, pageSize: size, orderBy, search };
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

  const count = await rawQuery(`select count(*) as num from (${query}) t`, queryParams).then(
    (res: any) => res[0].num,
  );

  const data = await rawQuery(`${query}${statements}`, queryParams, name);

  return { data, count, page: +page, pageSize: size, orderBy };
}

function getSearchParameters(query: string, filters: Record<string, any>[]) {
  if (!query) return;

  const parseFilter = (filter: Record<string, any>) => {
    const [[key, value]] = Object.entries(filter);

    return {
      [key]:
        typeof value === 'string'
          ? {
              [value]: query,
              // SQLite via Prisma adapter: 'insensitive' mode is not supported;
              // upstream consumers may need to drop this option for D1. For
              // now we keep it — Prisma will emit a runtime warning if unused.
              mode: 'insensitive',
            }
          : parseFilter(value),
    };
  };

  const params = filters.map(filter => parseFilter(filter));

  return {
    AND: {
      OR: params,
    },
  };
}

function transaction(input: any, options?: any) {
  return client.$transaction(input, options);
}

function getClient(): PrismaClient {
  // getCloudflareContext() works in Workers runtime and (via initOpenNext-
  // CloudflareForDev) in `next dev` when CF_DEV=1. Outside both contexts it
  // throws, so we defer construction until first use.
  const { env } = getCloudflareContext();
  const adapter = new PrismaD1(env.DB);
  const c = new PrismaClient({ adapter, errorFormat: 'pretty' });
  log('Prisma D1 initialized');
  return c;
}

const client: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const instance = (globalThis[PRISMA_D1] ??= getClient());
    return Reflect.get(instance, prop, instance);
  },
});

export default {
  client,
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
