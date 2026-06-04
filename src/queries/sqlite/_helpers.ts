// Shared SQLite query-building helpers used by multiple sqlite query files.
// SQLite's LIKE is ASCII case-insensitive by default, which covers the same
// matching that PG's ilike does for the domain/UTM/keyword strings used in
// channel attribution.

export function toSqliteLikeClause(column: string, arr: string[]): string {
  return arr.map(val => `${column} LIKE '%${val.replace(/'/g, "''")}%'`).join(' OR\n  ');
}

export function toSqliteGroupedReferrer(
  domains: any[],
  column: string = 'referrer_domain',
): string {
  return [
    'CASE',
    ...domains.map(group => {
      const matches = Array.isArray(group.match) ? group.match : [group.match];

      return `WHEN ${toSqliteLikeClause(column, matches)} THEN '${group.domain}'`;
    }),
    "  ELSE 'Other'",
    'END',
  ].join('\n');
}
