import { DATA_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { EventDataSeriesPoint, EventPropertyFilter, QueryFilters } from '@/lib/types';
import { arrayItemText, jsonArrayItems } from '@/queries/sqlite/_propertyData';

const FUNCTION_NAME = 'getEventDataArraySeries';

// PG's jsonb_array_elements_text lateral join becomes json_each (see _propertyData.ts).
export async function sqliteGetEventDataArraySeries(
  websiteId: string,
  eventName: string,
  propertyName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
): Promise<EventDataSeriesPoint[]> {
  const { timezone = 'utc', unit = 'day' } = filters;
  const { rawQuery, getDateSQL, parseFilters, getPropertyFilterQuery } = prisma;
  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  return rawQuery(
    `
    select
      ${arrayItemText('event_data.string_value')} as x,
      ${getDateSQL('event_data.created_at', unit, timezone)} as t,
      count(*) as y
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type = 2
      and website_event.event_name = {{eventName}}
    cross join ${jsonArrayItems('event_data.string_value')}
    ${cohortQuery}
    ${joinSessionQuery}
    where event_data.website_id = {{websiteId}}
      and event_data.created_at between {{startDate}} and {{endDate}}
      and event_data.data_key = {{propertyName}}
      and event_data.data_type = ${DATA_TYPE.array}
      ${filterQuery}
      ${pfSQL}
    group by 1, 2
    order by 2
    `,
    { ...queryParams, eventName, propertyName, ...pfParams },
    FUNCTION_NAME,
  );
}

export default sqliteGetEventDataArraySeries;
