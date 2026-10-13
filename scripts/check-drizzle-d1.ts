/**
 * Regression check for the Prisma-compat layer in src/lib/drizzle-d1.ts,
 * run against a throwaway in-memory D1 (Miniflare). Never touches remote D1.
 *
 * Not a vitest file: Miniflare's proxy breaks under the jsdom environment
 * the shared test setup requires.
 *
 * Run: pnpm check-drizzle-d1
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Miniflare } from 'miniflare';
import * as schema from '../src/db/d1/schema';
import d1 from '../src/lib/drizzle-d1';

const { client, transaction } = d1;
const ids = (rows: any[]) => rows.map(r => r.id).sort();
const MIGRATIONS = 'prisma/migrations-d1';

const mf = new Miniflare({
  modules: true,
  compatibilityDate: '2025-12-01',
  script: 'export default { fetch: () => new Response() }',
  d1Databases: ['DB'],
});

try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    const ddl = readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
      .split(/;\s*\n/)
      .map(s => s.replace(/^--.*$/gm, '').trim())
      .filter(Boolean);
    await db.batch(ddl.map(s => db.prepare(s)));
  }
  globalThis['drizzle-d1'] = drizzle(db as any, { schema });

  // The Drizzle schema and the migrated database agree on tables, columns and
  // indexes (the two are maintained by hand).
  for (const table of Object.values(schema).filter(t => is(t, SQLiteTable)) as any[]) {
    const name = getTableName(table);
    const { results: cols } = await db.prepare(`pragma table_info("${name}")`).all<any>();
    assert.deepEqual(
      cols.map(c => c.name).sort(),
      Object.values(getTableColumns(table))
        .map((c: any) => c.name)
        .sort(),
      `columns of ${name}`,
    );
    const { results: idx } = await db
      .prepare(
        `select name from sqlite_master where type = 'index' and tbl_name = ? and sql is not null`,
      )
      .bind(name)
      .all<any>();
    assert.deepEqual(
      idx.map(i => i.name).sort(),
      getTableConfig(table)
        .indexes.map(i => i.config.name)
        .sort(),
      `indexes of ${name}`,
    );
  }

  await transaction([
    client.user.create({ data: { id: 'u1', username: 'ann', password: 'x', role: 'user' } }),
    client.user.create({ data: { id: 'u2', username: 'bob', password: 'x', role: 'user' } }),
    client.team.create({ data: { id: 't1', name: 'one' } }),
    client.team.create({ data: { id: 't2', name: 'two' } }),
    client.teamUser.create({ data: { id: 'tu1', teamId: 't1', userId: 'u1', role: 'team-owner' } }),
    client.teamUser.create({ data: { id: 'tu2', teamId: 't2', userId: 'u2', role: 'team-owner' } }),
    client.teamUser.create({
      data: { id: 'tu3', teamId: 't2', userId: 'u1', role: 'team-member' },
    }),
    client.website.create({ data: { id: 'w1', name: 'A', domain: 'a.com', userId: 'u1' } }),
    client.website.create({ data: { id: 'w2', name: 'B', domain: 'b.org', userId: 'u2' } }),
    ...['w1', 'w2'].map(w =>
      client.report.create({
        data: {
          id: `r-${w}`,
          userId: 'u1',
          websiteId: w,
          type: 'funnel',
          name: 'r',
          description: '',
          parameters: { steps: [{ type: 'path', value: '/' }] },
        },
      }),
    ),
  ]);

  // To-many relation filter narrows, including the role inside `some`.
  const ownedBy = (userId: string) =>
    client.team.findMany({
      where: { deletedAt: null, members: { some: { userId, role: 'team-owner' } } },
    });
  assert.deepEqual(ids(await ownedBy('u1')), ['t1']);
  assert.deepEqual(
    ids(await client.team.findMany({ where: { members: { some: { userId: 'u1' } } } })),
    ['t1', 't2'],
  );

  // Search shape from getSearchParameters: AND as object, to-one relation, partial match.
  assert.deepEqual(
    ids(
      await client.report.findMany({
        where: {
          AND: {
            OR: [
              { name: { contains: 'zzz' } },
              { website: { domain: { contains: 'B.OR', mode: 'insensitive' } } },
            ],
          },
        },
      }),
    ),
    ['r-w2'],
  );

  // Every operator in one filter object applies (both ends excluded here).
  assert.deepEqual(ids(await client.user.findMany({ where: { id: { gt: 'u0', lt: 'u2' } } })), [
    'u1',
  ]);

  // `null` matches only nulls; Date filters are bound as ISO strings.
  await client.website.update({ where: { id: 'w2' }, data: { deletedAt: new Date() } });
  assert.deepEqual(ids(await client.website.findMany({ where: { deletedAt: null } })), ['w1']);
  assert.deepEqual(
    ids(await client.website.findMany({ where: { deletedAt: { lte: new Date() } } })),
    ['w2'],
  );

  // in / notIn scope to the list (json_each), even past D1's 100-param cap.
  const many = [...Array.from({ length: 150 }, (_, i) => `x${i}`), 'w1'];
  assert.deepEqual(ids(await client.website.findMany({ where: { id: { in: many } } })), ['w1']);
  assert.deepEqual(ids(await client.website.findMany({ where: { id: { notIn: many } } })), ['w2']);
  assert.deepEqual(await client.website.findMany({ where: { id: { in: [] } } }), []);

  // JSON columns round-trip as objects.
  const report = await client.report.findUnique({ where: { id: 'r-w1' } });
  assert.deepEqual(report.parameters, { steps: [{ type: 'path', value: '/' }] });

  // Defaults are ISO, matching what range filters compare against.
  assert.match(report.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  // undefined is "leave alone", as in Prisma: partial updates keep other columns.
  const toggled = await client.website.update({
    where: { id: 'w1' },
    data: { name: undefined, domain: undefined, replayEnabled: true },
  });
  assert.equal(toggled.name, 'A');
  assert.equal(toggled.replayEnabled, true);

  // select / omit project columns, so excluded ones (password) never leave.
  const projected = await client.user.findUnique({
    where: { id: 'u1' },
    select: { id: true, username: true },
  });
  assert.deepEqual(projected, { id: 'u1', username: 'ann' });
  const updated = await client.user.update({
    where: { id: 'u1' },
    data: { displayName: 'Ann' },
    select: { id: true, displayName: true },
  });
  assert.deepEqual(updated, { id: 'u1', displayName: 'Ann' });
  const omitted = await client.user.findMany({ omit: { password: true } });
  assert.ok(omitted.length === 2 && omitted.every(u => !('password' in u)));
  await assert.rejects(client.user.findMany({ select: { teams: true } }), /teams/);

  // distinct keeps the first row per key after ordering (newest share wins).
  await transaction([
    client.share.create({
      data: { id: 's1', entityId: 'w1', shareType: 1, name: 'old', slug: 'old', parameters: {} },
    }),
    client.share.create({
      data: {
        id: 's2',
        entityId: 'w1',
        shareType: 1,
        name: 'new',
        slug: 'new',
        parameters: {},
        createdAt: new Date(Date.now() + 1000),
      },
    }),
  ]);
  const shares = await client.share.findMany({
    where: { entityId: { in: ['w1'] } },
    distinct: ['entityId'],
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual(
    shares.map(s => s.slug),
    ['new'],
  );

  // Compound unique keys.
  await client.sessionReplaySaved.create({
    data: { id: 'rs1', websiteId: 'w1', visitId: 'v1', name: 'saved' },
  });
  const saved = (visitId: string) =>
    client.sessionReplaySaved.findUnique({
      where: { websiteId_visitId: { websiteId: 'w1', visitId } },
      select: { id: true },
    });
  assert.deepEqual(await saved('v1'), { id: 'rs1' });
  assert.equal(await saved('v2'), null);

  // createMany splits rows so no statement passes D1's 100 bound params.
  const event = { websiteId: 'w1', websiteEventId: 'e1', dataType: 1, createdAt: new Date() };
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...event, id: `d${i}`, dataKey: `k${i}` }));
  assert.deepEqual(await client.eventData.createMany({ data: rows }), { count: 30 });
  assert.equal(await client.eventData.count({ where: { websiteEventId: 'e1' } }), 30);

  // Unknown keys/operators and unconstrained unique ops throw.
  await assert.rejects(client.team.findMany({ where: { bogus: { some: {} } } }), /bogus/);
  await assert.rejects(client.team.findMany({ where: { name: { search: 'x' } } }), /search/);
  await assert.rejects(client.user.findUnique({ where: { id: undefined } }), /where/);
  assert.throws(() => client.team.delete({ where: { id: undefined } }), /where/);
  assert.throws(() => client.team.update({ where: { id: undefined }, data: {} }), /where/);
  await assert.rejects(
    client.team.upsert({ where: { id: undefined }, create: {}, update: {} }),
    /where/,
  );

  // updateMany/deleteMany honor where and report real counts.
  assert.deepEqual(await client.team.updateMany({ where: { id: 't1' }, data: { logoUrl: 'x' } }), {
    count: 1,
  });
  assert.deepEqual(await client.team.updateMany({ where: { id: 'nope' }, data: {} }), {
    count: 0,
  });
  assert.equal((await client.team.findUnique({ where: { id: 't2' } })).logoUrl, null);
  assert.deepEqual(await client.eventData.deleteMany({ where: { id: { in: ['nope'] } } }), {
    count: 0,
  });

  // transaction([...]) rolls back when any statement fails.
  await assert.rejects(
    transaction([
      client.team.create({ data: { id: 't3', name: 'new' } }),
      client.team.create({ data: { id: 't1', name: 'duplicate key' } }),
    ]),
  );
  assert.equal(await client.team.findUnique({ where: { id: 't3' } }), null);

  // Callback form batches writes and returns the returned op's result;
  // using an earlier write's result inside the callback throws.
  const team = await transaction(async tx => {
    await tx.teamUser.deleteMany({ where: { teamId: 't2' } });
    return tx.team.update({ where: { id: 't2' }, data: { name: 'renamed' } });
  });
  assert.equal(team.name, 'renamed');
  assert.equal(await client.teamUser.count({ where: { teamId: 't2' } }), 0);
  await assert.rejects(
    transaction(async tx => (await tx.team.update({ where: { id: 't2' }, data: {} })).name),
    /isn't available/,
  );
  assert.deepEqual(await transaction([client.team.deleteMany({ where: { id: 't2' } })]), [
    { count: 1 },
  ]);
  await assert.rejects(
    transaction(async tx => tx.team.findMany({})),
    /findMany/,
  );

  console.log('drizzle-d1 compat: OK');
} finally {
  await mf.dispose();
}
