import { HEATMAP_EVENT_TYPE, OPERATORS } from '@/lib/constants';
import { filtersObjectToArray } from '@/lib/params';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { getWebsite } from '@/queries/prisma';
import type {
  HeatmapParameters,
  HeatmapPoint,
  HeatmapResult,
  HeatmapScrollBucket,
  HeatmapSnapshot,
} from '@/queries/sql/heatmap/getHeatmap';

// SQLite port of getHeatmap's relationalQuery. SQL changes from PG:
// - `::int` casts dropped (SQLite counts are already integers).
// - mode() within group (order by col): the most frequent value per visit,
//   ties to the smallest (PG's choice), via row_number() over grouped counts.
// - Path filters: = ANY / != ALL -> json_each; ilike -> LIKE (ASCII
//   case-insensitive). Regex operators throw, as in parseFilters on D1.
// The result helpers at the bottom repeat the upstream file's module-private
// ones (snapshot URL, viewport pick); keep them in sync.

const FUNCTION_NAME = 'getHeatmap';

const POINT_LIMIT = 5000;
const PAGE_LIMIT = 100;
const SCROLL_BUCKET_SIZE = 10;

const MODE_COLUMNS = ['page_w', 'page_h', 'viewport_w', 'viewport_h'];

interface HeatmapFilterContext {
  joinQuery: string;
  filterQuery: string;
  queryParams: Record<string, any>;
}

export async function sqliteGetHeatmap(
  websiteId: string,
  parameters: HeatmapParameters,
): Promise<HeatmapResult> {
  const { rawQuery } = prisma;
  const { startDate, endDate, urlPath, mode = 'click' } = parameters;
  const eventType = mode === 'scroll' ? HEATMAP_EVENT_TYPE.scroll : HEATMAP_EVENT_TYPE.click;
  const filterContext = getHeatmapFilterContext(websiteId, parameters);
  const pageFilter =
    mode === 'click'
      ? `
      and x is not null
      and y is not null
      and page_x is not null
      and page_y is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `
      : `
      and scroll_pct is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `;

  const pages = await rawQuery(
    `
    select
      h.url_path as "urlPath",
      count(*) as count,
      count(distinct h.visit_id) as sessions
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {{websiteId}}
      and h.event_type = {{eventType}}
      and h.created_at between {{startDate}} and {{endDate}}
      ${filterContext.filterQuery}
      ${pageFilter}
    group by h.url_path
    order by sessions desc, count desc
    limit ${PAGE_LIMIT}
    `,
    { ...filterContext.queryParams, websiteId, eventType, startDate, endDate },
    FUNCTION_NAME,
  );

  if (!urlPath) {
    return { mode, pages, points: [], snapshot: null, scroll: emptyScroll() };
  }

  if (mode === 'scroll') {
    const modeCtes = MODE_COLUMNS.map(
      col => `
      mode_${col} as (
        select visit_id, ${col}
        from (
          select
            visit_id,
            ${col},
            row_number() over (partition by visit_id order by count(*) desc, ${col}) as rn
          from base
          group by visit_id, ${col}
        )
        where rn = 1
      )`,
    ).join(',');

    const bucketRows: {
      depth: number | string;
      sessions: number | string;
      pageW: number | string;
      pageH: number | string;
      viewportW: number | string;
      viewportH: number | string;
    }[] = await rawQuery(
      `
      with base as materialized (
        select h.visit_id, h.scroll_pct, h.page_w, h.page_h, h.viewport_w, h.viewport_h
        from heatmap_event h
        ${filterContext.joinQuery}
        where h.website_id = {{websiteId}}
          and h.event_type = {{eventType}}
          and h.url_path = {{urlPath}}
          and h.created_at between {{startDate}} and {{endDate}}
          ${filterContext.filterQuery}
          and h.scroll_pct is not null
          and h.page_w is not null
          and h.page_h is not null
          and h.viewport_w is not null
          and h.viewport_h is not null
      ),
      per_session as (
        select visit_id, max(scroll_pct) as max_pct
        from base
        group by visit_id
      ),
      ${modeCtes}
      select
        cast(per_session.max_pct / ${SCROLL_BUCKET_SIZE} as integer) * ${SCROLL_BUCKET_SIZE} as depth,
        count(*) as sessions,
        mode_page_w.page_w as "pageW",
        mode_page_h.page_h as "pageH",
        mode_viewport_w.viewport_w as "viewportW",
        mode_viewport_h.viewport_h as "viewportH"
      from per_session
      ${MODE_COLUMNS.map(col => `join mode_${col} on mode_${col}.visit_id = per_session.visit_id`).join('\n      ')}
      group by depth, "pageW", "pageH", "viewportW", "viewportH"
      order by depth
      `,
      { ...filterContext.queryParams, websiteId, eventType, urlPath, startDate, endDate },
      FUNCTION_NAME,
    );

    const scrollBuckets = bucketRows.map(r => ({
      depth: Number(r.depth),
      sessions: Number(r.sessions),
      pageW: Number(r.pageW),
      pageH: Number(r.pageH),
      viewportW: Number(r.viewportW),
      viewportH: Number(r.viewportH),
    }));
    const viewport = pickScrollSnapshotViewport(scrollBuckets);
    const scroll = {
      buckets: scrollBuckets,
      totalSessions: scrollBuckets.reduce((sum, bucket) => sum + bucket.sessions, 0),
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
    };
    const snapshot = await resolveHeatmapSnapshot({
      websiteId,
      urlPath,
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
    });

    return {
      mode,
      pages,
      points: [],
      snapshot,
      scroll,
    };
  }

  const rawPoints: HeatmapPoint[] = await rawQuery(
    `
    select
      h.x,
      h.y,
      h.page_x as "pageX",
      h.page_y as "pageY",
      h.page_w as "pageW",
      h.page_h as "pageH",
      h.viewport_w as "viewportW",
      h.viewport_h as "viewportH",
      count(*) as count
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {{websiteId}}
      and h.event_type = {{eventType}}
      and h.url_path = {{urlPath}}
      and h.created_at between {{startDate}} and {{endDate}}
      ${filterContext.filterQuery}
      and h.x is not null
      and h.y is not null
      and h.page_x is not null
      and h.page_y is not null
      and h.page_w is not null
      and h.page_h is not null
      and h.viewport_w is not null
      and h.viewport_h is not null
    group by
      h.x,
      h.y,
      h.page_x,
      h.page_y,
      h.page_w,
      h.page_h,
      h.viewport_w,
      h.viewport_h
    order by count desc
    limit ${POINT_LIMIT}
    `,
    { ...filterContext.queryParams, websiteId, eventType, urlPath, startDate, endDate },
    FUNCTION_NAME,
  );

  const viewport = pickSnapshotViewport(rawPoints);
  const snapshot = await resolveHeatmapSnapshot({
    websiteId,
    urlPath,
    viewportW: viewport?.width ?? null,
    viewportH: viewport?.height ?? null,
    pageW: viewport?.pageW ?? null,
    pageH: viewport?.pageH ?? null,
  });

  return { mode, pages, points: rawPoints, snapshot, scroll: emptyScroll() };
}

function getHeatmapPathFilterContext(filters: QueryFilters) {
  const pathFilters = getHeatmapPathFilters(filters);

  if (!pathFilters.length) {
    return { filterQuery: '', queryParams: {} };
  }

  const clauses = pathFilters.map(({ operator, paramName, name }) => {
    const key = paramName ?? name;

    switch (operator) {
      case OPERATORS.equals:
        return `h.url_path IN (select value from json_each({{${key}}}))`;
      case OPERATORS.notEquals:
        return `h.url_path NOT IN (select value from json_each({{${key}}}))`;
      case OPERATORS.contains:
        return `h.url_path LIKE {{${key}}}`;
      case OPERATORS.doesNotContain:
        return `h.url_path NOT LIKE {{${key}}}`;
      case OPERATORS.regex:
      case OPERATORS.notRegex:
        throw new Error(`D1 does not support regex operator: ${operator}`);
      default:
        return '';
    }
  });

  const queryParams = Object.fromEntries(
    pathFilters.map(({ operator, value, paramName, name }) => {
      const key = paramName ?? name;

      if (operator === OPERATORS.contains || operator === OPERATORS.doesNotContain) {
        return [key, `%${value}%`];
      }

      if (operator === OPERATORS.equals || operator === OPERATORS.notEquals) {
        return [key, JSON.stringify(Array.isArray(value) ? value : [value])];
      }

      return [key, Array.isArray(value) ? value[0] : value];
    }),
  );

  const joinedClauses =
    filters.match === 'any'
      ? clauses.filter(Boolean).join('\n        or ')
      : clauses.filter(Boolean).join('\n      and ');

  return {
    filterQuery:
      filters.match === 'any'
        ? `and (\n        ${joinedClauses}\n      )`
        : clauses.length
          ? `and ${joinedClauses}`
          : '',
    queryParams,
  };
}

function getHeatmapFilterContext(websiteId: string, filters: QueryFilters): HeatmapFilterContext {
  const { parseFilters } = prisma;
  const pathFilterContext = getHeatmapPathFilterContext(filters);
  const { filterQuery, cohortQuery, excludeBounceQuery, joinSessionQuery, queryParams } =
    parseFilters({
      ...omitHeatmapPathFilters(filters),
      websiteId,
    });

  if (!(filterQuery || cohortQuery || excludeBounceQuery)) {
    return {
      joinQuery: '',
      filterQuery: pathFilterContext.filterQuery,
      queryParams: pathFilterContext.queryParams,
    };
  }

  return {
    joinQuery: `
    inner join (
      select distinct website_event.website_id, website_event.session_id, website_event.visit_id
      from website_event
      ${joinSessionQuery}
      ${cohortQuery}
      ${excludeBounceQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        ${filterQuery}
    ) filtered_visits
      on filtered_visits.website_id = h.website_id
      and filtered_visits.session_id = h.session_id
      and filtered_visits.visit_id = h.visit_id
    `,
    filterQuery: pathFilterContext.filterQuery,
    queryParams: { ...queryParams, ...pathFilterContext.queryParams },
  };
}

// ---------- same as src/queries/sql/heatmap/getHeatmap.ts ----------

function emptyScroll(): HeatmapResult['scroll'] {
  return {
    buckets: [],
    totalSessions: 0,
    pageW: null,
    pageH: null,
    viewportW: null,
    viewportH: null,
  };
}

async function resolveHeatmapSnapshot({
  websiteId,
  urlPath,
  viewportW,
  viewportH,
  pageW,
  pageH,
}: {
  websiteId: string;
  urlPath: string;
  viewportW: number | null;
  viewportH: number | null;
  pageW: number | null;
  pageH: number | null;
}): Promise<HeatmapSnapshot | null> {
  if (!urlPath || !viewportW || !pageW || !pageH) {
    return null;
  }

  const website = await getWebsite(websiteId);
  const url = buildHeatmapPageUrl(website?.domain, urlPath);

  if (!url) {
    return null;
  }

  const fallbackViewportH = Math.min(Math.max(pageH, 640), 1080);
  const height = viewportH || fallbackViewportH;

  return {
    kind: 'iframe',
    id: `iframe:${websiteId}:${urlPath}:${viewportW}x${height}`,
    url,
    pageW,
    pageH,
    viewportW,
    viewportH: height,
  };
}

function getFirstDomain(domain?: string | null) {
  return domain?.split(',')[0]?.trim() || null;
}

function getWebsiteOrigin(domain?: string | null) {
  const host = getFirstDomain(domain);

  if (!host) {
    return null;
  }

  if (host.startsWith('http://') || host.startsWith('https://')) {
    return new URL(host);
  }

  const protocol =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
      ? 'http'
      : 'https';

  return new URL(`${protocol}://${host}`);
}

function buildHeatmapPageUrl(domain: string | null | undefined, urlPath: string) {
  try {
    const origin = getWebsiteOrigin(domain);

    if (!origin) {
      return null;
    }

    return new URL(urlPath || '/', origin).toString();
  } catch {
    return null;
  }
}

type ViewportPick = { width: number; height: number; pageW: number; pageH: number } | null;

// Upstream's pickSnapshotViewport / pickScrollSnapshotViewport in one: the
// viewport with the most clicks (or sessions), and the largest page size
// seen with it.
function pickViewport<
  T extends { viewportW: number; viewportH: number; pageW: number; pageH: number },
>(rows: T[], weight: (row: T) => number): ViewportPick {
  const viewportBuckets = new Map<
    string,
    { width: number; height: number; weight: number; maxPageW: number; maxPageH: number }
  >();

  for (const row of rows) {
    const viewportKey = `${row.viewportW}x${row.viewportH}`;
    const viewportBucket = viewportBuckets.get(viewportKey);

    if (viewportBucket) {
      viewportBucket.weight += weight(row);
      viewportBucket.maxPageW = Math.max(viewportBucket.maxPageW, row.pageW);
      viewportBucket.maxPageH = Math.max(viewportBucket.maxPageH, row.pageH);
    } else {
      viewportBuckets.set(viewportKey, {
        width: row.viewportW,
        height: row.viewportH,
        weight: weight(row),
        maxPageW: row.pageW,
        maxPageH: row.pageH,
      });
    }
  }

  let bestViewport: {
    width: number;
    height: number;
    weight: number;
    maxPageW: number;
    maxPageH: number;
  } | null = null;

  for (const bucket of viewportBuckets.values()) {
    if (!bestViewport || bucket.weight > bestViewport.weight) {
      bestViewport = bucket;
    }
  }

  if (!bestViewport) {
    return null;
  }

  return {
    width: bestViewport.width,
    height: bestViewport.height,
    pageW: bestViewport.maxPageW,
    pageH: bestViewport.maxPageH,
  };
}

function pickSnapshotViewport(points: HeatmapPoint[]) {
  return pickViewport(points, p => p.count);
}

function pickScrollSnapshotViewport(buckets: HeatmapScrollBucket[]) {
  return pickViewport(buckets, b => b.sessions);
}

function getHeatmapPathFilters(filters: QueryFilters) {
  return filtersObjectToArray(filters).filter(filter => filter.name === 'path');
}

function omitHeatmapPathFilters(filters: QueryFilters): QueryFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key]) => key.replace(/\d+$/, '') !== 'path'),
  ) as QueryFilters;
}

export default sqliteGetHeatmap;
