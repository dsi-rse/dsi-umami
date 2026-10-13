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
  d1Databases: ['DB', 'E2E'],
});

async function migrate(db: any) {
  for (const file of readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    const ddl = readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
      .split(/;\s*\n/)
      .map(s => s.replace(/^--.*$/gm, '').trim())
      .filter(Boolean);
    await db.batch(ddl.map(s => db.prepare(s)));
  }
}

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

  // ---- Upstream query functions end to end, on a fresh database ----
  const e2e = await mf.getD1Database('E2E');
  await migrate(e2e);
  globalThis['drizzle-d1'] = drizzle(e2e as any, { schema });
  process.env.DATABASE_FLAVOR = 'd1';
  const q = await import('../src/queries/prisma');

  // u1 owns t1 and website w1; u1 is a member of t2 (owned by u2), which has w3.
  // u2 owns w2 directly. w4 is soft-deleted.
  await transaction([
    client.user.create({ data: { id: 'u1', username: 'ann', password: 'h1', role: 'admin' } }),
    client.user.create({ data: { id: 'u2', username: 'bob', password: 'h2', role: 'user' } }),
    client.team.create({ data: { id: 't1', name: 'one' } }),
    client.team.create({ data: { id: 't2', name: 'two', accessCode: 'secret' } }),
    client.teamUser.create({ data: { id: 'tu1', teamId: 't1', userId: 'u1', role: 'team-owner' } }),
    client.teamUser.create({ data: { id: 'tu2', teamId: 't2', userId: 'u2', role: 'team-owner' } }),
    client.teamUser.create({
      data: { id: 'tu3', teamId: 't2', userId: 'u1', role: 'team-member' },
    }),
    client.website.create({ data: { id: 'w1', name: 'A', domain: 'a.com', userId: 'u1' } }),
    client.website.create({ data: { id: 'w2', name: 'B', domain: 'b.org', userId: 'u2' } }),
    client.website.create({
      data: { id: 'w3', name: 'C', domain: 'c.net', teamId: 't2', createdBy: 'u2' },
    }),
    client.website.create({
      data: { id: 'w4', name: 'D', userId: 'u1', deletedAt: new Date() },
    }),
    client.report.create({
      data: {
        id: 'r1',
        userId: 'u1',
        websiteId: 'w1',
        type: 'funnel',
        name: 'r',
        description: '',
        parameters: { steps: [] },
      },
    }),
  ]);

  const userTeams = await q.getUserTeams('u1');
  assert.deepEqual(ids(userTeams.data), ['t1', 't2']);
  const t2 = userTeams.data.find(t => t.id === 't2');
  assert.deepEqual(t2._count, { websites: 1, members: 2 });
  assert.deepEqual(t2.members.map(m => m.user.username).sort(), ['ann', 'bob']);
  assert.ok(t2.members.every(m => Object.keys(m.user).sort().join() === 'id,username'));

  // Login payload: only the selected columns (no accessCode) of the user's teams.
  const loginTeams = await q.getAllUserTeams('u2');
  assert.deepEqual(loginTeams, [{ id: 't2', name: 'two', logoUrl: null }]);

  assert.deepEqual(ids((await q.getUserWebsites('u1')).data), ['w1']);
  assert.deepEqual((await q.getUserWebsites('u1')).data[0].user, { username: 'ann', id: 'u1' });
  assert.deepEqual(ids((await q.getAllUserWebsitesIncludingTeamOwner('u2')).data), ['w2', 'w3']);
  assert.deepEqual(ids((await q.getAllUserWebsitesIncludingTeamOwner('u1')).data), ['w1']);
  const teamSites = await q.getTeamWebsites('t2', {});
  assert.deepEqual(teamSites.data[0].createUser, { id: 'u2', username: 'bob' });

  const members = await q.getTeamUsers(
    {
      where: { teamId: 't2', user: { deletedAt: null } },
      include: { user: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'asc' },
    },
    { search: 'bo' },
  );
  assert.deepEqual(
    members.data.map(m => m.user),
    [{ id: 'u2', username: 'bob' }],
  );

  const reports = await q.getUserReports('u1');
  assert.deepEqual(reports.data[0].website, { domain: 'a.com', userId: 'u1' });

  // Admin views (include + _count + omit).
  const adminUsers = await q.getUsers(
    {
      include: { _count: { select: { websites: { where: { deletedAt: null } } } } },
      omit: { password: true },
      orderBy: { createdAt: 'desc' },
    },
    {},
  );
  assert.ok(adminUsers.data.every(u => !('password' in u)));
  assert.deepEqual(adminUsers.data.find(u => u.id === 'u1')._count, { websites: 1 });
  const adminSites = await q.getWebsites(
    {
      include: {
        user: { where: { deletedAt: null }, select: { username: true, id: true } },
        team: {
          where: { deletedAt: null },
          include: { members: { where: { role: 'team-owner' } } },
        },
      },
    },
    {},
  );
  const w3 = adminSites.data.find(w => w.id === 'w3');
  assert.equal(w3.user, null);
  assert.deepEqual(
    w3.team.members.map(m => m.userId),
    ['u2'],
  );

  // deleteWebsite purges analytics rows in chunks before the atomic batch.
  const N = 12_000;
  await e2e
    .prepare(
      `with recursive c(x) as (select 1 union all select x + 1 from c where x < ${N})
       insert into website_event (event_id, website_id, session_id, visit_id, url_path, event_type, created_at)
       select 'e' || x, 'w2', 's1', 'v1', '/', 1, '2026-01-01T00:00:00.000Z' from c`,
    )
    .run();
  await client.session.create({ data: { id: 's1', websiteId: 'w2' } });
  await q.deleteWebsite('w2');
  assert.equal(await client.websiteEvent.count({ where: { websiteId: 'w2' } }), 0);
  assert.equal(await client.session.count({ where: { websiteId: 'w2' } }), 0);
  assert.equal(await client.website.findUnique({ where: { id: 'w2' } }), null);

  // deleteUser removes only that user's websites, owned teams and memberships.
  await q.deleteUser('u2');
  assert.deepEqual(ids(await client.user.findMany({})), ['u1']);
  assert.deepEqual(ids(await client.team.findMany({})), ['t1']);
  assert.deepEqual(ids(await client.teamUser.findMany({})), ['tu1']);
  assert.deepEqual(ids(await client.website.findMany({})), ['w1', 'w3', 'w4']);
  assert.deepEqual(ids(await client.report.findMany({})), ['r1']);

  console.log('drizzle-d1 compat: OK');
} finally {
  await mf.dispose();
}
