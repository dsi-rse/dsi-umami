/**
 * Regression check for the SQL scripts/migrate-supabase-to-d1.ts writes: literal quoting,
 * upsert shape, the per-statement byte budget, and that the output executes against the D1
 * schema (prisma/migrations-d1, in an in-memory node:sqlite DB). Never touches Supabase or D1.
 *
 * Run: pnpm check-d1-import
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  buildStatements,
  D1_TABLES,
  STATEMENT_BYTES,
  sqlLit,
  transformValue,
} from './migrate-supabase-to-d1';

const evil = `__BLOB__', '/x'); DELETE FROM "user"; --`;
const bytes = (s: string) => Buffer.byteLength(s);

// Literals: visitor text is always a quoted string, whatever it starts with.
assert.equal(sqlLit(evil), `'__BLOB__'', ''/x''); DELETE FROM "user"; --'`);
assert.equal(sqlLit(Buffer.from([0, 1, 0xab])), "x'0001ab'");
assert.equal(sqlLit(transformValue(Buffer.from('hi'), 'bytea')), "x'6869'");
for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined]) {
  assert.equal(sqlLit(v), 'NULL');
}
assert.equal(sqlLit(1.5), '1.5');
assert.equal(sqlLit(true), '1');
const when = new Date('2026-01-02T03:04:05.678Z');
assert.equal(sqlLit(when), "'2026-01-02T03:04:05.678Z'");
assert.equal(transformValue(when, 'timestamp with time zone'), '2026-01-02T03:04:05.678Z');
assert.equal(sqlLit(transformValue({ a: "it's" }, 'jsonb')), `'{"a":"it''s"}'`);
assert.equal(sqlLit({ a: [1] }), `'{"a":[1]}'`);
assert.equal(transformValue(false, 'boolean'), 0);

// Statement shape: pk upsert from the Drizzle schema, not INSERT OR REPLACE.
assert.deepEqual(D1_TABLES.user.pk, ['user_id']);
const userCols = ['user_id', 'username', 'password', 'role'];
const user = (id: string, username: string) => ({
  user_id: id,
  username,
  password: 'x',
  role: 'user',
});
const userSql = (rows: Record<string, unknown>[], wipe = true) =>
  buildStatements('user', userCols, D1_TABLES.user.pk, rows, { wipe }).join('');
assert.equal(
  buildStatements('user', userCols, ['user_id'], [user('u1', 'ann')]).join(''),
  `INSERT INTO "user" ("user_id", "username", "password", "role") VALUES\n` +
    `('u1', 'ann', 'x', 'user')\n` +
    `ON CONFLICT ("user_id") DO UPDATE SET "username" = excluded."username", ` +
    `"password" = excluded."password", "role" = excluded."role";\n`,
);
assert.deepEqual(buildStatements('user', userCols, ['user_id'], [], { wipe: true }), [
  'DELETE FROM "user";\n',
]);

// Byte budget: multi-byte text, so a char-counting builder would overshoot.
const eventCols = ['event_id', 'website_id', 'session_id', 'visit_id', 'url_path', 'page_title'];
const events = Array.from({ length: 200 }, (_, i) => ({
  event_id: `e${i}`,
  website_id: 'w1',
  session_id: 's1',
  visit_id: 'v1',
  url_path: '/',
  page_title: `${i}${'é'.repeat(1500)}`,
}));
const eventStmts = buildStatements('website_event', eventCols, ['event_id'], events);
assert.ok(eventStmts.length > 1);
for (const s of eventStmts) assert.ok(bytes(s) <= STATEMENT_BYTES, `${bytes(s)} bytes`);
const replay = {
  replay_id: 'r1',
  website_id: 'w1',
  session_id: 's1',
  visit_id: 'v1',
  chunk_index: 0,
  events: Buffer.alloc(16),
  event_count: 1,
  started_at: when.toISOString(),
  ended_at: when.toISOString(),
};
const replayCols = Object.keys(replay);
assert.throws(
  () =>
    buildStatements(
      'session_replay',
      replayCols,
      ['replay_id'],
      [{ ...replay, events: Buffer.alloc(STATEMENT_BYTES / 2) }],
    ),
  /session_replay row replay_id=r1 .*--exclude=session_replay/,
);

// Execute against the real D1 schema.
const db = new DatabaseSync(':memory:');
const dir = 'prisma/migrations-d1';
for (const f of readdirSync(dir)
  .filter(f => f.endsWith('.sql'))
  .sort()) {
  db.exec(readFileSync(`${dir}/${f}`, 'utf8'));
}
// node:sqlite rows have a null prototype; spread them so deepEqual compares plain objects.
const all = (sql: string) =>
  db
    .prepare(sql)
    .all()
    .map(r => ({ ...r })) as Record<string, any>[];

db.exec(eventStmts.join(''));
assert.equal(all('SELECT count(*) AS n FROM website_event')[0].n, 200);
assert.equal(
  all(`SELECT page_title FROM website_event WHERE event_id = 'e7'`)[0].page_title,
  events[7].page_title,
);

db.exec(buildStatements('session_replay', replayCols, ['replay_id'], [replay]).join(''));
assert.deepEqual(Buffer.from(all('SELECT events FROM session_replay')[0].events), replay.events);

// Mutable table: injection stored literally; re-applying is a no-op; DELETE-first drops
// rows the source no longer has.
const batch = userSql([user('u1', 'ann'), user('u2', evil)]);
db.exec(batch);
db.exec(batch);
assert.deepEqual(all('SELECT user_id, username FROM "user" ORDER BY user_id'), [
  { user_id: 'u1', username: 'ann' },
  { user_id: 'u2', username: evil },
]);
db.exec(userSql([user('u1', 'ann2')], false)); // pk conflict updates in place
assert.equal(all(`SELECT username FROM "user" WHERE user_id = 'u1'`)[0].username, 'ann2');
// Another row's unique username is an error, not a silent delete as with INSERT OR REPLACE.
assert.throws(() => db.exec(userSql([user('u3', 'ann2')], false)), /UNIQUE/);
db.exec(userSql([user('u1', 'ann')]));
assert.deepEqual(all('SELECT user_id FROM "user"'), [{ user_id: 'u1' }]);

// session_data keeps the latest row per (session_id, data_key): a rewritten row replaces the
// copy with the old id, and an older row never displaces a newer one.
const sdCols = [
  'session_data_id',
  'website_id',
  'session_id',
  'data_key',
  'data_type',
  'created_at',
];
const sd = (id: string, key: string, at: string) => ({
  session_data_id: id,
  website_id: 'w1',
  session_id: 's1',
  data_key: key,
  data_type: 1,
  created_at: `2026-01-0${at}T00:00:00.000Z`,
});
const sdSql = (rows: Record<string, unknown>[]) =>
  buildStatements('session_data', sdCols, D1_TABLES.session_data.pk, rows, {
    latestPer: ['session_id', 'data_key'],
  }).join('');
db.exec(sdSql([sd('old', 'plan', '1'), sd('k2', 'other', '1')]));
db.exec(sdSql([sd('new', 'plan', '2')]));
db.exec(sdSql([sd('older', 'plan', '1')]));
assert.deepEqual(all('SELECT session_data_id FROM session_data ORDER BY 1'), [
  { session_data_id: 'k2' },
  { session_data_id: 'new' },
]);

console.log('d1 import SQL: OK');
