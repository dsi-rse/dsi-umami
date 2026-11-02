import { DATA_TYPE, EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { PropertyValue, QueryFilters } from '@/lib/types';
import { arrayItemText, jsonArrayItems } from '@/queries/sqlite/_propertyData';

const FUNCTION_NAME = 'getSessionDataValues';

// Same as PG except the array branch: jsonb_array_elements_text becomes
// json_each (see _propertyData.ts). Group by position, not `value`, which
// json_each also has as a column.
export async function sqliteGetSessionDataValues(
  websiteId: string,
  filters: QueryFilters & { propertyName?: string; dataType?: number },
): Promise<PropertyValue[]> {
  const { rawQuery, parseFilters, getDateSQL } = prisma;
  const { dataType } = filters;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  if (dataType === DATA_TYPE.array) {
    return rawQuery(
      `
      select
        ${arrayItemText('session_data.string_value')} as "value",
        count(*) as "total"
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
      group by 1
      order by 2 desc
      limit 500
      `,
      queryParams,
      FUNCTION_NAME,
    );
  }

  return rawQuery(
    `
    select
      case
        when data_type = 2 then replace(string_value, '.0000', '')
        when data_type = 4 then ${getDateSQL('date_value', 'hour')}
        else string_value
      end as "value",
      count(*) as "total"
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    join session_data
        on session_data.session_id = website_event.session_id
          and session_data.website_id = website_event.website_id
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and website_event.event_type != ${EVENT_TYPE.performance}
      and session_data.data_key = {{propertyName}}
      ${dataType ? `and session_data.data_type = ${dataType}` : ''}
    ${filterQuery}
    group by 1
    order by 2 desc
    limit 500
    `,
    queryParams,
    FUNCTION_NAME,
  );
}

export default sqliteGetSessionDataValues;
