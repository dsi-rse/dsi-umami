-- created_at defaults now come from the app as ISO 8601 ('…T…Z'), the format
-- range filters compare against. Rewrite rows written by the DDL's
-- CURRENT_TIMESTAMP default ('YYYY-MM-DD HH:MM:SS') so text comparison and
-- ordering stay correct.

UPDATE "user" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "session" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "website" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "website_event" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "event_data" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "session_data" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "team" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "team_user" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "report" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "segment" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "revenue" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "link" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "pixel" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "board" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "share" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "session_replay" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
UPDATE "session_replay_saved" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") WHERE "created_at" NOT LIKE '%Z';
