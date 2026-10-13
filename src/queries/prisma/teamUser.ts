import { Prisma } from '@/generated/prisma/client';
import { uuid } from '@/lib/crypto';
import { D1, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import drizzleGetTeamUsers from '@/queries/drizzle/teamUser';

import TeamUserFindManyArgs = Prisma.TeamUserFindManyArgs;

export async function findTeamUser(criteria: Prisma.TeamUserFindUniqueArgs) {
  return prisma.client.teamUser.findUnique(criteria);
}

export async function getTeamUser(teamId: string, userId: string) {
  return prisma.client.teamUser.findFirst({
    where: {
      teamId,
      userId,
    },
  });
}

export async function getTeamUsers(criteria: TeamUserFindManyArgs, filters?: QueryFilters) {
  const { search } = filters;

  const where: Prisma.TeamUserWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ user: { username: 'contains' } }]),
  };

  return runQuery({
    [PRISMA]: () =>
      prisma.pagedQuery(
        'teamUser',
        {
          ...criteria,
          where,
        },
        filters,
      ),
    [D1]: () => drizzleGetTeamUsers(criteria, where, filters),
  });
}

export async function createTeamUser(userId: string, teamId: string, role: string) {
  return prisma.client.teamUser.create({
    data: {
      id: uuid(),
      userId,
      teamId,
      role,
    },
  });
}

export async function updateTeamUser(teamUserId: string, data: Prisma.TeamUserUpdateInput) {
  return prisma.client.teamUser.update({
    where: {
      id: teamUserId,
    },
    data,
  });
}

export async function deleteTeamUser(teamId: string, userId: string) {
  return prisma.client.teamUser.deleteMany({
    where: {
      teamId,
      userId,
    },
  });
}
