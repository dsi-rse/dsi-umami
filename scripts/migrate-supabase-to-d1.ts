#!/usr/bin/env tsx
/**
 * One-time Supabase (Postgres) → Cloudflare D1 (SQLite) data migration.
 *
 * Reads every selected table inside ONE repeatable-read snapshot, so no child row (event,
 * team_user) is copied without the parent it pointed at. Rows become byte-budgeted upsert SQL
 * files under .migration/; only after the snapshot closes are they applied with
 * `wrangler d1 execute`, and D1 is then checked against counts taken in that same snapshot.
 * Idempotent, not resumable: after a failure re-run the same command. It re-reads and
 * re-applies everything; rows already in D1 are no-op upserts.
 *
 * Two kinds of table:
 *   - mutable (user, api_key, two_factor_*, app_setting, team, team_user, website, report,
 *     segment, annotation, link, pixel, board, share, session_replay_saved): small, edited in
 *     place. Every run mirrors them with `DELETE FROM` + full copy, so deletions (revoked
 *     members, removed share links, revoked API keys) reach D1.
 *   - append-only (session, session_link, website_event, event_data, session_data, revenue,
 *     session_replay, heatmap_event): large. --since copies only rows with created_at >= since.
 *     Rows deleted from these in Supabase after an earlier run (website reset/delete) stay in
 *     D1; a full run's validation reports them as D1 being ahead of the source.
 *
 * The source may still be on an older upstream schema. Tables it doesn't have yet are skipped
 * (D1 keeps them empty), columns it doesn't have get D1's defaults, and LEGACY_COLUMNS reads
 * renamed columns under their new names. Data changes of the D1 migrations that ran before
 * the import are repeated on the copy: session_data is deduplicated by its upsert key, and
 * 0008_lowercase_username runs again after `user` is copied.
 *
 * Cutover:
 *   1. Ahead of time, a full run:          --target=remote
 *   2. Just before the DNS flip, a delta run that also re-mirrors the mutable tables:
 *                                          --target=remote --since=<printed by run 1>
 *      A run WITHOUT --skip-mutable must finish before the flip. After it the D1 app owns the
 *      mutable tables, and wiping them would lose rows created in D1.
 *   3. After the flip, catch up writes that reached Supabase during DNS propagation:
 *                                          --target=remote --since=<printed by run 2> --skip-mutable
 *   4. Once Supabase gets no more writes:  (same flags as 3) --validate-only
 *   Each run prints the --since for the next one: its snapshot time minus a safety margin.
 *
 * Usage: tsx scripts/migrate-supabase-to-d1.ts [flags]
 *   --target=local|remote   D1 to write (default local)
 *   --dry-run               read + write .migration/ only; no apply, no validation
 *   --validate-only         no read/apply; compare a fresh source snapshot against D1
 *   --since=<ISO time>      append-only tables: only rows with created_at >= since
 *   --skip-mutable          leave mutable tables alone (post-flip; needs --since). D1 then
 *                           only has to be at or ahead of the source.
 *   --table=<name>          only this table
 *   --exclude=t1,t2         skip tables, e.g. session_replay when a chunk is over D1's
 *                           100 KB statement limit
 *   --allow-drop=t.col,...  source columns with no D1 column whose data may be dropped; any
 *                           other such column fails the run before D1 is touched
 *
 * Env:
 *   SUPABASE_DB_URL   Postgres URL (e.g. postgres://user:pass@host:5432/db)
 *   SUPABASE_CA_CERT  path to Supabase's CA certificate (Dashboard → Database → SSL). Unless
 *                     the URL sets sslmode, TLS is always on; this file makes it verified.
 *   D1_DATABASE       D1 database name from wrangler.jsonc (default: umami)
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Client } from 'pg';
import * as d1Schema from '../src/db/d1/schema';

type Args = {
  target: 'local' | 'remote';
  dryRun: boolean;
  validateOnly: boolean;
  skipMutable: boolean;
  since?: string;
  onlyTable?: string;
  exclude: Set<string>;
  allowDrop: Set<string>;
  // Source columns a LegacySource rebuilds into another table; not dropped data.
  moved: Set<string>;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const eq = argv.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const flagIdx = argv.indexOf(`--${name}`);
    if (flagIdx >= 0) return argv[flagIdx + 1];
    return undefined;
  };
  const list = (name: string) =>
    new Set(
      get(name)
        ?.split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
  const target = (get('target') ?? 'local') as 'local' | 'remote';
  if (target !== 'local' && target !== 'remote') {
    throw new Error('--target must be "local" or "remote"');
  }
  const sinceArg = get('since');
  const since = sinceArg === undefined ? undefined : new Date(sinceArg);
  if (since && Number.isNaN(since.getTime())) throw new Error(`--since is not a time: ${sinceArg}`);
  const args: Args = {
    target,
    dryRun: argv.includes('--dry-run'),
    validateOnly: argv.includes('--validate-only'),
    skipMutable: argv.includes('--skip-mutable'),
    // Normalized so it compares correctly against the ISO strings stored in D1.
    since: since?.toISOString(),
    onlyTable: get('table'),
    exclude: list('exclude'),
    allowDrop: list('allow-drop'),
    moved: new Set<string>(),
  };
  // Without --since a post-flip pass re-imports every event into the live D1.
  if (args.skipMutable && !args.since && !args.validateOnly) {
    throw new Error('--skip-mutable needs --since (post-flip passes are catch-ups)');
  }
  for (const t of [args.onlyTable, ...args.exclude]) {
    if (t && !TABLES.some(s => s.name === t)) throw new Error(`unknown table: ${t}`);
  }
  return args;
}

// appendOnly: large insert-only logs that --since narrows by created_at. The rest are small and
// edited in place, so every run mirrors them whole. Parents first (D1 has no FK constraints, but
// a partly applied run stays readable). `after`: a D1 SQL file run once the table is copied.
// The two_factor_* tables hold short-lived state too (OTP replay window, lockouts); mirroring
// them keeps a lockout in force across the cutover.
type TableSpec = {
  name: string;
  appendOnly?: boolean;
  latestPer?: string[];
  after?: string;
  legacy?: LegacySource;
};

// A table an older source doesn't have yet but whose data it keeps elsewhere: when `column`
// exists in the source, the rows are rebuilt with `from` (selecting `columns`), the same
// transform the upstream migration applies, and `column` counts as moved rather than dropped.
type LegacySource = {
  column: [string, string];
  columns: ColumnInfo[];
  from: string;
  order: string;
};

// 15_add_share: a website's share link moved from website.share_id to a share row. The id is
// derived from the website and slug so re-runs upsert the same row.
const LEGACY_SHARE: LegacySource = {
  column: ['website', 'share_id'],
  columns: [
    { name: 'share_id', type: 'uuid', select: `md5("website_id"::text || "share_id")::uuid` },
    { name: 'entity_id', type: 'uuid', select: '"website_id"' },
    { name: 'name', type: 'character varying', select: '"name"' },
    { name: 'share_type', type: 'integer', select: '1' },
    { name: 'slug', type: 'character varying', select: '"share_id"' },
    { name: 'parameters', type: 'jsonb', select: `'{"overview":true}'::jsonb` },
    { name: 'created_at', type: 'timestamp with time zone', select: 'now()' },
  ],
  from: '"website" WHERE "share_id" IS NOT NULL',
  order: '"website_id"',
};
const TABLES: TableSpec[] = [
  // Usernames from a source that predates upstream's 24_lowercase_username still have
  // capitals, and logins look up the lowercased name. The file is idempotent.
  { name: 'user', after: 'prisma/migrations-d1/0008_lowercase_username.sql' },
  { name: 'api_key' },
  { name: 'two_factor_auth' },
  { name: 'two_factor_backup_code' },
  { name: 'two_factor_otp_used' },
  { name: 'two_factor_rate_limit' },
  { name: 'app_setting' },
  { name: 'team' },
  { name: 'team_user' },
  { name: 'website' },
  { name: 'session', appendOnly: true },
  { name: 'session_link', appendOnly: true },
  { name: 'website_event', appendOnly: true },
  { name: 'event_data', appendOnly: true },
  // One row per (session_id, data_key), D1's unique key: the newest wins, whether the source
  // still has duplicates (before upstream's 23_update_session_data) or a row was rewritten,
  // and after the flip an older Supabase row never displaces a newer D1-native one.
  { name: 'session_data', appendOnly: true, latestPer: ['session_id', 'data_key'] },
  { name: 'report' },
  { name: 'segment' },
  { name: 'annotation' },
  { name: 'revenue', appendOnly: true },
  { name: 'link' },
  { name: 'pixel' },
  { name: 'board' },
  { name: 'share', legacy: LEGACY_SHARE },
  { name: 'session_replay', appendOnly: true },
  { name: 'session_replay_saved' },
  { name: 'heatmap_event', appendOnly: true },
];

// Older umami forks may predate later upstream tables (segment, revenue, link, pixel, board,
// share, session_replay*, heatmap_event, session_link, two_factor_*, app_setting, annotation,
// api_key), which then stay empty in D1. Missing one of these means the wrong database.
const CORE_TABLES = new Set(['user', 'website', 'session', 'website_event']);

// Source columns that a later upstream migration renamed, for sources that haven't run it:
// read `from` as `to`, with `select` giving the source SQL for the affected D1 columns, the
// same transform the migration applies.
const LEGACY_COLUMNS: Record<string, { from: string; to: string; select: Record<string, string> }> =
  {
    // 20_add_heatmap (D1 0004): the flag moved into replay_config.replayEnabled.
    website: {
      from: 'replay_enabled',
      to: 'recorder_enabled',
      select: {
        recorder_enabled: '"replay_enabled"',
        replay_config:
          `CASE WHEN "replay_enabled" THEN COALESCE("replay_config", '{}'::jsonb)` +
          ` || '{"replayEnabled": true}'::jsonb ELSE "replay_config" END`,
      },
    },
  };

const FETCH_ROWS = 500; // rows per cursor FETCH, and per .sql file
// D1 rejects any single statement over 100 KB (SQLITE_TOOBIG). Statements are packed by UTF-8
// bytes, not rows: wide website_event rows and hex blobs (2 bytes per byte) vary a lot.
export const STATEMENT_BYTES = 90_000;
// Next --since = snapshot time minus this. Rows can commit after the snapshot with an earlier
// created_at (the app sets it before INSERT), and re-copying overlap is a no-op upsert.
const SINCE_MARGIN_MS = 60 * 60 * 1000;
const OUTPUT_DIR = path.join(process.cwd(), '.migration');

const D1_DATABASE = process.env.D1_DATABASE || 'umami';

// pg-table-name → D1 columns and primary key, from the Drizzle schema. Source columns outside
// the set have no home in D1 (fork-added or legacy fields); the PK is the ON CONFLICT target.
export const D1_TABLES: Record<string, { columns: Set<string>; pk: string[] }> = {};
for (const t of Object.values(d1Schema)) {
  if (!is(t, SQLiteTable)) continue;
  const { name, columns, primaryKeys } = getTableConfig(t);
  D1_TABLES[name] = {
    columns: new Set(columns.map(c => c.name)),
    pk: [
      ...columns.filter(c => c.primary).map(c => c.name),
      ...primaryKeys.flatMap(k => k.columns.map(c => c.name)),
    ],
  };
}
for (const t of TABLES) {
  if (!D1_TABLES[t.name]?.pk.length) throw new Error(`${t.name}: no primary key in D1 schema`);
}

type Stats = { n: number; max: string | null };

async function main() {
  const args = parseArgs();
  const tables = TABLES.filter(
    t =>
      (!args.onlyTable || t.name === args.onlyTable) &&
      !args.exclude.has(t.name) &&
      (t.appendOnly || !args.skipMutable),
  );
  if (tables.length === 0) throw new Error('no tables selected');

  const pg = connect();
  await pg.connect();
  // One snapshot for every table. Reading each table in its own transaction let rows created
  // between reads (a new website and its first events) reach D1 without their parents.
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const {
    rows: [{ snapshot_at }],
  } = await pg.query('SELECT now() AS snapshot_at');
  const source: Record<string, Stats> = {};
  const missing: string[] = [];
  const dropped: string[] = [];
  const files: string[] = [];
  if (!args.validateOnly) {
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const present = async (table: string) =>
    (await pg.query('SELECT to_regclass($1) IS NOT NULL AS p', [`public.${table}`])).rows[0].p;
  // Resolve legacy sources up front: the column they read (website.share_id) belongs to a table
  // copied earlier, which must then accept it as moved.
  const legacyFor = new Map<string, LegacySource>();
  for (const spec of TABLES) {
    if (!spec.legacy || (await present(spec.name))) continue;
    const [t, c] = spec.legacy.column;
    const { rows } = await pg.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [t, c],
    );
    if (rows.length) {
      legacyFor.set(spec.name, spec.legacy);
      args.moved.add(`${t}.${c}`);
      console.log(`  ${t}.${c} predates the ${spec.name} table; rebuilding ${spec.name} from it`);
    }
  }

  for (const spec of tables) {
    const legacy = legacyFor.get(spec.name);
    if (!legacy && !(await present(spec.name))) {
      if (CORE_TABLES.has(spec.name)) throw new Error(`core table "${spec.name}" not in source`);
      missing.push(spec.name);
      continue;
    }
    const since = spec.appendOnly ? args.since : undefined;
    // latestPer tables end up with one D1 row per key, so that is the count to match.
    const counted = spec.latestPer
      ? `DISTINCT (${spec.latestPer.map(quoteIdent).join(', ')})`
      : '*';
    const {
      rows: [r],
    } = await pg.query(
      `SELECT count(${counted}) AS n, ${spec.appendOnly ? 'max(created_at)' : 'NULL'} AS m` +
        ` FROM ${legacy ? legacy.from : quoteIdent(spec.name) + sinceFilter(since)}`,
    );
    source[spec.name] = { n: Number(r.n), max: transformValue(r.m, 'timestamp with time zone') };
    console.log(`== ${spec.name}: ${r.n} rows${since ? ` since ${since}` : ''} ==`);
    if (!args.validateOnly) files.push(...(await copyTable(pg, spec, args, dropped, legacy)));
  }
  await pg.query('COMMIT');
  await pg.end();

  const snapshotAt = new Date(snapshot_at);
  console.log(`\n=== summary (source snapshot ${snapshotAt.toISOString()}) ===`);
  if (missing.length) console.log(`  not in source, D1 left as is: ${missing.join(', ')}`);
  if (args.exclude.size) console.log(`  excluded: ${[...args.exclude].join(', ')}`);
  if (args.skipMutable) console.log('  mutable tables left as is (--skip-mutable)');
  if (dropped.length) console.log(`  source columns dropped (--allow-drop): ${dropped.join(', ')}`);
  if (!args.validateOnly) {
    const next = new Date(snapshotAt.getTime() - SINCE_MARGIN_MS).toISOString();
    console.log(`  next catch-up run: --since=${next}`);
  }

  if (args.dryRun && !args.validateOnly) {
    console.log(`\n(dry-run: ${files.length} file(s) in .migration/; skipped apply + validation)`);
    return;
  }
  for (const file of files) applyBatch(file, args.target);
  validate(
    args,
    tables.filter(t => source[t.name]),
    source,
  );
}

function connect() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is required');
  // pg speaks plaintext unless told otherwise. An sslmode in the URL wins; otherwise always
  // encrypt, and verify the server when SUPABASE_CA_CERT points at Supabase's CA certificate.
  const ca = process.env.SUPABASE_CA_CERT;
  const ssl = /[?&]sslmode=/.test(url)
    ? undefined
    : ca
      ? { ca: readFileSync(ca, 'utf8') }
      : { rejectUnauthorized: false };
  return new Client({ connectionString: url, ssl });
}

// Only ever given a value normalized by parseArgs, so the literal is a bare ISO timestamp.
// Valid in both Postgres and SQLite.
function sinceFilter(since?: string) {
  return since ? ` WHERE "created_at" >= ${sqlLit(since)}` : '';
}

async function copyTable(
  pg: Client,
  spec: TableSpec,
  args: Args,
  dropped: string[],
  legacy?: LegacySource,
) {
  const { pk } = D1_TABLES[spec.name];
  const cols = legacy ? legacy.columns : await getColumns(pg, spec.name, args, dropped);
  const names = cols.map(c => c.name);
  const since = spec.appendOnly ? args.since : undefined;
  // Mirror by emptying first, so rows deleted in Supabase leave D1 too. Append-only tables are
  // only upserted: wiping would force the full re-copy --since exists to avoid.
  const wipe = !spec.appendOnly;
  // created_at first so rows land in D1 in time order, which is how reports range-scan them.
  const order =
    legacy?.order ?? [...(spec.appendOnly ? ['created_at'] : []), ...pk].map(quoteIdent).join(', ');
  const select = cols.map(c => (c.select ? `${c.select} AS ` : '') + quoteIdent(c.name));
  const from = legacy ? legacy.from : quoteIdent(spec.name) + sinceFilter(since);
  await pg.query(
    `DECLARE migrate_cursor CURSOR FOR SELECT ${select.join(', ')} FROM ${from} ORDER BY ${order}`,
  );

  const files: string[] = [];
  const write = (stmts: string[]) => {
    const file = path.join(OUTPUT_DIR, `${spec.name}_${String(files.length).padStart(4, '0')}.sql`);
    writeFileSync(file, stmts.join(''));
    files.push(file);
  };
  let written = 0;
  while (true) {
    const { rows } = await pg.query(`FETCH ${FETCH_ROWS} FROM migrate_cursor`);
    if (rows.length === 0) break;
    const values = rows.map(r => transformRow(r, cols));
    write(
      buildStatements(spec.name, names, pk, values, {
        wipe: wipe && !files.length,
        latestPer: spec.latestPer,
      }),
    );
    written += rows.length;
    process.stdout.write(`  ${written} rows written\r`);
  }
  await pg.query('CLOSE migrate_cursor');
  // Empty in the source: D1 still has to be emptied to match.
  if (wipe && !files.length) write(buildStatements(spec.name, names, pk, [], { wipe }));
  if (spec.after) write([readFileSync(spec.after, 'utf8')]);
  console.log(`  ${written} rows written, ${files.length} batch file(s)`);
  return files;
}

// `select`: source SQL read under this name, for LEGACY_COLUMNS.
type ColumnInfo = { name: string; type: string; select?: string };

async function getColumns(
  pg: Client,
  table: string,
  { allowDrop, moved }: Pick<Args, 'allowDrop' | 'moved'>,
  dropped: string[],
): Promise<ColumnInfo[]> {
  const { rows } = await pg.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  const d1 = D1_TABLES[table].columns;
  const legacy = LEGACY_COLUMNS[table];
  const renamed =
    legacy &&
    rows.some(r => r.column_name === legacy.from) &&
    !rows.some(r => r.column_name === legacy.to);
  const cols: ColumnInfo[] = rows.map(r => {
    if (!renamed) return { name: r.column_name, type: r.data_type };
    const name = r.column_name === legacy.from ? legacy.to : r.column_name;
    return { name, type: r.data_type, select: legacy.select[name] };
  });
  if (renamed) console.log(`  reading ${table}.${legacy.from} as ${legacy.to}`);
  // A source column D1 has no place for would otherwise vanish with only a log line.
  const extra = cols.filter(c => !d1.has(c.name)).map(c => `${table}.${c.name}`);
  const refused = extra.filter(c => !allowDrop.has(c) && !moved.has(c));
  if (refused.length) {
    throw new Error(
      `source columns missing from the D1 schema: ${refused.join(', ')}. Add them to ` +
        `src/db/d1/schema.ts + a D1 migration, or drop their data: --allow-drop=${refused.join(',')}`,
    );
  }
  dropped.push(...extra.filter(c => !moved.has(c)));
  return cols.filter(c => d1.has(c.name));
}

function transformRow(row: any, cols: ColumnInfo[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of cols) out[c.name] = transformValue(row[c.name], c.type);
  return out;
}

export function transformValue(v: any, type: string): any {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'uuid':
      return String(v);
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date':
      return v instanceof Date ? v.toISOString() : String(v);
    case 'json':
    case 'jsonb':
      return JSON.stringify(v);
    case 'numeric':
    case 'decimal':
      return String(v);
    case 'boolean':
      return v ? 1 : 0;
    default:
      // bytea (session_replay.events) arrives as a Buffer and stays one; sqlLit emits x'..'.
      return v;
  }
}

/**
 * Packs rows into `INSERT ... ON CONFLICT (pk) DO UPDATE` statements of at most `budget` bytes.
 * Unlike INSERT OR REPLACE, a pk upsert never deletes a different row that merely shares a
 * unique value (username, slug, access_code), and never resets columns absent from the source.
 * `wipe` prepends `DELETE FROM` (first batch of a mirrored table). `latestPer` names a unique key
 * to upsert on instead of the pk: a row replaces the one holding its key (pk included) only if
 * it is at least as new, by created_at (NULL oldest) then pk.
 */
export function buildStatements(
  table: string,
  columns: string[],
  pk: string[],
  rows: Record<string, unknown>[],
  {
    budget = STATEMENT_BYTES,
    wipe,
    latestPer,
  }: { budget?: number; wipe?: boolean; latestPer?: string[] } = {},
): string[] {
  const t = quoteIdent(table);
  const q = (cols: string[]) => cols.map(quoteIdent).join(', ');
  const tuple = (r: Record<string, unknown>, cols: string[]) =>
    `(${cols.map(c => sqlLit(r[c])).join(', ')})`;
  const target = latestPer ?? pk;
  const updates = columns
    .filter(c => !target.includes(c))
    .map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
  const recency = (prefix: string) =>
    ['created_at', ...pk].map(c => `coalesce(${prefix}${quoteIdent(c)}, '')`).join(', ');
  const newer = latestPer ? ` WHERE (${recency('excluded.')}) >= (${recency(`${t}.`)})` : '';
  const head = `INSERT INTO ${t} (${q(columns)}) VALUES\n`;
  const tail =
    `\nON CONFLICT (${q(target)}) DO ` +
    `${updates.length ? `UPDATE SET ${updates.join(', ')}${newer}` : 'NOTHING'};\n`;
  const fixed = Buffer.byteLength(head + tail);

  const out = wipe ? [`DELETE FROM ${t};\n`] : [];
  let tuples: string[] = [];
  let size = fixed;
  const flush = () => {
    if (!tuples.length) return;
    out.push(head + tuples.join(',\n') + tail);
    tuples = [];
    size = fixed;
  };
  for (const r of rows) {
    const values = tuple(r, columns);
    const bytes = Buffer.byteLength(values) + 2; // ',\n'
    if (fixed + bytes > budget) {
      const id = pk.map(c => `${c}=${r[c]}`).join(', ');
      throw new Error(
        `${table} row ${id} alone needs ${fixed + bytes} bytes, over the ${budget}-byte D1 ` +
          `statement budget. Re-run with --exclude=${table} and move that table another way.`,
      );
    }
    if (size + bytes > budget) flush();
    tuples.push(values);
    size += bytes;
  }
  flush();
  return out;
}

function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

// Strings are always quoted: the text is visitor-controlled (page_title, url_path, event data),
// so no string may ever be emitted raw. Blobs are recognized by type, never by content.
export function sqlLit(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return `x'${v.toString('hex')}'`;
  if (v instanceof Date) return sqlLit(v.toISOString());
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  // arrays/objects → JSON
  return sqlLit(JSON.stringify(v));
}

// Retries transient Cloudflare API errors. Wrangler hits the D1 `/import` endpoint for large SQL
// files; long unbroken runs sometimes see OAuth / rate-limit blips ("Authentication error
// [code: 10000]") that resolve on a quick retry. Up to 4 attempts with exponential backoff.
function wrangler(args: string[]): string {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('wrangler', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      const looksTransient =
        stderr.includes('Authentication error') ||
        stderr.includes('code: 10000') ||
        stderr.includes('rate limit') ||
        stderr.includes('503') ||
        stderr.includes('504') ||
        stderr.includes('ECONNRESET') ||
        stderr.includes('ETIMEDOUT');
      if (attempt === MAX_ATTEMPTS || !looksTransient) {
        process.stdout.write(' FAIL\n');
        console.error(stderr || err.message);
        if (looksTransient) {
          console.error(
            '\nThis looks like a Cloudflare auth/rate-limit issue. Try:\n' +
              '  1. `wrangler login` to refresh OAuth credentials\n' +
              '  2. Re-run the same command: it re-reads the source and re-applies every batch;' +
              ' rows already in D1 are no-op upserts.',
          );
        }
        throw err;
      }
      const delaySec = 5 * 2 ** (attempt - 1); // 5, 10, 20 seconds
      process.stdout.write(` retry in ${delaySec}s (attempt ${attempt}/${MAX_ATTEMPTS - 1}) ...`);
      try {
        execFileSync('sleep', [String(delaySec)], { stdio: 'ignore' });
      } catch {
        // ignore sleep errors; immediately retry
      }
    }
  }
}

function applyBatch(file: string, target: Args['target']) {
  process.stdout.write(`  applying ${path.basename(file)} ...`);
  wrangler(['d1', 'execute', D1_DATABASE, `--${target}`, `--file=${file}`]);
  process.stdout.write(' ok\n');
}

function d1Stats(target: Args['target'], spec: TableSpec, since?: string): Stats {
  const sql =
    `SELECT count(*) AS n, ${spec.appendOnly ? 'max("created_at")' : 'NULL'} AS m` +
    ` FROM ${quoteIdent(spec.name)}${sinceFilter(since)}`;
  const out = wrangler(['d1', 'execute', D1_DATABASE, `--${target}`, '--json', `--command=${sql}`]);
  let row: any;
  try {
    row = JSON.parse(out.slice(out.indexOf('[')))[0]?.results?.[0];
  } catch {
    // reported below
  }
  if (!row) throw new Error(`unexpected wrangler output for ${spec.name}: ${out}`);
  return { n: Number(row.n), max: row.m ?? null };
}

function validate(args: Args, tables: TableSpec[], source: Record<string, Stats>) {
  console.log('\n=== validation ===');
  // After the flip D1 takes its own writes on top of the copy: it may be ahead, never behind.
  const live = args.skipMutable;
  let failures = 0;
  let ahead = false;
  for (const spec of tables) {
    const src = source[spec.name];
    const since = spec.appendOnly ? args.since : undefined;
    const d1 = d1Stats(args.target, spec, since);
    const ok = live
      ? d1.n >= src.n && (d1.max ?? '') >= (src.max ?? '')
      : d1.n === src.n && d1.max === src.max;
    if (!ok) failures++;
    if (!ok && d1.n > src.n) ahead = true;
    const max = spec.appendOnly ? `  max(created_at) source=${src.max} d1=${d1.max}` : '';
    const label = `${spec.name}${since ? ` (since ${since})` : ''}`;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: source=${src.n} d1=${d1.n}${max}`);
  }
  if (failures === 0) {
    console.log(live ? '\nD1 is at or ahead of the source.' : '\nD1 matches the source snapshot.');
    return;
  }
  console.error(`\n${failures} table(s) mismatched. Inspect .migration/ for the SQL files.`);
  if (ahead && !live) {
    console.error(
      'D1 has rows the source does not: deleted in Supabase after an earlier run, or written ' +
        'to D1 directly. Re-import into an empty D1 database to drop them.',
    );
  }
  process.exitCode = 1;
}

// Imported by scripts/check-d1-import.ts for the pure helpers; only run when executed.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
