import { EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { PageResult, PropertyFilter, QueryFilters, SessionDataPivotRow } from '@/lib/types';
import { numberText, parseJsonArrays } from '@/queries/sqlite/_propertyData';

const FUNCTION_NAME = 'getSessionDataPivot';

// PG's array_agg(... order by data_key) becomes json_group_array(... order by
// data_key), parsed back to string[]; numbers render as PG's numeric(19, 4) text.
export async function sqliteGetSessionDataPivot(
  websiteId: string,
  propertyName: string,
  filters: QueryFilters,
  propertyFilters: PropertyFilter[] = [],
): Promise<PageResult<SessionDataPivotRow[]>> {
  const { timezone = 'utc' } = filters;
  const { pagedRawQuery, parseFilters, getPropertyFilterQuery, getDateStringSQL } = prisma;

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

  const result = await pagedRawQuery(
    `
    with filtered_sessions as (
      select distinct website_event.session_id
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        and website_event.event_type != ${EVENT_TYPE.performance}
        ${filterQuery}
        ${pfSQL}
    ),
    latest_session_properties as (
      select
        ranked.session_id,
        ranked.distinct_id,
        ranked.created_at,
        ranked.data_key,
        ranked.data_type,
        ranked.string_value,
        ranked.number_value,
        ranked.date_value
      from (
        select
          session_data.session_id,
          session_data.distinct_id,
          session_data.created_at,
          session_data.data_key,
          session_data.data_type,
          session_data.string_value,
          session_data.number_value,
          session_data.date_value,
          row_number() over (
            partition by session_data.session_id, session_data.data_key
            order by session_data.created_at desc, session_data.session_data_id desc
          ) as row_num
        from session_data
        join filtered_sessions
          on filtered_sessions.session_id = session_data.session_id
        where session_data.website_id = {{websiteId}}
      ) ranked
      where ranked.row_num = 1
    ),
    paged_sessions as (
      select
        latest_session_properties.session_id,
        latest_session_properties.created_at as sort_created_at
      from latest_session_properties
      where latest_session_properties.data_key = {{propertyName}}
    )
    select
      latest_session_properties.session_id as "sessionId",
      coalesce(max(latest_session_properties.distinct_id), '') as "distinctId",
      max(latest_session_properties.created_at) as "createdAt",
      json_group_array(latest_session_properties.data_key order by latest_session_properties.data_key asc) as "propertyKeys",
      json_group_array(
        coalesce(
          case when latest_session_properties.data_type = 1 then latest_session_properties.string_value end,
          case when latest_session_properties.data_type = 2 then ${numberText('latest_session_properties.number_value')} end,
          case when latest_session_properties.data_type = 3 then latest_session_properties.string_value end,
          case when latest_session_properties.data_type = 4 then ${getDateStringSQL('latest_session_properties.date_value', 'second', timezone)} end,
          case when latest_session_properties.data_type = 5 then latest_session_properties.string_value end,
          ''
        )
        order by latest_session_properties.data_key asc
      ) as "propertyValues"
    from latest_session_properties
    join paged_sessions
      on paged_sessions.session_id = latest_session_properties.session_id
    group by latest_session_properties.session_id, paged_sessions.sort_created_at
    order by paged_sessions.sort_created_at desc
    `,
    { ...queryParams, websiteId, propertyName, ...pfParams },
    filters,
    FUNCTION_NAME,
  );

  return { ...result, data: parseJsonArrays(result.data, ['propertyKeys', 'propertyValues']) };
}

export default sqliteGetSessionDataPivot;
