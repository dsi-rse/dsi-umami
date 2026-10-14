-- Port of prisma/migrations/23_update_session_data: keep the newest row per
-- (session_id, data_key), then make the pair unique (saveSessionData upserts on it).
DELETE FROM "session_data"
WHERE "session_data_id" IN (
    SELECT "session_data_id" FROM (
        SELECT
            "session_data_id",
            ROW_NUMBER() OVER (
                PARTITION BY "session_id", "data_key"
                ORDER BY "created_at" DESC NULLS LAST, "session_data_id" DESC
            ) AS row_num
        FROM "session_data"
    )
    WHERE row_num > 1
);

CREATE UNIQUE INDEX "session_data_session_id_data_key_key" ON "session_data"("session_id", "data_key");

-- The (session_id) index is now a prefix of the unique index (and already was
-- of (session_id, created_at)), so it only costs space.
DROP INDEX IF EXISTS "session_data_session_id_idx";
