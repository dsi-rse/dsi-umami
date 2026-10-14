-- Port of prisma/migrations/26_add_api_key. Upstream also adds a real foreign
-- key to "user" with ON DELETE CASCADE; it isn't ported, for the reason in 0006.
CREATE TABLE "api_key" (
    "api_key_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "last_used_at" DATETIME,
    "created_at" DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

CREATE INDEX "api_key_user_id_idx" ON "api_key"("user_id");
