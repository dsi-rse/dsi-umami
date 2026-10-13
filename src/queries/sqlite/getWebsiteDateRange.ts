import { DEFAULT_RESET_DATE } from '@/lib/constants';
import prisma from '@/lib/prisma';

// min() and max() in one SELECT defeat SQLite's min/max optimization and scan
// every row in range; as separate subqueries each is a single index seek.
export async function sqliteGetWebsiteDateRange(websiteId: string) {
  const { rawQuery, parseFilters } = prisma;
  const { queryParams } = parseFilters({
    startDate: new Date(DEFAULT_RESET_DATE),
    websiteId,
  });

  const result = await rawQuery(
    `
    select
      (select min(created_at)
        from website_event
        where website_id = {{websiteId}}
          and created_at >= {{startDate}}) as "startDate",
      (select max(created_at)
        from website_event
        where website_id = {{websiteId}}
          and created_at >= {{startDate}}) as "endDate"
    `,
    queryParams,
  );

  return result[0] ?? null;
}

export default sqliteGetWebsiteDateRange;
