import { FILTER_COLUMNS, GROUPED_DOMAINS, SESSION_COLUMNS } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  PageviewExpandedMetricsData,
  PageviewExpandedMetricsParameters,
} from '@/queries/sql/pageviews/getPageviewExpandedMetrics';
import { toSqliteGroupedReferrer } from '@/queries/sqlite/_helpers';

const FUNCTION_NAME = 'getPageviewExpandedMetrics';

export async function sqliteGetPageviewExpandedMetrics(
  websiteId: string,
  parameters: PageviewExpandedMetricsParameters,
  filters: QueryFilters,
): Promise<PageviewExpandedMetricsData[]> {
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
    if (type === 'domain') {
      column = toSqliteGroupedReferrer(GROUPED_DOMAINS);
    }
  }

  if (type === 'entry' || type === 'exit') {
    const aggregrate = type === 'entry' ? 'min' : 'max';

    entryExitQuery = `
      join (
        select visit_id,
            ${aggregrate}(created_at) target_created_at
        from website_event
        where website_event.website_id = {{websiteId}}
          and website_event.created_at between {{startDate}} and {{endDate}}
          and website_event.event_type NOT IN (2, 5)
        group by visit_id
      ) x
      on x.visit_id = website_event.visit_id
          and x.target_created_at = website_event.created_at
    `;
  }

  const selectColumn = type === 'fullPath' ? FULL_PATH_SQL : column;
  const groupByColumn = type === 'fullPath' ? FULL_PATH_SQL : column;

  return rawQuery(
    `
    select
      name,
      sum(t.c) as "pageviews",
      count(distinct t.session_id) as "visitors",
      count(distinct t.visit_id) as "visits",
      0 as "bounces",
      0 as "totaltime"
    from (
      select
        ${selectColumn} as "name",
        website_event.session_id,
        website_event.visit_id,
        count(*) as "c"
      from website_event
      ${cohortQuery}
      ${excludeBounceQuery}
      ${joinSessionQuery}
      ${entryExitQuery}
      where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type NOT IN (2, 5)
        ${excludeDomain}
        ${fullPathSearchQuery}
        ${filterQuery}
      group by ${groupByColumn}, website_event.session_id, website_event.visit_id
    ) as t
    where name != ''
    group by name
    order by visitors desc, visits desc
    limit ${limit}
    offset ${offset}
    `,
    {
      ...queryParams,
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

export default sqliteGetPageviewExpandedMetrics;
