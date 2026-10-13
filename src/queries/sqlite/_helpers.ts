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

// PG `percentile_cont(p) within group (order by x)`: linear interpolation at
// 0-based rank p * (n - 1) over the non-null values, using PG's float math so
// results match. Aggregates rows shaped by percentileRanks().
export function percentileCont(p: number): string {
  const lo = `cast(${p} * (n - 1) as integer)`;
  const at = (rank: string) => `max(case when rn = ${rank} then x end)`;
  const fraction = `(${p} * (max(n) - 1) - cast(${p} * (max(n) - 1) as integer))`;

  return `(${at(lo)} + ${fraction} * (${at(`min(${lo} + 1, n - 1)`)} - ${at(lo)}))`;
}

// Columns percentileCont() reads: x, its 0-based rank (nulls last, so they're
// never picked) and the non-null count, per partition.
export function percentileRanks(column: string, partitionBy?: string): string {
  const partition = partitionBy ? `partition by ${partitionBy}` : '';

  return `${column} as x,
    row_number() over (${partition} order by ${column} nulls last) - 1 as rn,
    count(${column}) over (${partition}) as n`;
}
