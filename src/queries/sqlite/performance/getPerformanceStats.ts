import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type { PerformanceStatsResult } from '@/queries/sql/performance/getPerformanceStats';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

const METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];

// SQLite has no percentile_cont; see percentileCont() in _helpers.ts.
export async function sqliteGetPerformanceStats(
  websiteId: string,
  filters: QueryFilters,
): Promise<PerformanceStatsResult> {
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  const result = await rawQuery(
    `
    with base as materialized (
      select ${METRICS.join(', ')}
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.event_type = 5
        and website_event.created_at between {{startDate}} and {{endDate}}
        ${filterQuery}
    )
    select
      ${METRICS.map(m => `(select ${percentileCont(0.75)} from (select ${percentileRanks(m)} from base)) as ${m}`).join(',\n      ')},
      (select count(*) from base) as count
    `,
    queryParams,
  );

  return result?.[0] || { lcp: 0, inp: 0, cls: 0, fcp: 0, ttfb: 0, count: 0 };
}

export default sqliteGetPerformanceStats;
