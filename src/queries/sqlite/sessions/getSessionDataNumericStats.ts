import { EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { PropertyFilter, QueryFilters } from '@/lib/types';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

const FUNCTION_NAME = 'getSessionDataNumericStats';

// SQLite has no percentile_cont; the median uses percentileCont() from
// _helpers.ts over the same rows the other aggregates read. number_value is
// REAL here (PG: numeric(19, 4)), so the total is rounded to 4 places to drop
// float error, matching PG's exact numeric sum.
export async function sqliteGetSessionDataNumericStats(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
) {
  const { timezone = 'utc' } = filters;
  const { rawQuery, parseFilters, getPropertyFilterQuery } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(
    propertyFilters,
    'session',
    timezone,
  );

  return rawQuery(
    `
    with filtered_sessions as (
      select distinct website_event.session_id, website_event.website_id
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type != ${EVENT_TYPE.performance}
        ${filterQuery}
        ${pfSQL}
    ),
    ranked as (
      select ${percentileRanks('session_data.number_value')}
      from session_data
      join filtered_sessions
        on filtered_sessions.session_id = session_data.session_id
          and filtered_sessions.website_id = session_data.website_id
      where session_data.website_id = {{websiteId}}
        and session_data.data_key = {{propertyName}}
        and session_data.data_type = 2
    )
    select
      coalesce(round(sum(x), 4), 0) as "total",
      coalesce(avg(x), 0) as "average",
      coalesce(${percentileCont(0.5)}, 0) as "median",
      coalesce(max(x), 0) as "max",
      coalesce(min(x), 0) as "min"
    from ranked
    `,
    { ...queryParams, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}

export default sqliteGetSessionDataNumericStats;
