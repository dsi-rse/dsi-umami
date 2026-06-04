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
  let column = FILTER_COLUMNS[type] || type;
  const { rawQuery, parseFilters, getTimestampDiffSQL } = prisma;
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

  return rawQuery(
    `
    select
      name,
      sum(t.c) as "pageviews",
      count(distinct t.session_id) as "visitors",
      count(distinct t.visit_id) as "visits",
      sum(case when t.c = 1 then 1 else 0 end) as "bounces",
      sum(${getTimestampDiffSQL('t.min_time', 't.max_time')}) as "totaltime"
    from (
      select
        ${column} as "name",
        website_event.session_id,
        website_event.visit_id,
        count(*) as "c",
        min(website_event.created_at) as "min_time",
        max(website_event.created_at) as "max_time"
      from website_event
      ${cohortQuery}
      ${excludeBounceQuery}
      ${joinSessionQuery}
      ${entryExitQuery}
      where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type NOT IN (2, 5)
        ${excludeDomain}
        ${filterQuery}
      group by ${column}, website_event.session_id, website_event.visit_id
    ) as t
    where name != ''
    group by name
    order by visitors desc, visits desc
    limit ${limit}
    offset ${offset}
    `,
    queryParams,
    FUNCTION_NAME,
  );
}

export default sqliteGetPageviewExpandedMetrics;
