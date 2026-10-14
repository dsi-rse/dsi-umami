import { DATA_TYPE, EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { EventDataSeriesPoint, PropertyFilter, QueryFilters } from '@/lib/types';
import { arrayItemText, jsonArrayItems } from '@/queries/sqlite/_propertyData';

const FUNCTION_NAME = 'getSessionDataArraySeries';

// PG's jsonb_array_elements_text lateral join becomes json_each (see _propertyData.ts).
export async function sqliteGetSessionDataArraySeries(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
): Promise<EventDataSeriesPoint[]> {
  const { timezone = 'utc', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters, getPropertyFilterQuery } = prisma;
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
    select
      ${arrayItemText('session_data.string_value')} as x,
      ${getDateSQL('session_data.created_at', unit, timezone)} as t,
      count(distinct session_data.session_id) as y
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    join session_data
      on session_data.session_id = website_event.session_id
        and session_data.website_id = website_event.website_id
    cross join ${jsonArrayItems('session_data.string_value')}
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and session_data.data_key = {{propertyName}}
      and session_data.data_type = ${DATA_TYPE.array}
      ${filterQuery}
      ${pfSQL}
    group by 1, 2
    order by 2
    `,
    { ...queryParams, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}

export default sqliteGetSessionDataArraySeries;
