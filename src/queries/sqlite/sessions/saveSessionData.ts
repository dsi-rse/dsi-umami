import { DATA_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { flattenJSON, getStoredStringValue } from '@/lib/data';
import { truncateString } from '@/lib/format';
import prisma from '@/lib/prisma';
import type { SaveSessionDataArgs } from '@/queries/sql/sessions/saveSessionData';

// Same upsert as the PG branch. SQLite has no now(): a missing createdAt
// becomes the app's current time (ISO text, like every other created_at).
// The ON CONFLICT target is session_data's (session_id, data_key) unique index.
export async function sqliteSaveSessionData({
  websiteId,
  sessionId,
  sessionData,
  distinctId,
  createdAt,
}: SaveSessionDataArgs) {
  const { writeRawQuery } = prisma;

  const jsonKeys = flattenJSON(sessionData);
  const normalizedDistinctId = truncateString(distinctId, FIELD_LENGTH.distinctId);

  for (const a of jsonKeys) {
    await writeRawQuery(
      `
      insert into session_data (
        session_data_id,
        website_id,
        session_id,
        data_key,
        string_value,
        number_value,
        date_value,
        data_type,
        distinct_id,
        created_at
      )
      values (
        {{id}},
        {{websiteId}},
        {{sessionId}},
        {{dataKey}},
        {{stringValue}},
        {{numberValue}},
        {{dateValue}},
        {{dataType}},
        {{distinctId}},
        {{insertCreatedAt}}
      )
      on conflict (session_id, data_key)
      do update set
        website_id = excluded.website_id,
        string_value = excluded.string_value,
        number_value = excluded.number_value,
        date_value = excluded.date_value,
        data_type = excluded.data_type,
        distinct_id = excluded.distinct_id,
        created_at = coalesce({{createdAt}}, session_data.created_at)
      `,
      {
        id: uuid(),
        websiteId,
        sessionId,
        dataKey: truncateString(a.key, FIELD_LENGTH.dataKey),
        stringValue: getStoredStringValue(a.value, a.dataType),
        numberValue: a.dataType === DATA_TYPE.number ? a.value : null,
        dateValue: a.dataType === DATA_TYPE.date ? new Date(a.value) : null,
        dataType: a.dataType,
        distinctId: normalizedDistinctId,
        createdAt,
        insertCreatedAt: createdAt ?? new Date(),
      },
      'saveSessionData',
    );
  }
}

export default sqliteSaveSessionData;
