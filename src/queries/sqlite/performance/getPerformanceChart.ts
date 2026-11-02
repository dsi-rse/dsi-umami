import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  PerformanceParameters,
  PerformanceResult,
} from '@/queries/sql/performance/getPerformance';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

// SQLite has no percentile_cont; see percentileCont() in _helpers.ts.
export async function sqliteGetPerformanceChart(
  websiteId: string,
  parameters: PerformanceParameters,
  filters: QueryFilters,
): Promise<Pick<PerformanceResult, 'chart'>> {
  const { startDate, endDate, unit = 'day', timezone = 'utc', metric = 'lcp' } = parameters;
  const { getDateSQL, rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  const chart = await rawQuery(
    `
    with base as (
      select
        ${getDateSQL('website_event.created_at', unit, timezone)} t,
        ${metric} v
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.event_type = 5
        and website_event.created_at between {{startDate}} and {{endDate}}
        ${filterQuery}
    ),
    ranked as (
      select t, ${percentileRanks('v', 't')}
      from base
    )
    select
      t,
      ${percentileCont(0.5)} as p50,
      ${percentileCont(0.75)} as p75,
      ${percentileCont(0.95)} as p95
    from ranked
    group by t
    order by t
    `,
    { ...queryParams, startDate, endDate },
  );

  return { chart };
}

export default sqliteGetPerformanceChart;
