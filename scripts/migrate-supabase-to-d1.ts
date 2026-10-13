#!/usr/bin/env tsx
/**
 * One-time Supabase (Postgres) → Cloudflare D1 (SQLite) data migration.
 *
 * Reads from Supabase via `pg`, transforms rows for SQLite typing, and emits
 * batched INSERT OR REPLACE SQL files under .migration/. Applies them via
 * `wrangler d1 execute`. Re-runnable: INSERT OR REPLACE means partial runs
 * can be resumed without uniqueness conflicts.
 *
 * Usage:
 *   tsx scripts/migrate-supabase-to-d1.ts --target=local   # local D1
 *   tsx scripts/migrate-supabase-to-d1.ts --target=remote  # production D1
 *   tsx scripts/migrate-supabase-to-d1.ts --target=local --dry-run
 *   tsx scripts/migrate-supabase-to-d1.ts --target=local --table=user
 *
 * Env:
 *   SUPABASE_DB_URL  Postgres URL (e.g. postgres://user:pass@host:5432/db)
 *   D1_DATABASE      D1 database name from wrangler.jsonc (default: umami)
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { Client } from 'pg';
import * as d1Schema from '../src/db/d1/schema';

type Args = {
  target: 'local' | 'remote';
  dryRun: boolean;
  onlyTable?: string;
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
  const target = (get('target') ?? 'local') as 'local' | 'remote';
  if (target !== 'local' && target !== 'remote') {
    throw new Error('--target must be "local" or "remote"');
  }
  return {
    target,
    dryRun: argv.includes('--dry-run'),
    onlyTable: get('table'),
  };
}

// Tables in FK-safe insertion order. Parents first.
const TABLES: TableSpec[] = [
  { name: 'user', orderBy: 'user_id' },
  { name: 'team', orderBy: 'team_id' },
  { name: 'team_user', orderBy: 'team_user_id' },
  { name: 'website', orderBy: 'website_id' },
  { name: 'session', orderBy: 'session_id' },
  { name: 'website_event', orderBy: 'event_id' },
  { name: 'event_data', orderBy: 'event_data_id' },
  { name: 'session_data', orderBy: 'session_data_id' },
  { name: 'report', orderBy: 'report_id' },
  { name: 'segment', orderBy: 'segment_id' },
  { name: 'revenue', orderBy: 'revenue_id' },
  { name: 'link', orderBy: 'link_id' },
  { name: 'pixel', orderBy: 'pixel_id' },
  { name: 'board', orderBy: 'board_id' },
  { name: 'share', orderBy: 'share_id' },
  { name: 'session_replay', orderBy: 'replay_id', hasBlob: true },
  { name: 'session_replay_saved', orderBy: 'saved_replay_id' },
];

type TableSpec = { name: string; orderBy: string; hasBlob?: boolean };

const BATCH_SIZE = 500;
// Rows per INSERT statement inside a batch file. D1 enforces a per-statement
// size cap (SQLITE_TOOBIG); for wide tables (website_event with long URL /
// referrer / page-title strings) 500-row mega-statements blow past it.
// Keeping files at ~500 rows total but splitting into ~25-row INSERTs keeps
// wrangler call count constant while staying well under the limit.
const STATEMENT_ROWS = 25;
const OUTPUT_DIR = path.join(process.cwd(), '.migration');

const D1_DATABASE = process.env.D1_DATABASE || 'umami';

// Build a map: pg-table-name → Set<db-column-name> from our Drizzle schema.
// Used to drop columns that exist in source Supabase but not in D1 (fork-
// added columns, legacy fields, etc.). Without this, the INSERT fails with
// "table X has no column named Y".
const D1_COLUMNS: Record<string, Set<string>> = (() => {
  const map: Record<string, Set<string>> = {};
  for (const exp of Object.values(d1Schema)) {
    if (!exp || typeof exp !== 'object') continue;
    try {
      const tableName = getTableName(exp as Table);
      const cols = getTableColumns(exp as Table);
      map[tableName] = new Set(Object.values(cols).map((c: any) => c.name));
    } catch {
      // not a drizzle table — skip
    }
  }
  return map;
})();

async function main() {
  const args = parseArgs();
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is required');

  const pg = new Client({ connectionString: url });
  await pg.connect();

  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const counts: Record<string, { source: number; written: number }> = {};

  const tables = args.onlyTable
    ? TABLES.filter(t => t.name === args.onlyTable)
    : TABLES;
  if (args.onlyTable && tables.length === 0) {
    throw new Error(`unknown table: ${args.onlyTable}`);
  }

  for (const spec of tables) {
    // Skip tables that don't exist in this Supabase — older umami forks may
    // predate later upstream migrations (segment, revenue, link, pixel, board,
    // share, session_replay*). The D1 schema is fresh and already has all
    // tables (empty); umami will populate them going forward.
    const { rows: existsRows } = await pg.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${spec.name}`],
    );
    if (!existsRows[0]?.present) {
      console.log(`\n== ${spec.name}: skipped (not present in source) ==`);
      counts[spec.name] = { source: 0, written: 0 };
      continue;
    }

    const { rows: countRows } = await pg.query(`SELECT count(*)::bigint AS n FROM "${spec.name}"`);
    const total = Number(countRows[0].n);
    counts[spec.name] = { source: total, written: 0 };
    console.log(`\n== ${spec.name}: ${total} rows ==`);
    if (total === 0) continue;

    const columns = await getColumns(pg, spec.name);
    const writer = new BatchWriter(spec.name, columns);

    // Cursor pagination using server-side cursor. Avoids OFFSET cost on large tables.
    await pg.query('BEGIN READ ONLY');
    await pg.query(
      `DECLARE migrate_cursor CURSOR FOR SELECT * FROM "${spec.name}" ORDER BY "${spec.orderBy}"`,
    );

    let written = 0;
    while (true) {
      const { rows } = await pg.query(`FETCH ${BATCH_SIZE} FROM migrate_cursor`);
      if (rows.length === 0) break;

      writer.add(rows.map(r => transformRow(r, columns, spec)));
      written += rows.length;
      if (written % 5000 === 0 || written === total) {
        process.stdout.write(`  ${written}/${total} rows queued\r`);
      }
    }
    await pg.query('CLOSE migrate_cursor');
    await pg.query('COMMIT');

    const batchFiles = writer.flush();
    console.log(`\n  wrote ${batchFiles.length} batch file(s)`);
    counts[spec.name].written = written;

    if (!args.dryRun) {
      for (const file of batchFiles) {
        applyBatch(file, args.target);
      }
    }
  }

  await pg.end();

  console.log('\n=== summary ===');
  for (const [t, c] of Object.entries(counts)) {
    console.log(`  ${t}: source=${c.source} sql-written=${c.written}`);
  }

  if (!args.dryRun) {
    console.log('\n=== validation ===');
    await validate(args.target, counts);
  } else {
    console.log('\n(dry-run: skipped wrangler apply + validation)');
  }
}

type ColumnInfo = { name: string; type: string; nullable: boolean };

async function getColumns(pg: Client, table: string): Promise<ColumnInfo[]> {
  const { rows } = await pg.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  const allowed = D1_COLUMNS[table];
  if (allowed) {
    const dropped = rows.filter(r => !allowed.has(r.column_name)).map(r => r.column_name);
    if (dropped.length > 0) {
      console.log(`    (skipping cols not in D1: ${dropped.join(', ')})`);
    }
    return rows
      .filter(r => allowed.has(r.column_name))
      .map(r => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
      }));
  }
  return rows.map(r => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === 'YES',
  }));
}

function transformRow(row: any, cols: ColumnInfo[], spec: TableSpec): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of cols) {
    const v = row[c.name];
    out[c.name] = transformValue(v, c, spec);
  }
  return out;
}

function transformValue(v: any, col: ColumnInfo, spec: TableSpec): any {
  if (v === null || v === undefined) return null;
  switch (col.type) {
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
    case 'bytea':
      // session_replay.events ships as Buffer; SQLite BLOB literals are x'<hex>'.
      return Buffer.isBuffer(v) ? `__BLOB__${v.toString('hex')}` : null;
    default:
      return v;
  }
}

class BatchWriter {
  private buf: string[] = [];
  private batchIndex = 0;
  private files: string[] = [];

  constructor(private table: string, private columns: ColumnInfo[]) {}

  add(rows: Record<string, any>[]) {
    if (rows.length === 0) return;
    const colList = this.columns.map(c => quoteIdent(c.name)).join(', ');
    const tableIdent = quoteIdent(this.table);

    // Split the batch into smaller INSERT statements so a single statement
    // never trips SQLITE_TOOBIG. One file still contains all rows from this
    // FETCH (so the wrangler call count is unchanged).
    for (let i = 0; i < rows.length; i += STATEMENT_ROWS) {
      const chunk = rows.slice(i, i + STATEMENT_ROWS);
      const values = chunk.map(r => {
        const vals = this.columns.map(c => sqlLit(r[c.name])).join(', ');
        return `(${vals})`;
      });
      const stmt = `INSERT OR REPLACE INTO ${tableIdent} (${colList}) VALUES\n${values.join(',\n')};\n`;
      this.buf.push(stmt);
    }

    // ~500 rows per file. Wrangler accepts files up to its statement size cap.
    if (this.buf.length >= 1) {
      this.flushFile();
    }
  }

  private flushFile() {
    if (this.buf.length === 0) return;
    const file = path.join(OUTPUT_DIR, `${this.table}_${String(this.batchIndex).padStart(4, '0')}.sql`);
    writeFileSync(file, this.buf.join(''));
    this.files.push(file);
    this.buf = [];
    this.batchIndex++;
  }

  flush() {
    this.flushFile();
    return this.files;
  }
}

function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlLit(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') {
    if (v.startsWith('__BLOB__')) {
      return `x'${v.slice('__BLOB__'.length)}'`;
    }
    return `'${v.replaceAll("'", "''")}'`;
  }
  // arrays/objects → JSON
  return `'${JSON.stringify(v).replaceAll("'", "''")}'`;
}

function applyBatch(file: string, target: 'local' | 'remote') {
  const flag = target === 'local' ? '--local' : '--remote';
  process.stdout.write(`  applying ${path.basename(file)} ...`);

  // Retry transient Cloudflare API errors. Wrangler hits the D1 `/import`
  // endpoint for large SQL files; long unbroken runs sometimes see OAuth /
  // rate-limit blips ("Authentication error [code: 10000]") that resolve on
  // a quick retry. Up to 4 attempts with exponential backoff.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      execFileSync('wrangler', ['d1', 'execute', D1_DATABASE, flag, `--file=${file}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      process.stdout.write(attempt === 1 ? ' ok\n' : ` ok (after ${attempt} attempts)\n`);
      return;
    } catch (err: any) {
      const isLast = attempt === MAX_ATTEMPTS;
      const stderr = err.stderr?.toString() || '';
      const looksTransient =
        stderr.includes('Authentication error') ||
        stderr.includes('code: 10000') ||
        stderr.includes('rate limit') ||
        stderr.includes('503') ||
        stderr.includes('504') ||
        stderr.includes('ECONNRESET') ||
        stderr.includes('ETIMEDOUT');
      if (isLast || !looksTransient) {
        process.stdout.write(' FAIL\n');
        console.error(stderr || err.message);
        if (looksTransient && isLast) {
          console.error(
            '\nThis looks like a Cloudflare auth/rate-limit issue. Try:\n' +
              '  1. `wrangler login` to refresh OAuth credentials\n' +
              '  2. Re-run the same command — already-applied batches re-apply harmlessly (INSERT OR REPLACE).',
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

async function validate(
  target: 'local' | 'remote',
  counts: Record<string, { source: number; written: number }>,
) {
  const flag = target === 'local' ? '--local' : '--remote';
  let failures = 0;
  for (const [table, c] of Object.entries(counts)) {
    if (c.source === 0) continue;
    const out = execFileSync(
      'wrangler',
      ['d1', 'execute', D1_DATABASE, flag, '--json', `--command=SELECT count(*) AS n FROM "${table}"`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    let actual: number | null = null;
    try {
      const parsed = JSON.parse(out);
      actual = Number(parsed[0]?.results?.[0]?.n);
    } catch {
      // wrangler json format varies; try best-effort scrape
      const m = out.match(/"n"\s*:\s*(\d+)/);
      if (m) actual = Number(m[1]);
    }
    const ok = actual === c.source;
    console.log(`  ${ok ? '✓' : '✗'} ${table}: source=${c.source} d1=${actual}`);
    if (!ok) failures++;
  }
  if (failures > 0) {
    console.error(`\n${failures} table(s) mismatched. Inspect .migration/ for the SQL files.`);
    process.exit(1);
  }
  console.log('\nRow counts match.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
