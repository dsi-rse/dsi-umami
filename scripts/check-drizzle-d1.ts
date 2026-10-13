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
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import * as schema from '../src/db/d1/schema';
import d1 from '../src/lib/drizzle-d1';

const { client, transaction } = d1;
const ids = (rows: any[]) => rows.map(r => r.id).sort();

const mf = new Miniflare({
  modules: true,
  compatibilityDate: '2025-12-01',
  script: 'export default { fetch: () => new Response() }',
  d1Databases: ['DB'],
});

try {
  const db = await mf.getD1Database('DB');
  const ddl = readFileSync('prisma/migrations-d1/0001_init.sql', 'utf8')
    .split(/;\s*\n/)
    .map(s => s.replace(/^--.*$/gm, '').trim())
    .filter(Boolean);
  await db.batch(ddl.map(s => db.prepare(s)));
  globalThis['drizzle-d1'] = drizzle(db as any, { schema });

  await transaction([
    client.user.create({ data: { id: 'u1', username: 'ann', password: 'x', role: 'user' } }),
    client.user.create({ data: { id: 'u2', username: 'bob', password: 'x', role: 'user' } }),
    client.team.create({ data: { id: 't1', name: 'one' } }),
    client.team.create({ data: { id: 't2', name: 'two' } }),
    client.teamUser.create({ data: { id: 'tu1', teamId: 't1', userId: 'u1', role: 'team-owner' } }),
    client.teamUser.create({ data: { id: 'tu2', teamId: 't2', userId: 'u2', role: 'team-owner' } }),
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
          parameters: '{}',
        },
      }),
    ),
  ]);

  // To-many relation filter narrows instead of being dropped.
  assert.deepEqual(
    ids(
      await client.team.findMany({
        where: { deletedAt: null, members: { some: { userId: 'u1', role: 'team-owner' } } },
      }),
    ),
    ['t1'],
  );

  // Search shape from getSearchParameters: AND as object, to-one relation, insensitive.
  assert.deepEqual(
    ids(
      await client.report.findMany({
        where: {
          AND: {
            OR: [
              { name: { contains: 'zzz' } },
              { website: { domain: { contains: 'B.ORG', mode: 'insensitive' } } },
            ],
          },
        },
      }),
    ),
    ['r-w2'],
  );

  // Every operator in one filter object applies.
  assert.deepEqual(ids(await client.team.findMany({ where: { id: { gte: 't1', lte: 't1' } } })), [
    't1',
  ]);

  // Unknown keys and unconstrained unique lookups throw.
  await assert.rejects(client.team.findMany({ where: { bogus: { some: {} } } }), /bogus/);
  await assert.rejects(client.user.findUnique({ where: { id: undefined } }), /where/);

  // transaction([...]) rolls back when any statement fails.
  await assert.rejects(
    transaction([
      client.team.create({ data: { id: 't3', name: 'new' } }),
      client.team.create({ data: { id: 't1', name: 'duplicate key' } }),
    ]),
  );
  assert.equal(await client.team.findUnique({ where: { id: 't3' } }), null);

  // Callback form batches writes and returns the returned op's result.
  const team = await transaction(async tx => {
    await tx.teamUser.deleteMany({ where: { teamId: 't2' } });
    return tx.team.update({ where: { id: 't2' }, data: { name: 'renamed' } });
  });
  assert.equal(team.name, 'renamed');
  assert.equal(await client.teamUser.count({ where: { teamId: 't2' } }), 0);
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
