import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type {
  FunnelParameters,
  FunnelResult,
  FunnelStep,
  FunnelStepFilter,
} from '@/queries/sql/reports/getFunnel';

export async function sqliteGetFunnel(
  websiteId: string,
  parameters: FunnelParameters,
  filters: QueryFilters,
): Promise<Array<FunnelResult>> {
  const { startDate, endDate, window, steps } = parameters;
  const { rawQuery, getAddIntervalQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
  });
  const { levelOneQuery, levelQuery, sumQuery, params } = getFunnelQuery(steps, window);

  function buildExistsFilters(
    stepIndex: number,
    stepFilters: Array<FunnelStepFilter> | undefined,
    eventAlias: string,
    extraParams: Record<string, string>,
  ): string {
    if (!stepFilters?.length) return '';

    return stepFilters
      .map((f, fi) => {
        const keyParam = `f_${stepIndex}_${fi}_k`;
        const valParam = `f_${stepIndex}_${fi}_v`;
        extraParams[keyParam] = f.property;

        // SQLite LIKE is ASCII case-insensitive by default; use LIKE/NOT LIKE
        // (the PG path used ilike/not ilike).
        let op = '=';
        let val = f.value;
        if (f.operator === 'neq') op = '!=';
        else if (f.operator === 'c') {
          op = 'LIKE';
          val = `%${val}%`;
        } else if (f.operator === 'dnc') {
          op = 'NOT LIKE';
          val = `%${val}%`;
        }
        extraParams[valParam] = val;

        return `and exists (
          select 1 from event_data _ed${stepIndex}_${fi}
          where _ed${stepIndex}_${fi}.website_event_id = ${eventAlias}.event_id
            and _ed${stepIndex}_${fi}.website_id = {{websiteId}}
            and _ed${stepIndex}_${fi}.created_at between {{startDate}} and {{endDate}}
            and _ed${stepIndex}_${fi}.data_key = {{${keyParam}}}
            and case when _ed${stepIndex}_${fi}.data_type = 2 then replace(_ed${stepIndex}_${fi}.string_value, '.0000', '') else _ed${stepIndex}_${fi}.string_value end ${op} {{${valParam}}}
        )`;
      })
      .join('\n');
  }

  function getFunnelQuery(
    steps: Array<FunnelStep>,
    window: number,
  ): {
    levelOneQuery: string;
    levelQuery: string;
    sumQuery: string;
    params: Record<string, string>;
  } {
    const extraParams: Record<string, string> = {};

    const result = steps.reduce(
      (pv, cv, i) => {
        const levelNumber = i + 1;
        const isURL = cv.type === 'path';
        const column = isURL ? 'url_path' : 'event_name';

        let operator = '=';
        let paramValue = cv.value;

        if (cv.value.startsWith('*') || cv.value.endsWith('*')) {
          operator = 'like';
          paramValue = cv.value.replace(/^\*|\*$/g, '%');
        }

        const existsClause =
          !isURL && cv.filters?.length
            ? buildExistsFilters(
                i,
                cv.filters,
                levelNumber === 1 ? 'website_event' : 'we',
                extraParams,
              )
            : '';

        if (levelNumber === 1) {
          pv.levelOneQuery = `
          WITH level1 AS (
            select distinct website_event.session_id, website_event.created_at
            from website_event
            ${cohortQuery}
            ${joinSessionQuery}
            where website_event.website_id = {{websiteId}}
              and website_event.created_at between {{startDate}} and {{endDate}}
              and ${column} ${operator} {{${i}}}
              ${filterQuery}
              ${existsClause}
          )`;
        } else {
          // getAddIntervalQuery emits strftime(ISO, field, '+N minute').
          // CROSS JOIN pins level{i} as the outer loop and INDEXED BY makes
          // each probe a (website_id, session_id, created_at) range seek;
          // left alone SQLite scans website_event's whole history instead.
          pv.levelQuery += `
          , level${levelNumber} AS (
            select distinct we.session_id, we.created_at
            from level${i} l
            cross join website_event we indexed by website_event_website_id_session_id_created_at_idx
            where we.website_id = {{websiteId}}
                and we.session_id = l.session_id
                and we.created_at between l.created_at and ${getAddIntervalQuery(
                  `l.created_at`,
                  `+${window} minute`,
                )}
                and we.${column} ${operator} {{${i}}}
                and we.created_at <= {{endDate}}
                ${existsClause}
          )`;
        }

        // One row, one scalar subquery per level: D1 allows at most 5 terms
        // in a compound SELECT, so the PG `union` breaks at 6+ steps.
        pv.sumQuery += `${i > 0 ? ',' : ''}\n(select count(distinct(session_id)) from level${levelNumber}) as count${levelNumber}`;
        pv.params[i] = paramValue;

        return pv;
      },
      {
        levelOneQuery: '',
        levelQuery: '',
        sumQuery: '',
        params: {} as Record<string, string>,
      },
    );

    return { ...result, params: { ...result.params, ...extraParams } };
  }

  return rawQuery(
    `
    ${levelOneQuery}
    ${levelQuery}
    select ${sumQuery};
    `,
    {
      ...params,
      ...queryParams,
    },
  ).then(formatResults(steps));
}

const formatResults = (steps: Array<FunnelStep>) => (rows: any) => {
  // Reshape the single row into the PG path's per-level rows.
  const results = steps.map((_, i) => ({ count: rows?.[0]?.[`count${i + 1}`] }));

  return steps.map((step: FunnelStep, i: number) => {
    const visitors = Number(results[i]?.count) || 0;
    const previous = Number(results[i - 1]?.count) || 0;
    const dropped = previous > 0 ? previous - visitors : 0;
    const dropoff = 1 - visitors / previous;
    const remaining = visitors / Number(results[0].count);

    return {
      ...step,
      visitors,
      previous,
      dropped,
      dropoff,
      remaining,
    };
  });
};

export default sqliteGetFunnel;
