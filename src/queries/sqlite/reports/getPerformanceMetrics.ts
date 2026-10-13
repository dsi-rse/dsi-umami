import { SESSION_COLUMNS } from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type { PerformanceParameters } from '@/queries/sql/reports/getPerformance';
import type { PerformanceMetricsData } from '@/queries/sql/reports/getPerformanceMetrics';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

// SQLite has no percentile_cont; see percentileCont() in _helpers.ts.
export async function sqliteGetPerformanceMetrics(
  websiteId: string,
  parameters: PerformanceParameters,
  filters: QueryFilters,
  column: string,
  limit?: number,
): Promise<PerformanceMetricsData[]> {
  const { startDate, endDate, metric = 'lcp' } = parameters;
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters(
    { ...filters, websiteId },
    { joinSession: SESSION_COLUMNS.includes(column) },
  );

  // `nulls first` keeps PG's ordering for groups with no metric values.
  return rawQuery(
    `
    with base as (
      select
        ${column} as name,
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
      select name, ${percentileRanks('v', 'name')}
      from base
    )
    select
      name as "name",
      ${percentileCont(0.5)} as p50,
      ${percentileCont(0.75)} as p75,
      ${percentileCont(0.95)} as p95,
      count(*) as count
    from ranked
    group by name
    order by p75 desc nulls first
    ${limit ? `limit ${limit}` : ''}
    `,
    { ...queryParams, startDate, endDate },
  );
}

export default sqliteGetPerformanceMetrics;
