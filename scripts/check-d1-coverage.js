#!/usr/bin/env node
/**
 * Verifies that every src/queries/sql/*.ts file containing PG-specific SQL
 * patterns also has a matching D1/SQLite sibling under src/queries/sqlite/
 * and wires it via a `[D1]:` key on the runQuery dispatch.
 *
 * Best-effort static check, run during CI / pre-merge. New upstream queries
 * that introduce PG-only syntax will surface here.
 *
 * Run: node scripts/check-d1-coverage.js
 */

import { readFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SQL_DIR = path.join(ROOT, 'src/queries/sql');
const SQLITE_DIR = path.join(ROOT, 'src/queries/sqlite');

// PG-specific tokens that don't translate as-is to SQLite. Hits inside string
// literals or comments are not filtered out — false positives are OK; the goal
// is to flag review opportunities.
const PG_PATTERNS = [
  { name: 'extract(epoch from)', re: /extract\s*\(\s*epoch\s+from/i },
  { name: 'date_trunc(', re: /\bdate_trunc\s*\(/i },
  { name: 'ilike', re: /\bilike\b/i },
  { name: 'regex ~* / !~*', re: /[~!]~\*/ },
  { name: 'regexp_replace(', re: /\bregexp_replace\s*\(/i },
  { name: 'to_char(', re: /\bto_char\s*\(/i },
  { name: 'jsonb / json ->>', re: /->>|::jsonb/ },
  { name: '::uuid[] or ::int[]', re: /::(uuid|int|text|bigint)\[\]/ },
  { name: 'distinct on (', re: /\bdistinct\s+on\s*\(/i },
];

const PG_BRANCH_HEAD = /async\s+function\s+relationalQuery|\[PRISMA\]\s*:/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

let problems = 0;

for (const file of walk(SQL_DIR)) {
  if (file.endsWith('/index.ts')) continue;

  const rel = path.relative(SQL_DIR, file);
  const src = readFileSync(file, 'utf8');

  // We only care about files that contain a PG branch.
  if (!PG_BRANCH_HEAD.test(src)) continue;

  // Split into "PG region" — bytes between relationalQuery start and the next
  // top-level function declaration — and check for PG patterns there.
  const pgStart = src.search(/async\s+function\s+relationalQuery/);
  if (pgStart === -1) continue;

  const after = src.slice(pgStart);
  const pgEnd = after.search(/\nasync\s+function\s+\w+/g);
  const pgRegion = pgEnd > 0 ? after.slice(0, pgEnd) : after;

  const hits = PG_PATTERNS.filter(p => p.re.test(pgRegion)).map(p => p.name);
  if (hits.length === 0) continue;

  const siblingPath = path.join(SQLITE_DIR, rel);
  let hasSibling = true;
  try {
    statSync(siblingPath);
  } catch {
    hasSibling = false;
  }

  const hasD1Key = /\[\s*D1\s*\]\s*:/.test(src);

  if (!hasSibling || !hasD1Key) {
    problems++;
    console.error(`✗ ${rel}`);
    console.error(`    PG patterns: ${hits.join(', ')}`);
    if (!hasSibling) {
      console.error(`    missing sibling: src/queries/sqlite/${rel}`);
    }
    if (!hasD1Key) {
      console.error(`    missing [D1]: dispatch entry in runQuery({...})`);
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} file(s) need D1 coverage. See plan: prisma-d1 helpers and src/queries/sqlite/_helpers.ts.`);
  process.exit(1);
}

console.log('D1 coverage: OK');
