-- Port of prisma/migrations/25_add_annotation. Upstream's extra unique index on
-- annotation_id duplicates the primary key's, so it isn't ported.
CREATE TABLE "annotation" (
    "annotation_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "user_id" TEXT,
    "date" DATETIME NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" DATETIME
);

CREATE INDEX "annotation_website_id_date_idx" ON "annotation"("website_id", "date");
