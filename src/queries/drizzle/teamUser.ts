/**
 * Drizzle implementation of the team-users list query, dispatched from
 * src/queries/prisma/teamUser.ts:getTeamUsers when DATABASE_FLAVOR=d1.
 *
 * Handles the patterns the Prisma-compat proxy can't synthesize:
 *
 *   1. `where: { user: { deletedAt: null } }` — relational where, emitted as
 *      an inner join on `user` with `user.deleted_at IS NULL`.
 *   2. `include: { user: { select: { id, username } } }` — attaches the joined
 *      user row under the `user` key on each result, matching Prisma's shape.
 *
 * Also handles the search clause from
 * `prisma.getSearchParameters(search, [{ user: { username: 'contains' } }])`,
 * which arrives as `{ AND: { OR: [{ user: { username: { contains, mode } } }] } }`.
 *
 * Returns the same paged shape as `prisma.pagedQuery`:
 *   { data: TeamUserRow[], count: number, page, pageSize, orderBy, search }
 */

import { and, asc, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { teamUser, user } from '@/db/d1/schema';
import { DEFAULT_PAGE_SIZE } from '@/lib/constants';
import drizzleD1 from '@/lib/drizzle-d1';
import type { QueryFilters } from '@/lib/types';

type Criteria = {
  where?: any;
  include?: { user?: any };
  orderBy?: any;
};

export default async function drizzleGetTeamUsers(
  criteria: Criteria,
  where: any,
  filters: QueryFilters,
) {
  const db = (drizzleD1 as any).db;

  const conditions: SQL[] = [];

  if (where.teamId !== undefined) conditions.push(eq(teamUser.teamId, where.teamId));
  if (where.userId !== undefined) conditions.push(eq(teamUser.userId, where.userId));
  if (where.role !== undefined) conditions.push(eq(teamUser.role, where.role));

  // Relational where on user (e.g. { user: { deletedAt: null } }).
  const userWhere = where.user;
  if (userWhere && typeof userWhere === 'object') {
    if (userWhere.deletedAt === null) conditions.push(isNull(user.deletedAt));
    if (typeof userWhere.id === 'string') conditions.push(eq(user.id, userWhere.id));
    if (typeof userWhere.username === 'string') conditions.push(eq(user.username, userWhere.username));
  }

  // Search clause: { AND: { OR: [{ user: { username: { contains, mode } } }] } }
  const searchOr = where.AND?.OR;
  if (Array.isArray(searchOr) && searchOr.length > 0) {
    const sc: SQL[] = [];
    for (const entry of searchOr) {
      const userClause = (entry as any)?.user;
      const needle = userClause?.username?.contains;
      if (typeof needle === 'string') sc.push(like(user.username, `%${needle}%`));
    }
    if (sc.length) conditions.push(or(...sc)!);
  }

  // Pagination + ordering.
  const { page = 1, pageSize, orderBy, sortDescending = false, search } = filters || {};
  const size = Number(pageSize) || DEFAULT_PAGE_SIZE;
  const offset = size > 0 ? size * (Number(page) - 1) : 0;

  // Resolve order column: prefer filters.orderBy, fall back to criteria.orderBy
  // (the route passes { createdAt: 'asc' }).
  let orderClause: any = asc(teamUser.createdAt);
  if (orderBy && (teamUser as any)[orderBy]) {
    orderClause = sortDescending ? desc((teamUser as any)[orderBy]) : asc((teamUser as any)[orderBy]);
  } else if (criteria.orderBy && typeof criteria.orderBy === 'object') {
    const [obKey, obDir] = Object.entries(criteria.orderBy)[0] ?? [];
    const col = obKey && (teamUser as any)[obKey];
    if (col) orderClause = obDir === 'desc' ? desc(col) : asc(col);
  }

  const whereExpr = conditions.length ? and(...conditions) : undefined;

  // Page of team_user rows joined to user. We always join because the route
  // both filters on `user.deletedAt` and includes the user payload.
  let q: any = db
    .select({
      teamUser: teamUser,
      user: { id: user.id, username: user.username },
    })
    .from(teamUser)
    .innerJoin(user, eq(user.id, teamUser.userId));
  if (whereExpr) q = q.where(whereExpr);
  q = q.orderBy(orderClause);
  if (size > 0) q = q.limit(size).offset(offset);
  const rows: any[] = await q;

  // Total count under the same WHERE + join.
  let countQ: any = db
    .select({ n: sql<number>`count(*)` })
    .from(teamUser)
    .innerJoin(user, eq(user.id, teamUser.userId));
  if (whereExpr) countQ = countQ.where(whereExpr);
  const countRows: any[] = await countQ;
  const count = Number(countRows[0]?.n ?? 0);

  const includeUser = !!criteria.include?.user;
  const data = rows.map(r => {
    const out: any = { ...r.teamUser };
    if (includeUser) out.user = r.user;
    return out;
  });

  return { data, count, page: Number(page), pageSize: size, orderBy, search };
}
