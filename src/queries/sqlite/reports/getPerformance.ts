import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  PerformanceParameters,
  PerformanceResult,
} from '@/queries/sql/reports/getPerformance';
import { percentileCont, percentileRanks } from '@/queries/sqlite/_helpers';

const METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];

// SQLite has no percentile_cont; see percentileCont() in _helpers.ts.
export async function sqliteGetPerformance(
  websiteId: string,
  parameters: PerformanceParameters,
  filters: QueryFilters,
): Promise<PerformanceResult> {
  const { startDate, endDate, unit = 'day', timezone = 'utc', metric = 'lcp' } = parameters;
  const { getDateSQL, rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
  });

  const fromQuery = `
    from website_event
    ${cohortQuery}
    ${joinSessionQuery}
    where website_event.website_id = {{websiteId}}
      and website_event.event_type = 5
      and website_event.created_at between {{startDate}} and {{endDate}}
      ${filterQuery}`;

  const chart = await rawQuery(
    `
    with base as (
      select
        ${getDateSQL('website_event.created_at', unit, timezone)} t,
        ${metric} v
      ${fromQuery}
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

  const summaryResult = await rawQuery(
    `
    with base as materialized (
      select ${METRICS.join(', ')}
      ${fromQuery}
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

  const summary = {
    lcp: {
      p50: Number(summaryResult?.lcp_p50 || 0),
      p75: Number(summaryResult?.lcp_p75 || 0),
      p95: Number(summaryResult?.lcp_p95 || 0),
    },
    inp: {
      p50: Number(summaryResult?.inp_p50 || 0),
      p75: Number(summaryResult?.inp_p75 || 0),
      p95: Number(summaryResult?.inp_p95 || 0),
    },
    cls: {
      p50: Number(summaryResult?.cls_p50 || 0),
      p75: Number(summaryResult?.cls_p75 || 0),
      p95: Number(summaryResult?.cls_p95 || 0),
    },
    fcp: {
      p50: Number(summaryResult?.fcp_p50 || 0),
      p75: Number(summaryResult?.fcp_p75 || 0),
      p95: Number(summaryResult?.fcp_p95 || 0),
    },
    ttfb: {
      p50: Number(summaryResult?.ttfb_p50 || 0),
      p75: Number(summaryResult?.ttfb_p75 || 0),
      p95: Number(summaryResult?.ttfb_p95 || 0),
    },
    count: Number(summaryResult?.count || 0),
  };

  return { chart, summary };
}

export default sqliteGetPerformance;
