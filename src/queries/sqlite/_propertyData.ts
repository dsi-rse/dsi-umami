// SQLite fragments shared by the event_data / session_data siblings.

// PG: `cross join lateral jsonb_array_elements_text(coalesce(col, '[]')::jsonb)
// as array_item(value)`. Use as `cross join ${jsonArrayItems(col)}`, then
// select ${ARRAY_ITEM_TEXT}. PG's ::jsonb cast fails the whole query on a
// value that isn't a JSON array; here such a row just yields no items (the
// nested CASE keeps json_type() off invalid JSON, and json_each(null) is empty).
export function jsonArrayItems(column: string, alias = 'array_item'): string {
  return `json_each(case when json_valid(${column}) then case when json_type(${column}) = 'array' then ${column} end end) as ${alias}`;
}

// Each element as text, like jsonb_array_elements_text: strings unquoted, JSON
// null as SQL null, everything else as its JSON text (numbers keep the text
// they were sent with; objects lose PG's jsonb spacing).
export function arrayItemText(column: string, alias = 'array_item'): string {
  return `case ${alias}.type when 'text' then ${alias}.value when 'null' then null else ${column} -> ${alias}.fullkey end`;
}

// PG: cast(number_value as varchar) on a numeric(19, 4) column, e.g. '10.0000'.
export function numberText(column: string): string {
  return `case when ${column} is not null then printf('%.4f', ${column}) end`;
}

// array_agg(...) becomes json_group_array(...), returned as JSON text; parse
// it so the rows carry string[] like PG's.
export function parseJsonArrays<T extends Record<string, any>>(rows: T[], keys: string[]): T[] {
  return (rows ?? []).map(row => {
    const parsed: Record<string, any> = { ...row };

    for (const key of keys) {
      parsed[key] = typeof row[key] === 'string' ? JSON.parse(row[key]) : (row[key] ?? []);
    }

    return parsed as T;
  });
}
