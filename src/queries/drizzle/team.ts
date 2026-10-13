/**
 * Drizzle implementation of the teams list query, dispatched from
 * src/queries/prisma/team.ts:getTeams when DATABASE_FLAVOR=d1.
 *
 * Handles the patterns the Prisma-compat proxy can't synthesize:
 *
 *   1. `where: { members: { some: { userId } } }` — emits
 *      `team.team_id IN (SELECT team_id FROM team_user WHERE user_id = ?)`.
 *   2. `include: { members: { include: { user: { select: { id, username } } } } }`
 *      — separate batched query joining team_user to user, grouped by team.
 *   3. `include: { _count: { select: { websites: { where: { deletedAt: null } },
 *      members: { where: { user: { deletedAt: null } } } } } }` — two
 *      batched GROUP BY count queries.
 *
 * Also handles the search clause from `prisma.getSearchParameters(search,
 * [{ name: 'contains' }])`.
 *
 * Returns the same paged shape as `prisma.pagedQuery`:
 *   { data: TeamRow[], count: number, page, pageSize, orderBy, search }
 *
 * Row shape matches Prisma's include shape so the frontend gets
 * `team.members[].user.username` and `team._count.websites` / `_count.members`
 * unchanged.
 */

import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { team, teamUser, user, website } from '@/db/d1/schema';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import drizzleD1 from '@/lib/drizzle-d1';
import type { QueryFilters } from '@/lib/types';

type Criteria = {
  where?: any;
  include?: { members?: any; _count?: any };
};

/**
 * Drizzle implementation of `findTeam({ where: { id }, include: { members: true } })`.
 * Returns the team row; if `includeMembers` is true, attaches `members` as a
 * flat array of team_user rows (matching Prisma's shape for `include: { members: true }`).
 */
export async function drizzleGetTeam(teamId: string, includeMembers: boolean) {
  const db = (drizzleD1 as any).db;
  const rows: any[] = await db.select().from(team).where(eq(team.id, teamId)).limit(1);
  if (rows.length === 0) return null;
  const t = rows[0];
  if (!includeMembers) return t;
  const members: any[] = await db.select().from(teamUser).where(eq(teamUser.teamId, teamId));
  return { ...t, members };
}

export default async function drizzleGetTeams(
  criteria: Criteria,
  where: any,
  filters: QueryFilters,
) {
  const db = (drizzleD1 as any).db;

  const conditions: SQL[] = [];

  // Soft-delete filter (added by getUserTeams; harmless otherwise).
  if (where.deletedAt === null) {
    conditions.push(isNull(team.deletedAt));
  }

  // Simple flat conditions.
  if (where.id !== undefined) conditions.push(eq(team.id, where.id));

  // members: { some: { userId } } → subquery on team_user.
  const someMembers = where.members?.some;
  if (someMembers?.userId !== undefined) {
    const sub = db
      .select({ id: teamUser.teamId })
      .from(teamUser)
      .where(eq(teamUser.userId, someMembers.userId));
    conditions.push(inArray(team.id, sub));
  }

  // Search clause that getTeams injects: { AND: { OR: [{ name: { contains, mode } }] } }
  const searchOr = where.AND?.OR;
  if (Array.isArray(searchOr) && searchOr.length > 0) {
    const sc: SQL[] = [];
    for (const entry of searchOr) {
      for (const [col, op] of Object.entries(entry as Record<string, any>)) {
        const needle = (op as any)?.contains;
        if (typeof needle !== 'string') continue;
        if (col === 'name') sc.push(like(team.name, `%${needle}%`));
      }
    }
    if (sc.length) conditions.push(or(...sc)!);
  }

  // Pagination + ordering.
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = Number(pageSize) || DEFAULT_PAGE_SIZE;
  const offset = size > 0 ? size * (Number(page) - 1) : 0;
  const orderColumn = orderBy && (team as any)[orderBy];
  const orderClause = orderColumn
    ? sortDescending
      ? desc(orderColumn)
      : asc(orderColumn)
    : asc(team.name);

  const whereExpr = conditions.length ? and(...conditions) : undefined;

  // Page of teams.
  let q: any = db.select().from(team);
  if (whereExpr) q = q.where(whereExpr);
  q = q.orderBy(orderClause);
  if (size > 0) q = q.limit(size).offset(offset);
  const teams: any[] = await q;

  // Total count under the same WHERE.
  let countQ: any = db.select({ n: sql<number>`count(*)` }).from(team);
  if (whereExpr) countQ = countQ.where(whereExpr);
  const countRows: any[] = await countQ;
  const count = Number(countRows[0]?.n ?? 0);

  if (teams.length === 0) {
    return { data: [], count, page: Number(page), pageSize: size, orderBy, search };
  }

  const teamIds = teams.map(t => t.id);

  // Members include (with nested user select).
  let membersByTeam: Record<string, any[]> = {};
  if (criteria.include?.members) {
    const memberRows: any[] = await db
      .select({
        teamUser: teamUser,
        user: { id: user.id, username: user.username },
      })
      .from(teamUser)
      .leftJoin(user, eq(user.id, teamUser.userId))
      .where(inArray(teamUser.teamId, teamIds));
    membersByTeam = {};
    for (const row of memberRows) {
      const tid = row.teamUser.teamId;
      (membersByTeam[tid] ||= []).push({
        ...row.teamUser,
        user: row.user?.id ? { id: row.user.id, username: row.user.username } : null,
      });
    }
  }

  // _count aggregations.
  let countsByTeam: Record<string, { websites: number; members: number }> = {};
  if (criteria.include?._count) {
    const wantsWebsites = !!criteria.include._count.select?.websites;
    const wantsMembers = !!criteria.include._count.select?.members;
    countsByTeam = Object.fromEntries(teamIds.map(id => [id, { websites: 0, members: 0 }]));

    if (wantsWebsites) {
      const wsRows: any[] = await db
        .select({ teamId: website.teamId, n: sql<number>`count(*)` })
        .from(website)
        .where(and(inArray(website.teamId, teamIds), isNull(website.deletedAt))!)
        .groupBy(website.teamId);
      for (const r of wsRows) {
        if (r.teamId && countsByTeam[r.teamId]) countsByTeam[r.teamId].websites = Number(r.n);
      }
    }

    if (wantsMembers) {
      const mbRows: any[] = await db
        .select({ teamId: teamUser.teamId, n: sql<number>`count(*)` })
        .from(teamUser)
        .leftJoin(user, eq(user.id, teamUser.userId))
        .where(and(inArray(teamUser.teamId, teamIds), isNull(user.deletedAt))!)
        .groupBy(teamUser.teamId);
      for (const r of mbRows) {
        if (r.teamId && countsByTeam[r.teamId]) countsByTeam[r.teamId].members = Number(r.n);
      }
    }
  }

  const data = teams.map(t => {
    const out: any = { ...t };
    if (criteria.include?.members) out.members = membersByTeam[t.id] ?? [];
    if (criteria.include?._count) out._count = countsByTeam[t.id] ?? { websites: 0, members: 0 };
    return out;
  });

  return { data, count, page: Number(page), pageSize: size, orderBy, search };
}
