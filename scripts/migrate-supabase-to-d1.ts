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
import { Client } from 'pg';

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
const OUTPUT_DIR = path.join(process.cwd(), '.migration');

const D1_DATABASE = process.env.D1_DATABASE || 'umami';

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
    const values = rows.map(r => {
      const vals = this.columns.map(c => sqlLit(r[c.name])).join(', ');
      return `(${vals})`;
    });
    const stmt = `INSERT OR REPLACE INTO ${quoteIdent(this.table)} (${colList}) VALUES\n${values.join(',\n')};\n`;
    this.buf.push(stmt);

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
  try {
    execFileSync('wrangler', ['d1', 'execute', D1_DATABASE, flag, `--file=${file}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(' ok\n');
  } catch (err: any) {
    process.stdout.write(' FAIL\n');
    console.error(err.stderr?.toString() || err.message);
    throw err;
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
