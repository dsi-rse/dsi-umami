-- Port of prisma/migrations/21_add_session_link.
-- The primary key serves getLinkedSessionIds (website_id, distinct_id); the
-- index serves getLinkedDistinctIds and session deletes (website_id, session_id).
-- A rowid table, not WITHOUT ROWID, so deleteMany's rowid chunking works on it.
CREATE TABLE "session_link" (
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "distinct_id" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY ("website_id", "distinct_id", "session_id")
);

CREATE INDEX "session_link_website_id_session_id_idx" ON "session_link"("website_id", "session_id");
