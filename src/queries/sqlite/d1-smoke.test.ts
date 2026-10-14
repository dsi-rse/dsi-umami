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

// @seed:property-data
// Own website so the W results stay put. 'purchase' events carry amount
// (number), tags (array; pde4's is null, as saveEventData stores an overlong
// array), plan (string), shipped (date), gift (boolean); sessions carry
// interests (array), age (number), tier (string), joined (date).
const PD = 'wpd';
sqlite.exec(`
  insert into website (website_id, name, domain) values ('${PD}', 'Props', 'p.com');
  insert into session (session_id, website_id, browser, country, created_at) values
    ('pds1', '${PD}', 'chrome', 'US', '2026-01-10T14:59:00.000Z'),
    ('pds2', '${PD}', 'firefox', 'FR', '2026-01-11T15:00:00.000Z'),
    ('pds3', '${PD}', 'safari', 'GB', '2026-01-12T15:00:00.000Z');
  insert into website_event (event_id, website_id, session_id, visit_id, created_at, url_path, hostname, event_type, event_name) values
    ('pde5', '${PD}', 'pds1', 'pdv1', '2026-01-10T14:59:00.000Z', '/', 'p.com', 1, null),
    ('pde1', '${PD}', 'pds1', 'pdv1', '2026-01-10T15:00:00.000Z', '/buy', 'p.com', 2, 'purchase'),
    ('pde2', '${PD}', 'pds2', 'pdv2', '2026-01-11T15:00:00.000Z', '/buy', 'p.com', 2, 'purchase'),
    ('pde3', '${PD}', 'pds3', 'pdv3', '2026-01-12T15:00:00.000Z', '/buy', 'p.com', 2, 'purchase'),
    ('pde4', '${PD}', 'pds3', 'pdv3', '2026-01-12T15:05:00.000Z', '/buy', 'p.com', 2, 'purchase');
  insert into event_data (event_data_id, website_id, website_event_id, data_key, string_value, number_value, date_value, data_type, created_at) values
    ('ped1', '${PD}', 'pde1', 'amount', '10.0000', 10, null, 2, '2026-01-10T15:00:00.000Z'),
    ('ped2', '${PD}', 'pde1', 'tags', '["a","b"]', null, null, 5, '2026-01-10T15:00:00.000Z'),
    ('ped3', '${PD}', 'pde1', 'plan', 'pro', null, null, 1, '2026-01-10T15:00:00.000Z'),
    ('ped4', '${PD}', 'pde1', 'shipped', '2026-01-10T15:00:00.000Z', null, '2026-01-10T15:00:00.000Z', 4, '2026-01-10T15:00:00.000Z'),
    ('ped5', '${PD}', 'pde1', 'gift', 'true', null, null, 3, '2026-01-10T15:00:00.000Z'),
    ('ped6', '${PD}', 'pde2', 'amount', '20.0000', 20, null, 2, '2026-01-11T15:00:00.000Z'),
    ('ped7', '${PD}', 'pde2', 'tags', '["a",1.50]', null, null, 5, '2026-01-11T15:00:00.000Z'),
    ('ped8', '${PD}', 'pde2', 'plan', 'free', null, null, 1, '2026-01-11T15:00:00.000Z'),
    ('ped9', '${PD}', 'pde3', 'amount', '40.0000', 40, null, 2, '2026-01-12T15:00:00.000Z'),
    ('ped10', '${PD}', 'pde3', 'tags', '["c","a"]', null, null, 5, '2026-01-12T15:00:00.000Z'),
    ('ped11', '${PD}', 'pde3', 'plan', 'pro', null, null, 1, '2026-01-12T15:00:00.000Z'),
    ('ped12', '${PD}', 'pde3', 'shipped', '2026-01-12T15:00:00.000Z', null, '2026-01-12T15:00:00.000Z', 4, '2026-01-12T15:00:00.000Z'),
    ('ped13', '${PD}', 'pde4', 'amount', '45.5000', 45.5, null, 2, '2026-01-12T15:05:00.000Z'),
    ('ped14', '${PD}', 'pde4', 'tags', null, null, null, 5, '2026-01-12T15:05:00.000Z'),
    ('ped15', '${PD}', 'pde4', 'plan', 'pro', null, null, 1, '2026-01-12T15:05:00.000Z');
  insert into session_data (session_data_id, website_id, session_id, data_key, string_value, number_value, date_value, data_type, distinct_id, created_at) values
    ('psd1', '${PD}', 'pds1', 'interests', '["music","sports"]', null, null, 5, 'u1', '2026-01-10T14:59:00.000Z'),
    ('psd2', '${PD}', 'pds1', 'age', '30.0000', 30, null, 2, 'u1', '2026-01-10T14:59:00.000Z'),
    ('psd3', '${PD}', 'pds1', 'tier', 'gold', null, null, 1, 'u1', '2026-01-10T14:59:00.000Z'),
    ('psd4', '${PD}', 'pds1', 'joined', '2025-12-01T00:00:00.000Z', null, '2025-12-01T00:00:00.000Z', 4, 'u1', '2026-01-10T14:59:00.000Z'),
    ('psd5', '${PD}', 'pds2', 'interests', '["music"]', null, null, 5, null, '2026-01-11T15:00:00.000Z'),
    ('psd6', '${PD}', 'pds2', 'age', '40.0000', 40, null, 2, null, '2026-01-11T15:00:00.000Z'),
    ('psd7', '${PD}', 'pds2', 'tier', 'silver', null, null, 1, null, '2026-01-11T15:00:00.000Z'),
    ('psd8', '${PD}', 'pds3', 'age', '25.0000', 25, null, 2, null, '2026-01-12T15:00:00.000Z'),
    ('psd9', '${PD}', 'pds3', 'tier', 'gold', null, null, 1, null, '2026-01-12T15:00:00.000Z');
`);

describe('D1 property data', () => {
  const PF: any = {
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-02-01T00:00:00.000Z'),
    unit: 'day',
    timezone: 'America/Chicago',
  };
  const pf = (propertyName: string, dataType: number, operator: string, value: string) => ({
    propertyName,
    dataType,
    operator,
    value,
  });

  test('numeric stats match PG (median is percentile_cont)', async () => {
    expect(await queries.getEventDataNumericStats(PD, 'purchase', 'amount', PF)).toEqual({
      total: 115.5,
      average: 28.875,
      median: 30,
      max: 45.5,
      min: 10,
    });
    // Array property filter: tags contains 'a' keeps pde1-3.
    expect(
      await queries.getEventDataNumericStats(PD, 'purchase', 'amount', PF, [
        pf('tags', 5, 'c', 'a'),
      ]),
    ).toMatchObject({ total: 70, median: 20, max: 40 });
    const session = await queries.getSessionDataNumericStats(PD, 'age', PF);
    expect(session).toMatchObject({ total: 95, median: 30, max: 40, min: 25 });
    expect(session.average).toBeCloseTo(95 / 3, 10);
    expect(await queries.getSessionDataNumericStats(PD, 'nope', PF)).toEqual({
      total: 0,
      average: 0,
      median: 0,
      max: 0,
      min: 0,
    });
  });

  test('array values are counted per element, as jsonb_array_elements_text', async () => {
    const values = await queries.getEventDataValues(PD, 'purchase', {
      ...PF,
      propertyName: 'tags',
      dataType: 5,
    });
    expect(values[0]).toEqual({ value: 'a', total: 3 });
    expect(values).toEqual(
      expect.arrayContaining([
        { value: 'b', total: 1 },
        { value: 'c', total: 1 },
        { value: '1.50', total: 1 },
      ]),
    );
    expect(values).toHaveLength(4);
    const series = await queries.getSessionDataArraySeries(PD, 'interests', PF);
    expect(series).toEqual([
      { x: 'music', t: '2026-01-10T00:00:00Z', y: 1 },
      { x: 'sports', t: '2026-01-10T00:00:00Z', y: 1 },
      { x: 'music', t: '2026-01-11T00:00:00Z', y: 1 },
    ]);
  });

  test('pivots return string arrays sorted by key', async () => {
    const events = await queries.getEventDataPivot(PD, 'purchase', { ...PF, pageSize: 10 });
    expect(events.count).toBe(4);
    expect(events.data.map((r: any) => r.eventId)).toEqual(['pde4', 'pde3', 'pde2', 'pde1']);
    expect(events.data[3]).toMatchObject({
      sessionId: 'pds1',
      eventName: 'purchase',
      urlPath: '/buy',
      createdAt: '2026-01-10T15:00:00.000Z',
      propertyKeys: ['amount', 'gift', 'plan', 'shipped', 'tags'],
      // shipped in Chicago wall time, like PG's getDateStringSQL.
      propertyValues: ['10.0000', 'true', 'pro', '2026-01-10T09:00:00Z', '["a","b"]'],
    });
    expect(events.data[0].propertyValues).toEqual(['45.5000', 'pro', '']);

    const sessions = await queries.getSessionDataPivot(PD, 'tier', PF);
    expect(sessions.data.map((r: any) => r.sessionId)).toEqual(['pds3', 'pds2', 'pds1']);
    expect(sessions.data[2]).toMatchObject({
      distinctId: 'u1',
      propertyKeys: ['age', 'interests', 'joined', 'tier'],
      propertyValues: ['30.0000', '["music","sports"]', '2025-11-30T18:00:00Z', 'gold'],
    });
    // Like PG, 'does not contain' needs the property: pds3 has no interests.
    const noSports = await queries.getSessionDataPivot(PD, 'tier', PF, [
      pf('interests', 5, 'dnc', 'sports'),
    ]);
    expect(noSports.data).toEqual([
      {
        sessionId: 'pds2',
        distinctId: '',
        createdAt: '2026-01-11T15:00:00.000Z',
        propertyKeys: ['age', 'interests', 'tier'],
        propertyValues: ['40.0000', '["music"]', 'silver'],
      },
    ]);
  });

  test('event and session property filters in QueryFilters', async () => {
    const fields = await queries.getEventDataFields(PD, 'purchase', {
      ...PF,
      eventPropertyFilters: [pf('plan', 1, 'eq', 'free')],
    });
    expect(fields.map((f: any) => [f.propertyName, f.total])).toEqual([
      ['amount', 1],
      ['plan', 1],
      ['tags', 1],
    ]);
    const props = await queries.getSessionDataProperties(PD, {
      ...PF,
      sessionPropertyFilters: [pf('tier', 1, 'eq', 'gold'), pf('age', 2, 'lt', '30')],
    });
    // Only pds3 is gold and under 30.
    expect(props.map((p: any) => [p.propertyName, p.total])).toEqual([
      ['age', 1],
      ['tier', 1],
    ]);
  });

  test('session activity leaderboard', async () => {
    expect(await queries.getSessionDataActivityStats(PD, 'tier', PF)).toEqual([
      { label: 'gold', activity: 4, sessions: 2, visits: 2, views: 1, events: 3 },
      { label: 'silver', activity: 1, sessions: 1, visits: 1, views: 0, events: 1 },
    ]);
  });
});
// @seed:misc
const HW = '00000000-0000-4000-8000-0000000000a1';
// Heatmap: v1 clicks /x twice at one spot and scrolls to 75% (page_h 3200
// twice, 3000 once); v2 clicks once (plus a row missing page_x) and scrolls
// to 100% (page_h 2400 and 2500 once each: PG's mode() takes the smaller).
sqlite.exec(`
  insert into heatmap_event (heatmap_event_id, website_id, session_id, visit_id, url_path, event_type, x, y, page_x, page_y, page_w, viewport_w, viewport_h, page_h, scroll_pct, created_at) values
    ('h1', '${W}', 's1', 'v1', '/x', 1, 10, 20, 10, 520, 1280, 1280, 800, 3000, null, '2026-01-15T03:30:10.000Z'),
    ('h2', '${W}', 's1', 'v1', '/x', 1, 10, 20, 10, 520, 1280, 1280, 800, 3000, null, '2026-01-15T03:30:11.000Z'),
    ('h3', '${W}', 's2', 'v2', '/x', 1, 100, 200, 100, 200, 1440, 1440, 900, 2500, null, '2026-01-16T12:00:10.000Z'),
    ('h4', '${W}', 's2', 'v2', '/x', 1, 100, 200, null, 200, 1440, 1440, 900, 2500, null, '2026-01-16T12:00:11.000Z'),
    ('h5', '${W}', 's3', 'v3', '/y', 1, 5, 5, 5, 5, 390, 390, 844, 2000, null, '2026-01-20T08:00:10.000Z'),
    ('h6', '${W}', 's1', 'v1', '/x', 2, null, null, null, null, 1280, 1280, 800, 3000, 30, '2026-01-15T03:30:12.000Z'),
    ('h7', '${W}', 's1', 'v1', '/x', 2, null, null, null, null, 1280, 1280, 800, 3200, 75, '2026-01-15T03:30:13.000Z'),
    ('h8', '${W}', 's1', 'v1', '/x', 2, null, null, null, null, 1280, 1280, 800, 3200, 55, '2026-01-15T03:30:14.000Z'),
    ('h9', '${W}', 's2', 'v2', '/x', 2, null, null, null, null, 1440, 1440, 900, 2500, 100, '2026-01-16T12:00:12.000Z'),
    ('h10', '${W}', 's2', 'v2', '/x', 2, null, null, null, null, 1440, 1440, 900, 2400, 40, '2026-01-16T12:00:13.000Z');
  insert into session_link (website_id, session_id, distinct_id, created_at) values
    ('${W}', 's1', 'd1', '2026-01-15T03:30:00.000Z'),
    ('${W}', 's2', 'd1', '2026-01-16T12:00:00.000Z'),
    ('${W}', 's2', 'd2', '2026-01-16T12:05:00.000Z');
  insert into session (session_id, website_id, created_at) values ('ws2', 'w2', '2026-01-15T00:00:00.000Z');
  -- getWebsite (heatmap snapshot URL) only looks up UUID ids.
  insert into website (website_id, name, domain) values ('${HW}', 'Heatmap', 'b.com, c.com');
  insert into heatmap_event (heatmap_event_id, website_id, session_id, visit_id, url_path, event_type, x, y, page_x, page_y, page_w, viewport_w, viewport_h, page_h, scroll_pct, created_at) values
    ('hw1', '${HW}', 'hs1', 'hv1', '/x', 1, 1, 1, 1, 1, 1440, 1440, 900, 2500, null, '2026-01-15T00:00:00.000Z'),
    ('hw2', '${HW}', 'hs2', 'hv2', '/x', 1, 2, 2, 2, 2, 1280, 1280, 800, 3000, null, '2026-01-15T00:00:00.000Z'),
    ('hw3', '${HW}', 'hs3', 'hv3', '/x', 1, 3, 3, 3, 3, 1300, 1280, 800, 2800, null, '2026-01-15T00:00:00.000Z');
`);

describe('D1 misc results', () => {
  const day = (iso: string) => new Date(iso);

  test('getWebsiteListCharts buckets 12 local hours', async () => {
    // Chicago midnight to midnight, as the route sends. e1/e2 (s1) at 01-14
    // 21:30 local, e3 (s2) at 01-16 06:00, e5 (s3) at 01-20 02:00.
    const charts = await queries.getWebsiteListCharts([W, 'w2'], {
      startDate: day('2026-01-01T06:00:00.000Z'),
      endDate: day('2026-01-31T06:00:00.000Z'),
      timezone: 'America/Chicago',
    });
    expect(charts[W].total).toBe(3);
    expect(charts[W].values).toHaveLength(61);
    expect(charts[W].values.flatMap((v: number, i: number) => (v ? [[i, v]] : []))).toEqual([
      [27, 1],
      [30, 1],
      [38, 1],
    ]);
    expect(charts.w2).toEqual({ values: Array(61).fill(0), total: 0 });

    const utc = await queries.getWebsiteListCharts([W], { ...range, timezone: 'UTC' });
    expect(utc[W].values.flatMap((v: number, i: number) => (v ? [i] : []))).toEqual([28, 31, 38]);
  });

  test('getHeatmap pages, points and scroll depth', async () => {
    const F0 = { ...range, timezone: 'America/Chicago' };
    const pages = await queries.getHeatmap(W, { ...F0, mode: 'click' });
    expect(pages.pages).toEqual([
      { urlPath: '/x', count: 3, sessions: 2 },
      { urlPath: '/y', count: 1, sessions: 1 },
    ]);

    const click = await queries.getHeatmap(W, { ...F0, urlPath: '/x', mode: 'click' });
    expect(click.points).toEqual([
      {
        x: 10,
        y: 20,
        pageX: 10,
        pageY: 520,
        pageW: 1280,
        pageH: 3000,
        viewportW: 1280,
        viewportH: 800,
        count: 2,
      },
      {
        x: 100,
        y: 200,
        pageX: 100,
        pageY: 200,
        pageW: 1440,
        pageH: 2500,
        viewportW: 1440,
        viewportH: 900,
        count: 1,
      },
    ]);
    // getWebsite skips non-UUID ids such as W, so no snapshot here.
    expect(click.snapshot).toBeNull();
    // Snapshot: the viewport with the most clicks, its largest page size, and
    // the website's first domain.
    const hw = await queries.getHeatmap(HW, { ...F0, urlPath: '/x', mode: 'click' });
    expect(hw.snapshot).toEqual({
      kind: 'iframe',
      id: `iframe:${HW}:/x:1280x800`,
      url: 'https://b.com/x',
      pageW: 1300,
      pageH: 3000,
      viewportW: 1280,
      viewportH: 800,
    });

    const scroll = await queries.getHeatmap(W, { ...F0, urlPath: '/x', mode: 'scroll' });
    expect(scroll.scroll).toEqual({
      buckets: [
        { depth: 70, sessions: 1, pageW: 1280, pageH: 3200, viewportW: 1280, viewportH: 800 },
        { depth: 100, sessions: 1, pageW: 1440, pageH: 2400, viewportW: 1440, viewportH: 900 },
      ],
      totalSessions: 2,
      pageW: 1280,
      pageH: 3200,
      viewportW: 1280,
      viewportH: 800,
    });

    // Event filters narrow to visits with a matching event (only v1 has the
    // google referrer); the path filter applies to the heatmap row's path.
    const filteredScroll = await queries.getHeatmap(W, {
      ...F0,
      referrer: 'c.google',
      path: 'eq./x',
      urlPath: '/x',
      mode: 'scroll',
    });
    expect(filteredScroll.scroll.buckets.map((b: any) => b.depth)).toEqual([70]);
    const notX = await queries.getHeatmap(W, { ...F0, path: 'neq./x', mode: 'click' });
    expect(notX.pages.map((p: any) => p.urlPath)).toEqual(['/y']);
  });

  test('session links and activity', async () => {
    expect(await queries.getLinkedDistinctIds(W, 's2')).toEqual(
      expect.arrayContaining(['d1', 'd2']),
    );
    expect(await queries.getLinkedSessionIds(W, 'd1')).toEqual(
      expect.arrayContaining([
        { sessionId: 's1', createdAt: '2026-01-15T03:30:00.000Z' },
        { sessionId: 's2', createdAt: '2026-01-16T12:00:00.000Z' },
      ]),
    );
    const activity = await queries.getSessionActivity(W, ['s1', 's2'], range);
    expect(activity.map((a: any) => a.eventId)).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(activity.map((a: any) => a.hasData)).toEqual([true, false, false, false]);
  });

  test('revenue chart, stats and metrics', async () => {
    const P = { ...range, unit: 'day', timezone: 'utc', currency: 'USD' };
    // r1: 10 USD for s2's signup at 2026-01-16.
    expect((await queries.getRevenueChart(W, P, {})).chart).toEqual([
      { x: 'signup', t: '2026-01-16T00:00:00Z', y: 10, count: 1 },
    ]);
    const stats = await queries.getRevenueStats(W, P, {});
    expect(stats).toMatchObject({ sum: 10, count: 1, unique_count: 1, average: 10 });
    // ARPU over the 3 sessions with a non-performance event in range.
    expect(stats.arpu).toBeCloseTo(10 / 3, 6);
    expect(await queries.getRevenueMetrics(W, P, {}, 'country')).toEqual([
      { name: 'FR', value: 10 },
    ]);
    expect(await queries.getRevenueMetrics(W, P, {}, 'region')).toEqual([
      { country: 'FR', name: 'FR-IDF', value: 10 },
    ]);
    // s2's first event (e3) came from b.com, a referral.
    expect(await queries.getRevenueMetrics(W, P, {}, 'referrer')).toEqual([
      { name: 'b.com', value: 10 },
    ]);
    expect(await queries.getRevenueMetrics(W, P, {}, 'channel')).toEqual([
      { name: 'referral', value: 10 },
    ]);
    // Session filters keep only revenue from matching sessions.
    expect(await queries.getRevenueMetrics(W, P, { country: 'eq.US' }, 'country')).toEqual([]);
  });

  test('session writes: data upsert, links, identify, heatmap rows (w2)', async () => {
    const t1 = new Date('2026-01-16T00:00:00.000Z');
    await queries.createSession({ id: 'ws3', websiteId: 'w2', createdAt: t1 });
    await queries.saveSessionData({
      websiteId: 'w2',
      sessionId: 'ws3',
      sessionData: { plan: 'free' },
    });
    await queries.saveSessionData({
      websiteId: 'w2',
      sessionId: 'ws3',
      sessionData: { plan: 'pro', n: 2 },
      createdAt: t1,
    });
    // No createdAt: the upsert keeps the stored one.
    await queries.saveSessionData({ websiteId: 'w2', sessionId: 'ws3', sessionData: { n: 3 } });
    const data = sqlite
      .prepare(
        `select data_key k, string_value s, number_value n, created_at c from session_data
        where session_id = 'ws3' order by data_key`,
      )
      .all();
    expect(data).toEqual([
      { k: 'n', s: '3.0000', n: 3, c: t1.toISOString() },
      { k: 'plan', s: 'pro', n: null, c: t1.toISOString() },
    ]);

    const link = { websiteId: 'w2', sessionId: 'ws3', distinctId: 'u1', createdAt: t1 };
    await queries.saveSessionLink(link);
    await queries.saveSessionLink({ ...link, createdAt: new Date() });
    expect(await queries.getLinkedSessionIds('w2', 'u1')).toEqual([
      { sessionId: 'ws3', createdAt: t1.toISOString() },
    ]);
    await queries.updateSession({ websiteId: 'w2', sessionId: 'ws3', distinctId: 'u1' });
    // Only fills an empty distinct_id.
    await queries.updateSession({ websiteId: 'w2', sessionId: 'ws3', distinctId: 'u2' });
    expect(
      sqlite.prepare(`select distinct_id d from session where session_id = 'ws3'`).get(),
    ).toEqual({ d: 'u1' });

    await queries.saveHeatmapEvents(
      Array.from({ length: 7 }, (_, i) => ({
        websiteId: 'w2',
        sessionId: 'ws3',
        visitId: 'wv3',
        urlPath: '/buy',
        eventType: 2,
        x: null,
        y: null,
        pageX: 10.6 * i,
        pageY: null,
        pageW: 1280,
        viewportW: 1280,
        viewportH: 800,
        pageH: 3000,
        scrollPct: 20 * i,
        createdAt: t1,
      })),
    );
    expect(
      sqlite
        .prepare(
          `select page_x x, scroll_pct p, created_at c from heatmap_event
          where session_id = 'ws3' order by scroll_pct, page_x`,
        )
        .all(),
    ).toEqual(
      [0, 11, 21, 32, 42, 53, 64].map((x, i) => ({
        x,
        p: Math.min(100, 20 * i),
        c: t1.toISOString(),
      })),
    );
  });
});

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
  ['getSessionActivity', W, ['s1', 's2'], F],
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
  ['getEventDataValues', W, 'signup', { ...F, propertyName: 'renews' }],
  ['getEventMetrics', W, { type: 'event' }, F],
  ['getEventMetrics', W, { type: 'event' }, { ...F, event: 'dnc.x' }],
  ['getEventExpandedMetrics', W, { type: 'event' }, F],
  ['getEventStats', W, {}, F],
  ['getEventStats', W, { limit: 5 }, { ...anyMatch, unit: 'hour' }],
  ['getWebsiteEventStats', W, F],
  ['getWebsiteEvents', W, { ...F, search: 'sign' }],
  ['getWebsiteEvents', W, { ...filtered, page: 1, pageSize: 10, maxResults: 100 }],
  ['getPerformanceStats', W, { ...R, metric: 'lcp' }, F],
  ['getPerformanceStats', W, { ...R, unit: 'hour', timezone: 'utc', metric: 'inp' }, filtered],
  ['getPerformance', W, { ...R, metric: 'lcp' }, F],
  ['getPerformance', W, { ...R, unit: 'hour', timezone: 'utc', metric: 'inp' }, filtered],
  ['getPerformanceMetrics', W, { ...R, metric: 'lcp' }, F, 'url_path'],
  ['getPerformanceMetrics', W, { ...R, metric: 'cls' }, anyMatch, 'browser', 10],
  ['getReplayChunks', W, 'v1'],
  ['getSessionReplays', W, { ...F, minDuration: 1 }],
  [
    'getSessionReplays',
    W,
    { ...F, path: 'eq./x', referrer: 'c.google', browser: 'eq.chrome', search: 'chr' },
    's1',
  ],
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
  ['getRevenueChart', W, { ...R, currency: 'USD' }, F],
  ['getRevenueChart', W, { ...R, unit: 'month', currency: 'USD' }, { ...F, country: 'eq.FR' }],
  ['getRevenueMetrics', W, { ...R, currency: 'USD' }, F, 'country'],
  ['getRevenueMetrics', W, { ...R, currency: 'USD' }, filtered, 'region'],
  ['getRevenueMetrics', W, { ...R, currency: 'USD' }, F, 'referrer'],
  ['getRevenueMetrics', W, { ...R, currency: 'USD' }, cohort, 'channel'],
  ['getRevenueSessions', W, 'USD', F],
  ['getRevenueStats', W, { ...R, currency: 'USD' }, F],
  ['getRevenueStats', W, { ...R, currency: 'USD' }, anyMatch],
  ['getUTM', W, { ...range, column: 'utm_source' }, F],
  ['getUTM', W, { ...range, column: 'utm_medium' }, filtered],
  // @calls:property-data (event_data / session_data series, stats, pivots)
  // Route shapes: (websiteId, [eventName,] propertyName, [metric,] filters, propertyFilters).
  ['getEventDataArraySeries', PD, 'purchase', 'tags', F],
  [
    'getEventDataArraySeries',
    PD,
    'purchase',
    'tags',
    { ...FU, country: 'eq.US,FR' },
    [{ propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro,free' }],
  ],
  ['getEventDataDateSeries', PD, 'purchase', 'shipped', F],
  [
    'getEventDataDateSeries',
    PD,
    'purchase',
    'shipped',
    { ...FU, path: 'eq./buy' },
    [{ propertyName: 'shipped', dataType: 4, operator: 'af', value: '2026-01-11' }],
  ],
  ['getEventDataNumericSeries', PD, 'purchase', 'amount', 'sum', F],
  [
    'getEventDataNumericSeries',
    PD,
    'purchase',
    'amount',
    'avg',
    { ...FU, browser: 'neq.safari' },
    [{ propertyName: 'tags', dataType: 5, operator: 'c', value: 'a' }],
  ],
  ['getEventDataNumericSeries', PD, 'purchase', 'amount', 'count', cohort],
  ['getEventDataNumericStats', PD, 'purchase', 'amount', F],
  [
    'getEventDataNumericStats',
    PD,
    'purchase',
    'amount',
    {
      ...anyMatch,
      eventPropertyFilters: [{ propertyName: 'gift', dataType: 3, operator: 'eq', value: 'true' }],
    },
    [{ propertyName: 'amount', dataType: 2, operator: 'gte', value: '15' }],
  ],
  ['getEventDataPivot', PD, 'purchase', { ...F, page: 1, pageSize: 2 }],
  [
    'getEventDataPivot',
    PD,
    'purchase',
    { ...filtered, page: 2, pageSize: 1, maxResults: 3 },
    [{ propertyName: 'plan', dataType: 1, operator: 'dnc', value: 'fr' }],
  ],
  ['getEventDataPropertySeries', PD, 'purchase', 'plan', F],
  [
    'getEventDataPropertySeries',
    PD,
    'purchase',
    'gift',
    FU,
    [{ propertyName: 'amount', dataType: 2, operator: 'lt', value: '30' }],
  ],
  ['getEventDataValues', PD, 'purchase', { ...F, propertyName: 'tags', dataType: 5 }],
  ['getEventDataValues', PD, undefined, { ...anyMatch, propertyName: 'shipped', dataType: 4 }],
  ['getEventDataValues', PD, 'purchase', { ...F, propertyName: 'amount' }],
  [
    'getEventDataFields',
    PD,
    'purchase',
    {
      ...F,
      eventPropertyFilters: [{ propertyName: 'tags', dataType: 5, operator: 'dnc', value: 'b' }],
    },
  ],
  [
    'getEventData',
    PD,
    {
      ...F,
      eventPropertyFilters: [{ propertyName: 'plan', dataType: 1, operator: 'neq', value: 'free' }],
    },
  ],
  ['getSessionDataActivityStats', PD, 'tier', F],
  [
    'getSessionDataActivityStats',
    PD,
    'tier',
    {
      ...filtered,
      sessionPropertyFilters: [{ propertyName: 'age', dataType: 2, operator: 'gt', value: '20' }],
    },
    [{ propertyName: 'interests', dataType: 5, operator: 'c', value: 'music' }],
  ],
  ['getSessionDataArraySeries', PD, 'interests', F],
  [
    'getSessionDataArraySeries',
    PD,
    'interests',
    { ...FU, browser: 'eq.chrome,firefox' },
    [{ propertyName: 'tier', dataType: 1, operator: 'c', value: 'gol' }],
  ],
  ['getSessionDataDateSeries', PD, 'joined', F],
  [
    'getSessionDataDateSeries',
    PD,
    'joined',
    cohort,
    [{ propertyName: 'joined', dataType: 4, operator: 'bf', value: '2026-01-01' }],
  ],
  ['getSessionDataNumericSeries', PD, 'age', 'sum', F],
  ['getSessionDataNumericSeries', PD, 'age', 'avg', { ...FU, unit: 'month' }],
  [
    'getSessionDataNumericSeries',
    PD,
    'age',
    'count',
    anyMatch,
    [{ propertyName: 'tier', dataType: 1, operator: 'eq', value: 'gold' }],
  ],
  ['getSessionDataNumericStats', PD, 'age', F],
  [
    'getSessionDataNumericStats',
    PD,
    'age',
    {
      ...filtered,
      sessionPropertyFilters: [
        { propertyName: 'tier', dataType: 1, operator: 'neq', value: 'silver' },
      ],
    },
    [{ propertyName: 'age', dataType: 2, operator: 'lte', value: '40' }],
  ],
  ['getSessionDataPivot', PD, 'tier', { ...F, page: 1, pageSize: 10 }],
  [
    'getSessionDataPivot',
    PD,
    'tier',
    { ...anyMatch, page: 2, pageSize: 1, maxResults: 2 },
    [{ propertyName: 'interests', dataType: 5, operator: 'dnc', value: 'sports' }],
  ],
  ['getSessionDataPropertySeries', PD, 'tier', F],
  [
    'getSessionDataPropertySeries',
    PD,
    'tier',
    { ...FU, country: 'neq.GB' },
    [{ propertyName: 'age', dataType: 2, operator: 'eq', value: '30' }],
  ],
  ['getSessionDataProperties', PD, F, [], 'tier'],
  [
    'getSessionDataProperties',
    PD,
    {
      ...F,
      sessionPropertyFilters: [
        { propertyName: 'joined', dataType: 4, operator: 'eq', value: '2025-11-30' },
      ],
    },
    [{ propertyName: 'interests', dataType: 5, operator: 'c', value: 'music' }],
  ],
  ['getSessionDataValues', PD, { ...F, propertyName: 'interests', dataType: 5 }],
  ['getSessionDataValues', PD, { ...filtered, propertyName: 'age', dataType: 2 }],
  ['getSessionData', PD, 'pds1'],
  // @calls:misc (heatmap, revenue, performance chart, website list charts, session activity/links)
  ['getWebsiteListCharts', [W, 'w2'], { ...range, timezone: 'America/Chicago' }],
  ['getWebsiteListCharts', [W], { ...range, timezone: 'UTC', eventType: 2 }],
  ['getPerformanceChart', W, { ...R, metric: 'lcp' }, F],
  ['getPerformanceChart', W, { ...R, unit: 'hour', timezone: 'utc', metric: 'inp' }, filtered],
  ['getHeatmap', W, { ...F, mode: 'click' }],
  ['getHeatmap', W, { ...filtered, mode: 'scroll' }],
  ['getHeatmap', W, { ...F, urlPath: '/x', mode: 'click' }],
  ['getHeatmap', W, { ...anyMatch, path: 'c./x', urlPath: '/x', mode: 'click' }],
  ['getHeatmap', W, { ...F, urlPath: '/x', mode: 'scroll' }],
  ['getHeatmap', W, { ...filtered, urlPath: '/x', mode: 'scroll' }],
  ['getLinkedDistinctIds', W, 's1'],
  ['getLinkedSessionIds', W, 'd1'],
  [
    'extractHeatmapEvents',
    [
      { type: 4, data: { href: 'https://a.com/x?q=1', width: 1280, height: 800 }, timestamp: 1 },
      { type: 3, data: { source: 2, type: 2, x: 10.4, y: 20.6 }, timestamp: 2 },
      { type: 3, data: { source: 4, width: 1024, height: 768 } },
      { type: 5, data: { tag: 'url-change', payload: { url: 'https://a.com/y' } } },
      { type: 5, data: { tag: 'scroll-progress', payload: { scrollPct: 55.5, pageH: 3000 } } },
    ],
  ],
  [
    'saveHeatmapEvents',
    // 7 rows x 16 columns: past D1's 100-parameter cap in one statement.
    Array.from({ length: 7 }, (_, i) => ({
      websiteId: 'w2',
      sessionId: 'ws1',
      visitId: 'wv1',
      urlPath: '/buy',
      eventType: i < 5 ? 1 : 2,
      x: i < 5 ? 10.6 * i : null,
      y: i < 5 ? 20 : null,
      pageX: i < 5 ? 10 : null,
      pageY: i < 5 ? 520 : null,
      pageW: 1280,
      viewportW: 1280,
      viewportH: 800,
      pageH: 3000,
      scrollPct: i < 5 ? null : 120,
      createdAt: new Date(),
    })),
  ],
  [
    'saveSessionLink',
    { websiteId: 'w2', sessionId: 'ws2', distinctId: 'wd1', createdAt: new Date() },
  ],
  [
    'saveSessionLink',
    { websiteId: 'w2', sessionId: 'ws2', distinctId: 'wd1', createdAt: new Date() },
  ],
  ['updateSession', { websiteId: 'w2', sessionId: 'ws2', distinctId: 'wd1' }],
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
  relationalQuery: "saveSessionData's PG branch; D1 runs its sibling",
  toClickHouseGroupedReferrer: 'SQL string builder',
  toPostgresGroupedReferrer: 'SQL string builder',
};

const queries: Record<string, (...args: any[]) => Promise<any>> = {};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && entry !== 'index.ts')
      yield full;
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

  test.each(CALLS.map((call, i) => [`${call[0]} #${i}`, call] as const))(
    '%s runs',
    async (_label, [name, ...args]) => {
      // Any SQL error rejects and fails the test with SQLite's message.
      await queries[name](...args);
    },
  );
});

describe('D1 results', () => {
  const stats = (unit: string, timezone: string) =>
    queries.getPageviewStats(W, { ...range, unit, timezone, path: 'eq./x' });

  test('getDateSQL buckets in the requested timezone, PG output format', async () => {
    // e1 is 2026-01-15T03:30:00Z = 2026-01-14 21:30 in Chicago (UTC-6).
    expect((await stats('day', 'America/Chicago'))[0].x).toBe('2026-01-14T00:00:00Z');
    expect((await stats('hour', 'America/Chicago'))[0].x).toBe('2026-01-14T21:00:00Z');
    expect((await stats('minute', 'America/Chicago'))[0].x).toBe('2026-01-14T21:30:00Z');
    expect((await stats('month', 'America/Chicago'))[0].x).toBe('2026-01-01T00:00:00Z');
    expect((await stats('day', 'utc'))[0].x).toBe('2026-01-15T00:00:00Z');
    expect((await stats('hour', 'utc'))[0].x).toBe('2026-01-15T03:00:00Z');
    expect((await stats('day', 'Asia/Kolkata'))[0].x).toBe('2026-01-15T00:00:00Z');
  });

  test('getDateSQL follows DST transitions', async () => {
    const { getDateSQL } = (await import('@/lib/prisma')).default;
    const local = (iso: string) =>
      sqlite.prepare(`select ${getDateSQL('?1', 'minute', 'America/Chicago')} v`).get(iso) as {
        v: string;
      };
    expect(local('2026-03-08T07:59:00.000Z').v).toBe('2026-03-08T01:59:00Z'); // CST
    expect(local('2026-03-08T08:00:00.000Z').v).toBe('2026-03-08T03:00:00Z'); // CDT
    expect(local('2026-07-01T12:00:00.000Z').v).toBe('2026-07-01T07:00:00Z');
    expect(local('2026-11-01T06:59:00.000Z').v).toBe('2026-11-01T01:59:00Z'); // CDT
    expect(local('2026-11-01T07:00:00.000Z').v).toBe('2026-11-01T01:00:00Z'); // CST
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

describe('D1 compat layer', () => {
  const prisma = async () => (await import('@/lib/prisma')).default;
  const count = (table: string, where: string) =>
    (sqlite.prepare(`select count(*) n from ${table} where ${where}`).get() as { n: number }).n;

  test('upsert inserts, then updates with increment', async () => {
    const { client } = await prisma();
    const args = {
      where: { userId: 'u-up' },
      update: { attempts: { increment: 1 } },
      create: { userId: 'u-up', attempts: 1 },
    };
    expect((await client.twoFactorRateLimit.upsert(args)).attempts).toBe(1);
    expect((await client.twoFactorRateLimit.upsert(args)).attempts).toBe(2);
  });

  test('upsert on a compound key, and with an empty update', async () => {
    const { client } = await prisma();
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    const otp = { where: { userId_otp: { userId: 'u-up', otp: '123456' } } };
    await client.twoFactorOtpUsed.upsert({
      ...otp,
      update: { expiresAt },
      create: { userId: 'u-up', otp: '123456', expiresAt },
    });
    await client.twoFactorOtpUsed.upsert({
      ...otp,
      update: { expiresAt },
      create: { userId: 'u-up', otp: '123456', expiresAt },
    });
    expect(count('two_factor_otp_used', "user_id = 'u-up'")).toBe(1);

    const setting = { where: { key: 'k' }, create: { key: 'k', value: 'a' } };
    await client.appSetting.upsert({ ...setting, update: {} });
    expect(await client.appSetting.upsert({ ...setting, update: {} })).toMatchObject({
      value: 'a',
    });
  });

  test('2FA lockout: recordFailedAttempt locks after five failures', async () => {
    const { checkRateLimit, recordFailedAttempt, resetRateLimit } = await import(
      '@/lib/two-factor/rate-limit'
    );
    for (let i = 0; i < 4; i++) expect(await recordFailedAttempt('u-lock')).toEqual({});
    expect((await recordFailedAttempt('u-lock')).lockedUntil).toBeInstanceOf(Date);
    expect((await checkRateLimit('u-lock')).allowed).toBe(false);
    await resetRateLimit('u-lock');
    expect((await checkRateLimit('u-lock')).allowed).toBe(true);
  });

  test('callback transaction: reads run before the first write, not after', async () => {
    const { client, transaction } = await prisma();
    await client.appSetting.create({ data: { key: 'tx', value: '1' } });
    const read = await transaction(async (tx: any) => {
      const row = await tx.appSetting.findUnique({ where: { key: 'tx' } });
      return tx.appSetting.update({ where: { key: 'tx' }, data: { value: `${+row.value + 1}` } });
    });
    expect(read.value).toBe('2');
    await expect(
      transaction(async (tx: any) => {
        await tx.appSetting.delete({ where: { key: 'tx' } });
        await tx.appSetting.findUnique({ where: { key: 'tx' } });
      }),
    ).rejects.toThrow(/after a write/);
    expect(count('app_setting', "key = 'tx'")).toBe(1);
  });

  test("deleting a user deletes its api keys and 2FA rows (Prisma's onDelete: Cascade)", async () => {
    sqlite.exec(`
      insert into user (user_id, username, password, role) values ('u-del', 'gone', 'x', 'user'), ('u-keep', 'kept', 'x', 'user');
      insert into api_key (api_key_id, user_id, name, key_hash, key_prefix) values ('k1', 'u-del', 'a', 'h1', 'p'), ('k2', 'u-keep', 'b', 'h2', 'p');
      insert into two_factor_auth (id, user_id, secret, updated_at) values ('t1', 'u-del', 's', '2026-01-01T00:00:00.000Z');
    `);
    const { client } = await prisma();
    await client.user.delete({ where: { id: 'u-del' } });
    expect(count('api_key', "user_id = 'u-del'")).toBe(0);
    expect(count('two_factor_auth', "user_id = 'u-del'")).toBe(0);
    expect(count('api_key', "user_id = 'u-keep'")).toBe(1);
  });

  test('deleteSession removes the session and its rows', async () => {
    sqlite.exec(`
      insert into session (session_id, website_id, created_at) values ('ds1', 'w3', '2026-01-15T00:00:00.000Z');
      insert into website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type) values
        ('dse1', 'w3', 'ds1', 'dsv1', '2026-01-15T00:00:00.000Z', '/', 1);
      insert into event_data (event_data_id, website_id, website_event_id, data_key, data_type, created_at) values
        ('dsd1', 'w3', 'dse1', 'k', 1, '2026-01-15T00:00:00.000Z');
    `);
    const { deleteSession } = await import('@/queries/prisma/session');
    expect(await deleteSession('w3', 'ds1')).toEqual({ id: 'ds1' });
    expect(count('session', "session_id = 'ds1'")).toBe(0);
    expect(count('website_event', "session_id = 'ds1'")).toBe(0);
    expect(count('event_data', "event_data_id = 'dsd1'")).toBe(0);
  });

  test("deleteWebsite runs upstream's DELETE … USING for drifted event_data", async () => {
    sqlite.exec(`
      insert into website (website_id, name, domain) values ('w4', 'Gone', 'gone.com');
      insert into website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type) values
        ('dwe1', 'w4', 'dws1', 'dwv1', '2026-01-15T00:00:00.000Z', '/', 1);
      insert into event_data (event_data_id, website_id, website_event_id, data_key, data_type, created_at) values
        ('dwd1', 'drifted', 'dwe1', 'k', 1, '2026-01-15T00:00:00.000Z');
    `);
    const { deleteWebsite } = await import('@/queries/prisma/website');
    await deleteWebsite('w4');
    expect(count('website', "website_id = 'w4'")).toBe(0);
    expect(count('event_data', "event_data_id = 'dwd1'")).toBe(0);
  });
});
