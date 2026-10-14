import { EVENT_TYPE } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getSessionActivity';

// PG: session_id = any({{sessionIds}}::uuid[]) -> json_each over one JSON
// parameter. SQLite's EXISTS yields 0/1; mapped back to PG's boolean.
export async function sqliteGetSessionActivity(
  websiteId: string,
  sessionIds: string[],
  filters: QueryFilters,
) {
  const { rawQuery } = prisma;
  const { startDate, endDate } = filters;

  const rows = await rawQuery(
    `
    select
      created_at as "createdAt",
      url_path as "urlPath",
      url_query as "urlQuery",
      referrer_domain as "referrerDomain",
      event_id as "eventId",
      event_type as "eventType",
      event_name as "eventName",
      visit_id as "visitId",
      hostname,
      EXISTS (select 1
              from event_data d
              where d.website_event_id = e.event_id
                and d.website_id = {{websiteId}}
                and d.created_at between {{startDate}} and {{endDate}}) AS "hasData"
    from website_event e
    where website_id = {{websiteId}}
      and session_id in (select value from json_each({{sessionIds}}))
      and event_type != ${EVENT_TYPE.performance}
      and created_at between {{startDate}} and {{endDate}}
    order by created_at desc
    limit 500
    `,
    { websiteId, sessionIds: JSON.stringify(sessionIds ?? []), startDate, endDate },
    FUNCTION_NAME,
  );

  return rows.map((row: any) => ({ ...row, hasData: Boolean(row.hasData) }));
}

export default sqliteGetSessionActivity;
