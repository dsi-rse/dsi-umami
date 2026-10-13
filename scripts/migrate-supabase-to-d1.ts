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
 *   - mutable (user, team, team_user, website, report, segment, link, pixel, board, share,
 *     session_replay_saved): small, edited in place. Every run mirrors them with
 *     `DELETE FROM` + full copy, so deletions (revoked members, removed share links) reach D1.
 *   - append-only (session, website_event, event_data, session_data, revenue, session_replay):
 *     large. --since copies only rows with created_at >= since. Rows deleted from these in
 *     Supabase after an earlier run (website reset/delete) stay in D1; a full run's
 *     validation reports them as D1 being ahead of the source.
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
// a partly applied run stays readable).
type TableSpec = { name: string; appendOnly?: boolean; latestPer?: string[] };
const TABLES: TableSpec[] = [
  { name: 'user' },
  { name: 'team' },
  { name: 'team_user' },
  { name: 'website' },
  { name: 'session', appendOnly: true },
  { name: 'website_event', appendOnly: true },
  { name: 'event_data', appendOnly: true },
  // saveSessionData rewrites a (session_id, data_key) row with a fresh session_data_id and
  // created_at, so D1 keeps only the latest row per key: drops the id an earlier run copied,
  // and after the flip never lets an older Supabase row displace a newer D1-native one.
  { name: 'session_data', appendOnly: true, latestPer: ['session_id', 'data_key'] },
  { name: 'report' },
  { name: 'segment' },
  { name: 'revenue', appendOnly: true },
  { name: 'link' },
  { name: 'pixel' },
  { name: 'board' },
  { name: 'share' },
  { name: 'session_replay', appendOnly: true },
  { name: 'session_replay_saved' },
];

// Older umami forks may predate later upstream tables (segment, revenue, link, pixel, board,
// share, session_replay*), which then stay empty in D1. Missing one of these means the wrong
// database.
const CORE_TABLES = new Set(['user', 'website', 'session', 'website_event']);

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

  for (const spec of tables) {
    const { rows } = await pg.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `public.${spec.name}`,
    ]);
    if (!rows[0]?.present) {
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
        ` FROM ${quoteIdent(spec.name)}${sinceFilter(since)}`,
    );
    source[spec.name] = { n: Number(r.n), max: transformValue(r.m, 'timestamp with time zone') };
    console.log(`== ${spec.name}: ${r.n} rows${since ? ` since ${since}` : ''} ==`);
    if (!args.validateOnly) files.push(...(await copyTable(pg, spec, args, dropped)));
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

async function copyTable(pg: Client, spec: TableSpec, args: Args, dropped: string[]) {
  const { pk } = D1_TABLES[spec.name];
  const cols = await getColumns(pg, spec.name, args.allowDrop, dropped);
  const names = cols.map(c => c.name);
  const since = spec.appendOnly ? args.since : undefined;
  // Mirror by emptying first, so rows deleted in Supabase leave D1 too. Append-only tables are
  // only upserted: wiping would force the full re-copy --since exists to avoid.
  const wipe = !spec.appendOnly;
  // created_at first so rows land in D1 in time order, which is how reports range-scan them.
  const order = [...(spec.appendOnly ? ['created_at'] : []), ...pk].map(quoteIdent).join(', ');
  await pg.query(
    `DECLARE migrate_cursor CURSOR FOR SELECT ${names.map(quoteIdent).join(', ')}` +
      ` FROM ${quoteIdent(spec.name)}${sinceFilter(since)} ORDER BY ${order}`,
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
  console.log(`  ${written} rows written, ${files.length} batch file(s)`);
  return files;
}

type ColumnInfo = { name: string; type: string };

async function getColumns(
  pg: Client,
  table: string,
  allowDrop: Set<string>,
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
  // A source column D1 has no place for would otherwise vanish with only a log line.
  const extra = rows.filter(r => !d1.has(r.column_name)).map(r => `${table}.${r.column_name}`);
  const refused = extra.filter(c => !allowDrop.has(c));
  if (refused.length) {
    throw new Error(
      `source columns missing from the D1 schema: ${refused.join(', ')}. Add them to ` +
        `src/db/d1/schema.ts + a D1 migration, or drop their data: --allow-drop=${refused.join(',')}`,
    );
  }
  dropped.push(...extra);
  return rows
    .filter(r => d1.has(r.column_name))
    .map(r => ({ name: r.column_name, type: r.data_type }));
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
 * `wipe` prepends `DELETE FROM` (first batch of a mirrored table). `latestPer` follows each
 * INSERT with a DELETE keeping only the newest row (by created_at, then pk) per key it touched.
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
  const q = (cols: string[], prefix = '') => cols.map(c => prefix + quoteIdent(c)).join(', ');
  const tuple = (r: Record<string, unknown>, cols: string[]) =>
    `(${cols.map(c => sqlLit(r[c])).join(', ')})`;
  const updates = columns
    .filter(c => !pk.includes(c))
    .map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
  const head = `INSERT INTO ${t} (${q(columns)}) VALUES\n`;
  const tail =
    `\nON CONFLICT (${q(pk)}) DO ` +
    `${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'};\n`;
  const fixed = Buffer.byteLength(head + tail);

  const out = wipe ? [`DELETE FROM ${t};\n`] : [];
  let chunk: Record<string, unknown>[] = [];
  let tuples: string[] = [];
  let size = fixed;
  const flush = () => {
    if (!tuples.length) return;
    out.push(head + tuples.join(',\n') + tail);
    if (latestPer) {
      const order = ['created_at', ...pk];
      const sameKey = latestPer.map(c => `"n".${quoteIdent(c)} = ${t}.${quoteIdent(c)}`);
      const del =
        `DELETE FROM ${t} WHERE (${q(latestPer)}) IN ` +
        `(VALUES ${chunk.map(r => tuple(r, latestPer)).join(', ')}) AND EXISTS (` +
        `SELECT 1 FROM ${t} AS "n" WHERE ${sameKey.join(' AND ')}` +
        ` AND (${q(order, '"n".')}) > (${q(order, `${t}.`)}));\n`;
      // Carries a subset of each row's values, so it is smaller than the INSERT it follows.
      if (Buffer.byteLength(del) > budget) throw new Error(`${table}: dedupe statement too big`);
      out.push(del);
    }
    chunk = [];
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
    chunk.push(r);
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
