import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  PerformanceParameters,
  PerformanceResult,
} from '@/queries/sql/performance/getPerformance';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

const METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'] as const;

// SQLite has no percentile_cont; see percentileCont() in _helpers.ts. `base`
// is materialized once and ranked per metric.
export async function sqliteGetPerformanceStats(
  websiteId: string,
  parameters: PerformanceParameters,
  filters: QueryFilters,
): Promise<PerformanceResult['summary']> {
  const { startDate, endDate } = parameters;
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  const summaryResult = await rawQuery(
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
      ${METRICS.map(m => `p_${m}.p50 as ${m}_p50, p_${m}.p75 as ${m}_p75, p_${m}.p95 as ${m}_p95`).join(',\n      ')},
      (select count(*) from base) as count
    from
      ${METRICS.map(
        m => `(select
        ${percentileCont(0.5)} as p50,
        ${percentileCont(0.75)} as p75,
        ${percentileCont(0.95)} as p95
      from (select ${percentileRanks(m)} from base)) p_${m}`,
      ).join(',\n      ')}
    `,
    { ...queryParams, startDate, endDate },
  ).then(result => result?.[0]);

  const summary = Object.fromEntries(
    METRICS.map(m => [
      m,
      {
        p50: Number(summaryResult?.[`${m}_p50`] || 0),
        p75: Number(summaryResult?.[`${m}_p75`] || 0),
        p95: Number(summaryResult?.[`${m}_p95`] || 0),
      },
    ]),
  ) as Omit<PerformanceResult['summary'], 'count'>;

  return { ...summary, count: Number(summaryResult?.count || 0) };
}

export default sqliteGetPerformanceStats;
