import prisma from '@/lib/prisma';
import type { EventDataPivotRow, EventPropertyFilter, PageResult, QueryFilters } from '@/lib/types';
import { numberText, parseJsonArrays } from '@/queries/sqlite/_propertyData';

const FUNCTION_NAME = 'getEventDataPivot';

// PG's array_agg(... order by data_key) becomes json_group_array(... order by
// data_key), parsed back to string[]; numbers render as PG's numeric(19, 4) text.
export async function sqliteGetEventDataPivot(
  websiteId: string,
  eventName: string,
  filters: QueryFilters,
  eventFilters: EventPropertyFilter[] = [],
): Promise<PageResult<EventDataPivotRow[]>> {
  const { timezone = 'utc' } = filters;
  const { pagedRawQuery, parseFilters, getPropertyFilterQuery, getDateStringSQL } = prisma;

  const { filterQuery, cohortQuery, joinSessionQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    timezone,
  });
  const { sql: pfSQL, params: pfParams } = getPropertyFilterQuery(eventFilters, 'event', timezone);

  const result = await pagedRawQuery(
    `
    with paged_events as (
      select website_event.event_id, max(website_event.created_at) as sort_created_at
      from website_event
      join event_data on event_data.website_event_id = website_event.event_id
        and event_data.website_id = {{websiteId}}
        and event_data.created_at between {{startDate}} and {{endDate}}
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_name = {{eventName}}
        ${filterQuery}
        ${pfSQL}
      group by website_event.event_id
    )
    select
      website_event.event_id as "eventId",
      website_event.session_id as "sessionId",
      website_event.event_name as "eventName",
      website_event.url_path as "urlPath",
      max(website_event.created_at) as "createdAt",
      json_group_array(event_data.data_key order by event_data.data_key asc) as "propertyKeys",
      json_group_array(
        coalesce(
          case when event_data.data_type = 1 then event_data.string_value end,
          case when event_data.data_type = 2 then ${numberText('event_data.number_value')} end,
          case when event_data.data_type = 3 then event_data.string_value end,
          case when event_data.data_type = 4 then ${getDateStringSQL('event_data.date_value', 'second', timezone)} end,
          case when event_data.data_type = 5 then event_data.string_value end,
          ''
        )
        order by event_data.data_key asc
      ) as "propertyValues"
    from event_data
    join website_event on website_event.event_id = event_data.website_event_id
      and website_event.website_id = {{websiteId}}
    join paged_events on paged_events.event_id = event_data.website_event_id
    where event_data.website_id = {{websiteId}}
      and event_data.created_at between {{startDate}} and {{endDate}}
    group by
      website_event.event_id,
      website_event.session_id,
      website_event.event_name,
      website_event.url_path,
      paged_events.sort_created_at
    order by paged_events.sort_created_at desc
    `,
    { ...queryParams, eventName, ...pfParams },
    filters,
    FUNCTION_NAME,
  );

  return { ...result, data: parseJsonArrays(result.data, ['propertyKeys', 'propertyValues']) };
}

export default sqliteGetEventDataPivot;
