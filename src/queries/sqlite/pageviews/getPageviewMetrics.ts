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
  let column = FILTER_COLUMNS[type] || type;
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
    parseFilters(
      {
        ...filters,
        websiteId,
      },
      { joinSession: SESSION_COLUMNS.includes(type) },
    );

  let entryExitQuery = '';
  let excludeDomain = '';

  if (column === 'referrer_domain') {
    excludeDomain = `and website_event.referrer_domain != replace(website_event.hostname, 'www.', '')
      and website_event.referrer_domain != ''`;
  }

  if (type === 'entry' || type === 'exit') {
    // SQLite has no `distinct on (col)`. Use ROW_NUMBER() over a partition,
    // which is available in SQLite 3.25+ (D1 supports it).
    const order = type === 'entry' ? 'asc' : 'desc';
    column = `x.${column}`;

    entryExitQuery = `
      join (
        select visit_id, url_path from (
          select
            visit_id,
            url_path,
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
  }

  return rawQuery(
    `
    select ${column} x,
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
      ${filterQuery}
    group by 1
    order by 2 desc
    limit ${limit}
    offset ${offset}
    `,
    { ...queryParams, ...parameters },
    FUNCTION_NAME,
  );
}

export default sqliteGetPageviewMetrics;
