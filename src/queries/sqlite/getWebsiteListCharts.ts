import { EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';

const FUNCTION_NAME = 'getWebsiteListCharts';
const BUCKET_HOURS = 12;

// Returns the PG relationalQuery's points; getWebsiteListCharts formats them.
// - Buckets: local wall time from getDateSQL(…, 'hour', timezone) (date in
//   chars 1-10, hour in 12-13), floored to 12 hours, as 'YYYY-MM-DD HH:00:00'.
// - GROUPING SETS ((websiteId, x), (websiteId)) -> UNION ALL of the bucket
//   rows and a per-website row with x = null (the window-wide distinct total).
// - any({{websiteIds}}::uuid[]) -> json_each over one JSON parameter.
export async function sqliteGetWebsiteListCharts(
  websiteIds: string[],
  startDate: Date,
  endDate: Date,
  timezone: string,
  eventType?: number,
): Promise<{ websiteId: string; x: string | null; y: number }[]> {
  const { rawQuery, getDateSQL } = prisma;
  const eventTypeQuery =
    eventType != null
      ? `and website_event.event_type = ${Number(eventType)}`
      : `and website_event.event_type NOT IN (${EVENT_TYPE.customEvent}, ${EVENT_TYPE.performance})`;

  return rawQuery(
    `
    with events as materialized (
      select
        website_event.website_id as "websiteId",
        ${getDateSQL('website_event.created_at', 'hour', timezone)} as h,
        website_event.session_id
      from website_event
      where website_event.website_id in (select value from json_each({{websiteIds}}))
        ${eventTypeQuery}
        and website_event.created_at between {{startDate}} and {{endDate}}
    ),
    bucketed as (
      select
        "websiteId",
        substr(h, 1, 10) || ' ' ||
          printf('%02d', (cast(substr(h, 12, 2) as integer) / ${BUCKET_HOURS}) * ${BUCKET_HOURS}) ||
          ':00:00' as x,
        session_id
      from events
    )
    select "websiteId", x, count(distinct session_id) as y
    from bucketed
    group by "websiteId", x
    union all
    select "websiteId", null as x, count(distinct session_id) as y
    from events
    group by "websiteId"
    order by 1, 2
    `,
    { websiteIds: JSON.stringify(websiteIds), startDate, endDate },
    FUNCTION_NAME,
  );
}

export default sqliteGetWebsiteListCharts;
