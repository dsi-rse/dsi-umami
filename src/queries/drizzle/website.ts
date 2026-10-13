/**
 * Drizzle implementation of the website list query, dispatched from
 * src/queries/prisma/website.ts:getWebsites when DATABASE_FLAVOR=d1.
 *
 * Handles two patterns the Prisma-compat proxy in src/lib/drizzle-d1.ts
 * can't synthesize:
 *
 *   1. `include: { user: { select: { username, id } } }` — leftJoin to user.
 *   2. `include: { createUser: { select: { id, username } } }` — leftJoin to
 *      user via website.createdBy.
 *   3. `where.OR` containing `{ team: { deletedAt, members: { some: { userId,
 *      role } } } }` — emits `inArray(website.teamId, <subquery over team_user>)`.
 *
 * Also handles the search clause that getWebsites injects via
 * `prisma.getSearchParameters(search, [{ name: 'contains' }, { domain: 'contains' }])`
 * → `where.AND.OR = [{ name: { contains, mode } }, { domain: { contains, mode } }]`.
 *
 * Returns the same paged shape as `prisma.pagedQuery`:
 *   { data: WebsiteRow[], count: number, page, pageSize, orderBy, search }
 *
 * Row shape on D1 matches Prisma's include shape so the frontend (WebsitesDataTable)
 * destructures `row.user.username` / `row.createUser.username` unchanged.
 */

import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { team, teamUser, user, website } from '@/db/d1/schema';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import drizzleD1 from '@/lib/drizzle-d1';
import type { QueryFilters } from '@/lib/types';

type Criteria = {
  where?: any;
  include?: { user?: any; createUser?: any };
};

export default async function drizzleGetWebsites(
  criteria: Criteria,
  where: any,
  filters: QueryFilters,
) {
  const db = (drizzleD1 as any).db;

  const conditions: SQL[] = [];

  // Always filter out soft-deleted (getWebsites adds this).
  conditions.push(isNull(website.deletedAt));

  // Simple flat filters.
  if (where.userId !== undefined) {
    conditions.push(eq(website.userId, where.userId));
  }
  if (where.teamId !== undefined) {
    conditions.push(eq(website.teamId, where.teamId));
  }

  // OR clause from getAllUserWebsitesIncludingTeamOwner:
  //   { OR: [ { userId }, { team: { deletedAt: null, members: { some: { userId, role } } } } ] }
  if (Array.isArray(where.OR)) {
    const orClauses: (SQL | undefined)[] = [];
    for (const branch of where.OR) {
      if (branch.userId !== undefined) {
        orClauses.push(eq(website.userId, branch.userId));
      }
      const some = branch.team?.members?.some;
      if (some) {
        // Subquery: team_id IN (SELECT team_id FROM team_user WHERE user_id=? AND role=?)
        // Joined to team to honor `team.deletedAt = null` if present.
        const teamConds: SQL[] = [eq(teamUser.userId, some.userId)];
        if (some.role !== undefined) teamConds.push(eq(teamUser.role, some.role));
        const wantsActiveTeam = branch.team?.deletedAt === null;
        const sub = wantsActiveTeam
          ? db
              .select({ id: teamUser.teamId })
              .from(teamUser)
              .innerJoin(team, and(eq(team.id, teamUser.teamId), isNull(team.deletedAt))!)
              .where(and(...teamConds)!)
          : db
              .select({ id: teamUser.teamId })
              .from(teamUser)
              .where(and(...teamConds)!);
        orClauses.push(inArray(website.teamId, sub));
      }
    }
    const compactOr = orClauses.filter((x): x is SQL => !!x);
    if (compactOr.length) conditions.push(or(...compactOr)!);
  }

  // Search clause that getWebsites injects via getSearchParameters:
  //   { AND: { OR: [ { name: { contains: q, mode: 'insensitive' } }, { domain: { ... } } ] } }
  // We translate to: name LIKE %q% OR domain LIKE %q% (SQLite LIKE is ASCII case-insensitive).
  const searchOr = where.AND?.OR;
  if (Array.isArray(searchOr) && searchOr.length > 0) {
    const searchClauses: SQL[] = [];
    for (const entry of searchOr) {
      for (const [col, op] of Object.entries(entry as Record<string, any>)) {
        const needle = (op as any)?.contains;
        if (typeof needle !== 'string') continue;
        const pattern = `%${needle}%`;
        if (col === 'name') searchClauses.push(like(website.name, pattern));
        else if (col === 'domain') searchClauses.push(like(website.domain, pattern));
      }
    }
    if (searchClauses.length) conditions.push(or(...searchClauses)!);
  }

  // Pagination + ordering.
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = Number(pageSize) || DEFAULT_PAGE_SIZE;
  const offset = size > 0 ? size * (Number(page) - 1) : 0;
  const orderColumn = orderBy && (website as any)[orderBy];
  const orderClause = orderColumn ? (sortDescending ? desc(orderColumn) : asc(orderColumn)) : asc(website.name);

  const whereExpr = conditions.length ? and(...conditions) : undefined;

  // Includes.
  const includeUser = !!criteria.include?.user;
  const includeCreateUser = !!criteria.include?.createUser;

  // Use a single SELECT with optional joins. Aliasing user for createUser since
  // we may need both (Prisma's `user` and `createUser` reference the same table).
  const selection: any = { website };
  if (includeUser) selection.user = { username: user.username, id: user.id };
  // Drizzle requires distinct symbols per join. For createUser we use a subquery
  // alias by joining a second time; if both user and createUser are requested
  // we must alias. In practice the Website page's getUserWebsites uses `user`
  // and getTeamWebsites uses `createUser` — not both at once.
  if (includeCreateUser && !includeUser) {
    selection.createUser = { id: user.id, username: user.username };
  }

  let q: any = db.select(selection).from(website);
  if (includeUser) q = q.leftJoin(user, eq(user.id, website.userId));
  if (includeCreateUser && !includeUser) {
    q = q.leftJoin(user, eq(user.id, website.createdBy));
  }
  if (whereExpr) q = q.where(whereExpr);
  q = q.orderBy(orderClause);
  if (size > 0) q = q.limit(size).offset(offset);

  const rows: any[] = await q;

  // Count: same WHERE, no joins/order/limit.
  let countQ: any = db.select({ n: sql<number>`count(*)` }).from(website);
  if (whereExpr) countQ = countQ.where(whereExpr);
  const countRows: any[] = await countQ;
  const count = Number(countRows[0]?.n ?? 0);

  // Reshape rows to match Prisma's nested-include shape so the frontend
  // doesn't need to know which database backend ran.
  const data = rows.map(r => {
    const out: any = { ...r.website };
    if (includeUser) out.user = r.user ?? null;
    if (includeCreateUser && !includeUser) out.createUser = r.createUser ?? null;
    return out;
  });

  return { data, count, page: Number(page), pageSize: size, orderBy, search };
}
