import { FILTER_COLUMNS, SESSION_COLUMNS } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  PageviewMetricsData,
  PageviewMetricsParameters,
} from '@/queries/sql/pageviews/getPageviewMetrics';

const FUNCTION_NAME = 'getPageviewMetrics';

export async function sqliteGetPageviewMetrics(
  websiteId: string,
  parameters: PageviewMetricsParameters,
  filters: QueryFilters,
): Promise<PageviewMetricsData[]> {
  const { type, limit = 500, offset = 0 } = parameters;
  let column = getPageviewColumn(type);
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
    parseFilters(
      {
        ...filters,
        websiteId,
      },
      { joinSession: SESSION_COLUMNS.includes(type) },
    );
  const fullPathSearchQuery =
    type === 'fullPath' && filters.search ? `and (${FULL_PATH_SQL}) LIKE {{fullPathSearch}}` : '';

  let entryExitQuery = '';
  let excludeDomain = '';

  if (column === 'referrer_domain') {
    // PG: regexp_replace(website_event.hostname, '^www.', '').
    excludeDomain = `and website_event.referrer_domain != (case
        when substr(website_event.hostname, 1, 3) = 'www' and length(website_event.hostname) > 3
        then substr(website_event.hostname, 5)
        else website_event.hostname end)
      and website_event.referrer_domain != ''`;
  }

  if (type === 'entry' || type === 'exit') {
    // SQLite has no `distinct on (col)`. Use ROW_NUMBER() over a partition,
    // which is available in SQLite 3.25+ (D1 supports it).
    const order = type === 'entry' ? 'asc' : 'desc';

    entryExitQuery = `
      join (
        select visit_id, url_path, url_query from (
          select
            visit_id,
            url_path,
            url_query,
            row_number() over (partition by visit_id order by created_at ${order}) as _rn
          from website_event
          where website_event.website_id = {{websiteId}}
            and website_event.created_at between {{startDate}} and {{endDate}}
            and website_event.event_type NOT IN (2, 5)
        )
        where _rn = 1
      ) x
      on x.visit_id = website_event.visit_id
    `;

    column = `x.${FILTER_COLUMNS[type] || type}`;
  }

  const selectColumn = type === 'fullPath' ? FULL_PATH_SQL : column;

  return rawQuery(
    `
    select ${selectColumn} x,
      count(distinct website_event.session_id) as y
    from website_event
    ${cohortQuery}
    ${excludeBounceQuery}
    ${joinSessionQuery}
    ${entryExitQuery}
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type NOT IN (2, 5)
      and ${column} != ''
      ${excludeDomain}
      ${fullPathSearchQuery}
      ${filterQuery}
    group by 1
    order by 2 desc
    limit ${limit}
    offset ${offset}
    `,
    {
      ...queryParams,
      ...parameters,
      ...(type === 'fullPath' && filters.search ? { fullPathSearch: `%${filters.search}%` } : {}),
    },
    FUNCTION_NAME,
  );
}

const FULL_PATH_SQL = `case when website_event.url_query != '' then website_event.url_path || '?' || website_event.url_query else website_event.url_path end`;

function getPageviewColumn(type: string) {
  if (type === 'fullPath') {
    return 'url_path';
  }

  return FILTER_COLUMNS[type] || type;
}

export default sqliteGetPageviewMetrics;
