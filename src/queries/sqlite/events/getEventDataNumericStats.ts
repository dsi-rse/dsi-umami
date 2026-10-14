import prisma from '@/lib/prisma';
import type { EventPropertyFilter, QueryFilters } from '@/lib/types';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

const FUNCTION_NAME = 'getEventDataNumericStats';

// SQLite has no percentile_cont; the median uses percentileCont() from
// _helpers.ts over the same rows the other aggregates read. number_value is
// REAL here (PG: numeric(19, 4)), so the total is rounded to 4 places to drop
// float error, matching PG's exact numeric sum.
export async function sqliteGetEventDataNumericStats(
  websiteId: string,
  eventName: string,
  propertyName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
) {
  const { timezone = 'utc' } = filters;
  const { rawQuery, parseFilters, getPropertyFilterQuery } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  return rawQuery(
    `
    with ranked as (
      select ${percentileRanks('event_data.number_value')}
      from event_data
      join website_event on website_event.event_id = event_data.website_event_id
        and website_event.website_id = {{websiteId}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type = 2
        and website_event.event_name = {{eventName}}
      ${cohortQuery}
      ${joinSessionQuery}
      where event_data.website_id = {{websiteId}}
        and event_data.created_at between {{startDate}} and {{endDate}}
        and event_data.data_key = {{propertyName}}
        and event_data.data_type = 2
        ${filterQuery}
        ${pfSQL}
    )
    select
      coalesce(round(sum(x), 4), 0) as "total",
      coalesce(avg(x), 0) as "average",
      coalesce(${percentileCont(0.5)}, 0) as "median",
      coalesce(max(x), 0) as "max",
      coalesce(min(x), 0) as "min"
    from ranked
    `,
    { ...queryParams, eventName, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}

export default sqliteGetEventDataNumericStats;
