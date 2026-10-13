/**
 * D1 smoke test: runs every src/queries/sql/** entry point on the D1 path
 * (DATABASE_FLAVOR=d1) against node:sqlite loaded with prisma/migrations-d1,
 * behind a minimal fake of the D1 binding that enforces D1's statement
 * limits. Catches PG-only SQL that slips past scripts/check-d1-coverage.js
 * and D1 limit violations; a few targeted checks pin results.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';

process.env.DATABASE_FLAVOR = 'd1';

// path.resolve, not new URL(): jsdom replaces the global URL.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL_DIR = path.join(ROOT, 'src/queries/sql');

// ---------- fake D1 binding over node:sqlite ----------

const sqlite = new DatabaseSync(':memory:');
// Limits workerd's D1 enforces (probed with Miniflare). `limits` is newer
// than the installed @types/node.
Object.assign((sqlite as unknown as { limits: Record<string, number> }).limits, {
  variableNumber: 100,
  compoundSelect: 5,
  likePatternLength: 50,
  exprDepth: 100,
  functionArg: 127,
  column: 100,
  sqlLength: 100_000,
});

const D1_MAX_PARAMS = 100;

function statement(sql: string, params: any[] = []) {
  const rows = (arrays = false) => {
    const stmt = sqlite.prepare(sql);
    stmt.setReturnArrays(arrays);
    return stmt.all(...params) as any[];
  };
  return {
    bind(...args: any[]) {
      if (args.length > D1_MAX_PARAMS) {
        throw new Error(`D1: ${args.length} bound parameters, max ${D1_MAX_PARAMS}`);
      }
      if (args.includes(undefined)) throw new Error('D1_TYPE_ERROR: undefined is not bindable');
      return statement(
        sql,
        args.map(v => (typeof v === 'boolean' ? Number(v) : v)),
      );
    },
    // Like D1, writes report meta.changes (batch() runs everything through all()).
    all: async () => {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { success: true, results: rows(), meta: {} };
      const { changes } = stmt.run(...params);
      return { success: true, results: [], meta: { changes: Number(changes) } };
    },
    raw: async () => rows(true),
    first: async (column?: string) => (column ? rows()[0]?.[column] : rows()[0]) ?? null,
    run: async () => ({ success: true, results: [], meta: sqlite.prepare(sql).run(...params) }),
  };
}

const fakeD1 = {
  prepare: (sql: string) => statement(sql),
  async batch(statements: ReturnType<typeof statement>[]) {
    sqlite.exec('begin');
    try {
      const results = [];
      for (const s of statements) results.push(await s.all());
      sqlite.exec('commit');
      return results;
    } catch (e) {
      sqlite.exec('rollback');
      throw e;
    }
  },
};

// What @opennextjs/cloudflare's getCloudflareContext() reads.
(globalThis as any)[Symbol.for('__cloudflare-context__')] = {
  env: { DB: fakeD1 },
  ctx: {},
  cf: {},
};

// ---------- schema + seed ----------

const migrationsDir = path.join(ROOT, 'prisma/migrations-d1');
const migrations = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
for (const file of migrations.sort()) {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
}

const W = 'w1';

sqlite.exec(`
  insert into website (website_id, name, domain) values ('${W}', 'Site', 'a.com');
  insert into session (session_id, website_id, browser, os, device, screen, language, country, region, city, created_at) values
    ('s1', '${W}', 'chrome', 'Mac OS', 'desktop', '1920x1080', 'en-US', 'US', 'US-IL', 'Chicago', '2026-01-15T03:30:00.000Z'),
    ('s2', '${W}', 'firefox', 'Windows 10', 'desktop', '1440x900', 'fr-FR', 'FR', 'FR-IDF', 'Paris', '2026-01-16T12:00:00.000Z'),
    ('s3', '${W}', 'safari', 'iOS', 'mobile', '390x844', 'en-GB', 'GB', 'GB-ENG', 'London', '2026-01-20T08:00:00.000Z');
  insert into website_event (event_id, website_id, session_id, visit_id, created_at, url_path, url_query, referrer_domain, page_title, hostname, utm_source, utm_medium, event_type, event_name, tag, lcp, inp, cls, fcp, ttfb) values
    ('e1', '${W}', 's1', 'v1', '2026-01-15T03:30:00.000Z', '/x', 'a=1', 'google.com', 'X', 'a.com', 'google', 'cpc', 1, null, 't1', null, null, null, null, null),
    ('e2', '${W}', 's1', 'v1', '2026-01-15T03:35:00.000Z', '/pricing', null, null, 'Pricing', 'a.com', null, null, 1, null, null, null, null, null, null, null),
    ('e3', '${W}', 's2', 'v2', '2026-01-16T12:00:00.600Z', '/x', null, 'b.com', 'X', 'www.a.com', null, null, 1, null, null, null, null, null, null, null),
    ('e4', '${W}', 's2', 'v2', '2026-01-16T12:01:00.500Z', '/x', null, null, 'X', 'a.com', null, null, 2, 'signup', null, null, null, null, null, null),
    ('e5', '${W}', 's3', 'v3', '2026-01-20T08:00:00.000Z', '/y', null, 'facebook.com', 'Y', 'a.com', null, null, 1, null, null, null, null, null, null, null),
    ('p1', '${W}', 's1', 'v1', '2026-01-15T03:31:00.000Z', '/x', null, null, 'X', 'a.com', null, null, 5, null, null, 1000, 80, 0.01, 800, 100),
    ('p2', '${W}', 's2', 'v2', '2026-01-16T12:00:30.000Z', '/x', null, null, 'X', 'a.com', null, null, 5, null, null, 2000, null, 0.05, 900, 200),
    ('p3', '${W}', 's3', 'v3', '2026-01-20T08:00:30.000Z', '/y', null, null, 'Y', 'a.com', null, null, 5, null, null, 4000, 300, 0.2, 1500, 400),
    ('p4', '${W}', 's3', 'v3', '2026-01-20T08:01:00.000Z', '/y', null, null, 'Y', 'a.com', null, null, 5, null, null, 3000, 120, 0.1, 1200, 300);
  insert into event_data (event_data_id, website_id, website_event_id, data_key, string_value, number_value, date_value, data_type, created_at) values
    ('ed1', '${W}', 'e4', 'plan', 'pro', null, null, 1, '2026-01-16T12:01:00.500Z'),
    ('ed2', '${W}', 'e4', 'revenue', '10', 10, null, 2, '2026-01-16T12:01:00.500Z'),
    ('ed3', '${W}', 'e4', 'currency', 'USD', null, null, 1, '2026-01-16T12:01:00.500Z'),
    ('ed4', '${W}', 'e4', 'renews', null, null, '2026-02-16T00:00:00.000Z', 4, '2026-01-16T12:01:00.500Z');
  insert into session_data (session_data_id, website_id, session_id, data_key, string_value, number_value, date_value, data_type, created_at) values
    ('sd1', '${W}', 's1', 'tier', 'gold', null, null, 1, '2026-01-15T03:30:00.000Z'),
    ('sd2', '${W}', 's1', 'joined', null, null, '2025-12-01T00:00:00.000Z', 4, '2026-01-15T03:30:00.000Z');
  insert into revenue (revenue_id, website_id, session_id, event_id, event_name, currency, revenue, created_at) values
    ('r1', '${W}', 's2', 'e4', 'signup', 'USD', 10, '2026-01-16T12:01:00.500Z');
`);
sqlite
  .prepare(
    `insert into session_replay (replay_id, website_id, session_id, visit_id, chunk_index, events, event_count, started_at, ended_at, created_at)
    values ('rp1', ?, 's1', 'v1', 0, ?, 1, '2026-01-15T03:30:00.100Z', '2026-01-15T03:30:04.000Z', '2026-01-15T03:30:04.000Z')`,
  )
  .run(W, gzipSync(JSON.stringify([{ type: 2 }])));

// ---------- calls ----------

const startDate = new Date('2026-01-01T00:00:00.000Z');
const endDate = new Date('2026-02-01T00:00:00.000Z');
const range = { startDate, endDate };
const F: any = { ...range, unit: 'day', timezone: 'America/Chicago' };
const FU: any = { ...range, unit: 'hour', timezone: 'utc' };
const filtered: any = { ...F, path: 'eq./x', browser: 'neq.safari', referrer: 'c.google' };
const anyMatch: any = { ...F, os: 'eq.Mac OS', country: 'eq.US,FR', match: 'any' };
const cohort: any = {
  ...F,
  cohort_startDate: startDate,
  cohort_endDate: endDate,
  cohort_path: 'eq./x',
  cohort_actionName: 'path',
};
const R = { ...range, unit: 'day', timezone: 'America/Chicago' };
const funnel = (steps: any[], window = 60) => ({ ...range, window, steps });

// [function name, ...args]. Every exported query must appear here or in SKIP.
const CALLS: [string, ...any[]][] = [
  ['getActiveVisitors', W],
  ['getWebsiteDateRange', W],
  ['getRealtimeActivity', W, FU],
  ['getRealtimeData', W, { ...range, unit: 'minute', timezone: 'utc' }],
  ['getRealtimeData', W, { ...range, unit: 'minute', timezone: 'Asia/Kolkata' }],
  ['getValues', W, 'url_path', F],
  ['getValues', W, 'referrer_domain', { ...F, search: 'goo' }],
  ['getWebsiteStats', W, F],
  ['getWebsiteStats', W, filtered],
  ['getWebsiteStats', W, cohort],
  ['getWebsiteStats', W, { ...F, excludeBounce: true }],
  ['getWeeklyTraffic', W, F],
  ['getWeeklyTraffic', W, { ...anyMatch, timezone: 'utc' }],
  ['getChannelMetrics', W, F],
  ['getChannelMetrics', W, filtered],
  ['getChannelExpandedMetrics', W, F],
  ['getChannelExpandedMetrics', W, anyMatch],
  ['getPageviewStats', W, F],
  ['getPageviewStats', W, { ...filtered, unit: 'month' }],
  ['getPageviewMetrics', W, { type: 'path' }, F],
  ['getPageviewMetrics', W, { type: 'entry' }, filtered],
  ['getPageviewMetrics', W, { type: 'exit' }, { ...F, excludeBounce: true }],
  ['getPageviewMetrics', W, { type: 'referrer' }, cohort],
  ['getPageviewExpandedMetrics', W, { type: 'path' }, F],
  ['getPageviewExpandedMetrics', W, { type: 'domain' }, anyMatch],
  ['getPageviewExpandedMetrics', W, { type: 'entry' }, filtered],
  ['getSessionStats', W, F],
  ['getSessionStats', W, { ...anyMatch, unit: 'year' }],
  ['getSessionMetrics', W, { type: 'browser' }, F],
  ['getSessionMetrics', W, { type: 'language' }, filtered],
  ['getSessionMetrics', W, { type: 'city' }, anyMatch],
  ['getSessionExpandedMetrics', W, { type: 'language' }, F],
  ['getSessionExpandedMetrics', W, { type: 'region' }, filtered],
  ['getSessionActivity', W, 's1', F],
  ['getSessionData', W, 's1'],
  ['getSessionDataProperties', W, F],
  ['getSessionDataValues', W, { ...F, propertyName: 'joined' }],
  ['getWebsiteSession', W, 's1'],
  ['getWebsiteSessionStats', W, F],
  ['getWebsiteSessions', W, { ...F, search: 'chr' }],
  ['getWebsiteSessions', W, { ...filtered, page: 2, pageSize: 1 }],
  ['getEventData', W, F],
  ['getEventDataById', W, 'e4'],
  ['getEventDataEvents', W, F],
  ['getEventDataEvents', W, { ...F, event: 'eq.signup' }],
  ['getEventDataFields', W, F],
  ['getEventDataProperties', W, F],
  ['getEventDataStats', W, F],
  ['getEventDataValues', W, { ...F, event: 'eq.signup', propertyName: 'renews' }],
  ['getEventMetrics', W, { type: 'event' }, F],
  ['getEventMetrics', W, { type: 'event' }, { ...F, event: 'dnc.x' }],
  ['getEventExpandedMetrics', W, { type: 'event' }, F],
  ['getEventStats', W, {}, F],
  ['getEventStats', W, { limit: 5 }, { ...anyMatch, unit: 'hour' }],
  ['getWebsiteEventStats', W, F],
  ['getWebsiteEvents', W, { ...F, search: 'sign' }],
  ['getWebsiteEvents', W, { ...filtered, page: 1, pageSize: 10 }],
  ['getPerformanceStats', W, F],
  ['getPerformanceStats', W, filtered],
  ['getPerformance', W, { ...R, metric: 'lcp' }, F],
  ['getPerformance', W, { ...R, unit: 'hour', timezone: 'utc', metric: 'inp' }, filtered],
  ['getPerformanceMetrics', W, { ...R, metric: 'lcp' }, F, 'url_path'],
  ['getPerformanceMetrics', W, { ...R, metric: 'cls' }, anyMatch, 'browser', 10],
  ['getReplayChunks', W, 'v1'],
  ['getSessionReplays', W, F],
  // Event-column filters only: the PG query has no session join for these either.
  ['getSessionReplays', W, { ...F, path: 'eq./x', referrer: 'c.google', search: 'chr' }, 's1'],
  ['getAttribution', W, { ...range, model: 'first-click', type: 'path', step: '/x' }, F],
  ['getAttribution', W, { ...range, model: 'last-click', type: 'event', step: 'signup' }, filtered],
  ['getBreakdown', W, { ...range, fields: ['os', 'path', 'country'] }, F],
  ['getBreakdown', W, { ...range, fields: ['browser'] }, anyMatch],
  [
    'getFunnel',
    W,
    funnel([
      { type: 'path', value: '/x' },
      { type: 'path', value: '/p*' },
    ]),
    F,
  ],
  [
    'getFunnel',
    W,
    funnel([
      { type: 'path', value: '/x' },
      {
        type: 'event',
        value: 'signup',
        filters: [{ property: 'plan', operator: 'c', value: 'pr' }],
      },
    ]),
    filtered,
  ],
  ['getGoal', W, { ...range, type: 'path', value: '/x' }, F],
  ['getGoal', W, { ...range, type: 'event', value: 'signup' }, anyMatch],
  ['getJourney', W, { ...range, steps: 3 }, F],
  ['getJourney', W, { ...range, steps: 4, startStep: '/x', endStep: '/pricing' }, filtered],
  ['getRetention', W, { ...range, timezone: 'America/Chicago' }, F],
  ['getRetention', W, { ...range, timezone: 'utc' }, anyMatch],
  ['getRevenue', W, { ...R, currency: 'USD' }, F],
  ['getRevenue', W, { ...R, unit: 'month', currency: 'USD' }, { ...F, country: 'eq.FR' }],
  ['getRevenueMetrics', W, { ...R, currency: 'USD' }, F],
  ['getRevenueSessions', W, 'USD', F],
  ['getRevenueStats', W, { ...R, currency: 'USD' }, F],
  ['getUTM', W, { ...range, column: 'utm_source' }, F],
  ['getUTM', W, { ...range, column: 'utm_medium' }, filtered],
  // Writes, to a second website so the reads above stay deterministic.
  [
    'createSession',
    { id: 'ws1', websiteId: 'w2', browser: 'chrome', language: 'en', createdAt: new Date() },
  ],
  [
    'saveEvent',
    {
      websiteId: 'w2',
      sessionId: 'ws1',
      visitId: 'wv1',
      eventType: 2,
      urlPath: '/buy',
      eventName: 'purchase',
      eventData: { revenue: 5, currency: 'USD', sku: 'a', when: '2026-01-01T00:00:00.000Z' },
      createdAt: new Date(),
    },
  ],
  [
    'saveEventData',
    { websiteId: 'w2', eventId: 'we1', eventData: { n: 1 }, createdAt: new Date() },
  ],
  [
    'saveRevenue',
    {
      websiteId: 'w2',
      sessionId: 'ws1',
      eventId: 'we1',
      eventName: 'purchase',
      currency: 'EUR',
      revenue: 3,
      createdAt: new Date(),
    },
  ],
  ['saveSessionData', { websiteId: 'w2', sessionId: 'ws1', sessionData: { plan: 'free' } }],
  ['saveSessionData', { websiteId: 'w2', sessionId: 'ws1', sessionData: { plan: 'pro' } }],
  [
    'saveRecording',
    {
      websiteId: 'w2',
      sessionId: 'ws1',
      visitId: 'wv1',
      chunkIndex: 0,
      events: [{ type: 2 }],
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
    },
  ],
];

const SKIP: Record<string, string> = {
  getEventDataUsage: 'not implemented for relational DBs upstream',
  getEventUsage: 'not implemented for relational DBs upstream',
  relationalQuery: "saveSessionData's PG branch, exercised through saveSessionData",
  toClickHouseGroupedReferrer: 'SQL string builder',
  toPostgresGroupedReferrer: 'SQL string builder',
};

const queries: Record<string, (...args: any[]) => Promise<any>> = {};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && entry !== 'index.ts') yield full;
  }
}

beforeAll(async () => {
  for (const file of walk(SQL_DIR)) {
    for (const [name, value] of Object.entries(await import(file))) {
      if (typeof value === 'function') queries[name] = value as any;
    }
  }
}, 30_000);

describe('D1 smoke', () => {
  test('every exported query is exercised', () => {
    const called = new Set(CALLS.map(([name]) => name));
    const missing = Object.keys(queries).filter(name => !called.has(name) && !SKIP[name]);
    expect(missing).toEqual([]);
  });

  test.each(CALLS.map((call, i) => [`${call[0]} #${i}`, call] as const))('%s runs', async (_label, [
    name,
    ...args
  ]) => {
    // Any SQL error rejects and fails the test with SQLite's message.
    await queries[name](...args);
  });
});

describe('D1 results', () => {
  const stats = (unit: string, timezone: string) =>
    queries.getPageviewStats(W, { ...range, unit, timezone, path: 'eq./x' });

  test('getDateSQL buckets in the requested timezone, PG output format', async () => {
    // e1 is 2026-01-15T03:30:00Z = 2026-01-14 21:30 in Chicago (UTC-6).
    expect((await stats('day', 'America/Chicago'))[0].x).toBe('2026-01-14 00:00:00');
    expect((await stats('hour', 'America/Chicago'))[0].x).toBe('2026-01-14 21:00:00');
    expect((await stats('minute', 'America/Chicago'))[0].x).toBe('2026-01-14 21:30:00');
    expect((await stats('month', 'America/Chicago'))[0].x).toBe('2026-01-01 00:00:00');
    expect((await stats('day', 'utc'))[0].x).toBe('2026-01-15T00:00:00Z');
    expect((await stats('hour', 'utc'))[0].x).toBe('2026-01-15T03:00:00Z');
    expect((await stats('day', 'Asia/Kolkata'))[0].x).toBe('2026-01-15 00:00:00');
  });

  test('getDateSQL follows DST transitions', async () => {
    const { getDateSQL } = (await import('@/lib/prisma')).default;
    const local = (iso: string) =>
      sqlite.prepare(`select ${getDateSQL('?1', 'minute', 'America/Chicago')} v`).get(iso) as {
        v: string;
      };
    expect(local('2026-03-08T07:59:00.000Z').v).toBe('2026-03-08 01:59:00'); // CST
    expect(local('2026-03-08T08:00:00.000Z').v).toBe('2026-03-08 03:00:00'); // CDT
    expect(local('2026-07-01T12:00:00.000Z').v).toBe('2026-07-01 07:00:00');
    expect(local('2026-11-01T06:59:00.000Z').v).toBe('2026-11-01 01:59:00'); // CDT
    expect(local('2026-11-01T07:00:00.000Z').v).toBe('2026-11-01 01:00:00'); // CST
  });

  test('getWeeklyTraffic uses local day of week and hour', async () => {
    const days = await queries.getWeeklyTraffic(W, { ...range, timezone: 'America/Chicago' });
    // e1/e2 at Wed 2026-01-14 21:30 local; e3/e4 at Fri 06:00; e5 at Tue 02:00.
    expect(days[3][21]).toBe(1);
    expect(days[5][6]).toBe(1);
    expect(days[2][2]).toBe(1);
  });

  test('funnel counts a step 5 minutes later', async () => {
    const steps = [
      { type: 'path', value: '/x' },
      { type: 'path', value: '/pricing' },
    ];
    const [one, two] = await queries.getFunnel(W, funnel(steps, 10), {});
    expect(one.visitors).toBe(2);
    expect(two.visitors).toBe(1);
    expect(two.dropped).toBe(1);
  });

  test('8-step funnel with step filters stays within D1 limits', async () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      type: 'event',
      value: `step${i}`,
      filters: [
        { property: 'a', operator: 'eq', value: 'x' },
        { property: 'b', operator: 'c', value: 'y' },
      ],
    }));
    const result = await queries.getFunnel(W, funnel(steps), filtered);
    expect(result.map((s: any) => s.visitors)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('performance percentiles match PG percentile_cont', async () => {
    const { summary, chart } = await queries.getPerformance(
      W,
      { ...range, unit: 'month', timezone: 'utc', metric: 'lcp' },
      {},
    );
    // lcp 1000, 2000, 3000, 4000: p50 = 2500, p75 = 3250, p95 = 3850.
    expect(summary.lcp.p50).toBe(2500);
    expect(summary.lcp.p75).toBe(3250);
    expect(summary.lcp.p95).toBeCloseTo(3850, 6);
    // inp skips the null: 80, 120, 300 -> p50 = 120, p75 = 210.
    expect(summary.inp.p50).toBe(120);
    expect(summary.inp.p75).toBe(210);
    expect(summary.count).toBe(4);
    expect(chart).toHaveLength(1);
    expect(chart[0]).toMatchObject({ t: '2026-01-01T00:00:00Z', p50: 2500, p75: 3250 });
    expect(chart[0].p95).toBeCloseTo(3850, 6);
  });

  test('session time and replay duration keep sub-second precision', async () => {
    // Visit v2 runs 12:00:00.600 -> 12:01:00.500: floor(59.9s) = 59, not 60.
    expect((await queries.getWebsiteSession(W, 's2')).totaltime).toBe(59);
    // Replay chunk 03:30:00.100 -> 03:30:04.000.
    const { data } = await queries.getSessionReplays(W, F);
    expect(data[0].duration).toBe(3900);
  });

  test('language metric uses a two-letter prefix', async () => {
    const rows = await queries.getSessionMetrics(W, { type: 'language' }, F);
    expect(rows).toEqual(
      expect.arrayContaining([
        { x: 'en', y: 2 },
        { x: 'fr', y: 1 },
      ]),
    );
  });

  test('date range and active visitors', async () => {
    expect(await queries.getWebsiteDateRange(W)).toEqual({
      startDate: '2026-01-15T03:30:00.000Z',
      endDate: '2026-01-20T08:01:00.000Z',
    });
    expect(await queries.getActiveVisitors(W)).toEqual({ visitors: 0 });
  });

  test('rawQuery binds each named parameter once', async () => {
    const { rawQuery } = (await import('@/lib/prisma')).default;
    // 150 occurrences of one name: past D1's 100-parameter cap unless deduped.
    const args = Array.from({ length: 150 }, () => '{{a}}').join(', ');
    const sql = `select {{b}} as b, {{a}} in (${args}) as hit`;
    expect(await rawQuery(sql, { a: 1, b: 'x' })).toEqual([{ b: 'x', hit: 1 }]);
  });
});
