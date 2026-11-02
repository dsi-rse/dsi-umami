import { FILTER_COLUMNS, SESSION_COLUMNS } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

const SESSION_DB_COLUMNS = new Set(
  SESSION_COLUMNS.map(col => FILTER_COLUMNS[col as keyof typeof FILTER_COLUMNS]).filter(Boolean),
);

const FUNCTION_NAME = 'getValues';

export async function sqliteGetValues(websiteId: string, column: string, filters: QueryFilters) {
  const { rawQuery, getSearchSQL } = prisma;
  const params: Record<string, any> = {};
  const { startDate, endDate, search } = filters;

  let searchQuery = '';
  let excludeDomain = '';

  if (column === 'referrer_domain') {
    // PG: regexp_replace(website_event.hostname, '^www.', '').
    excludeDomain = `and website_event.referrer_domain != (case
        when substr(website_event.hostname, 1, 3) = 'www' and length(website_event.hostname) > 3
        then substr(website_event.hostname, 5)
        else website_event.hostname end)
      and website_event.referrer_domain != ''`;
  }

  if (search) {
    if (decodeURIComponent(search).includes(',')) {
      searchQuery = `AND (${decodeURIComponent(search)
        .split(',')
        .slice(0, 5)
        .map((value: string, index: number) => {
          const key = `search${index}`;

          params[key] = value;

          return getSearchSQL(column, key).replace('and ', '');
        })
        .join(' OR ')})`;
    } else {
      searchQuery = getSearchSQL(column);
    }
  }

  if (SESSION_DB_COLUMNS.has(column)) {
    return rawQuery(
      `
      select ${column} as "value", count(*) as "count"
      from session
      where website_id = {{websiteId}}
        and created_at between {{startDate}} and {{endDate}}
        ${searchQuery}
      group by 1
      order by 2 desc
      limit 10
      `,
      { websiteId, startDate, endDate, search: `%${search}%`, ...params },
      FUNCTION_NAME,
    );
  }

  return rawQuery(
    `
    select ${column} as "value", count(*) as "count"
    from website_event
    where website_event.website_id = {{websiteId}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      ${searchQuery}
      ${excludeDomain}
    group by 1
    order by 2 desc
    limit 10
    `,
    { websiteId, startDate, endDate, search: `%${search}%`, ...params },
    FUNCTION_NAME,
  );
}

export default sqliteGetValues;
