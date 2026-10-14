-- Port of prisma/migrations/20_add_heatmap.
-- PG merges with `jsonb || '{"replayEnabled": true}'`; json_set does the same on
-- an object, and a NULL (or non-object) config starts from '{}'.
ALTER TABLE "website" RENAME COLUMN "replay_enabled" TO "recorder_enabled";

UPDATE "website"
SET "replay_config" = json_set(
    CASE WHEN json_type("replay_config") = 'object' THEN "replay_config" ELSE '{}' END,
    '$.replayEnabled', json('true'))
WHERE "recorder_enabled" = 1;

-- created_at defaults to ISO text (the format range filters compare against),
-- not CURRENT_TIMESTAMP's 'YYYY-MM-DD HH:MM:SS'; the app sets it anyway.
CREATE TABLE "heatmap_event" (
    "heatmap_event_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "url_path" TEXT NOT NULL,
    "event_type" INTEGER NOT NULL,
    "x" INTEGER,
    "y" INTEGER,
    "page_x" INTEGER,
    "page_y" INTEGER,
    "page_w" INTEGER,
    "viewport_w" INTEGER,
    "viewport_h" INTEGER,
    "page_h" INTEGER,
    "scroll_pct" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- getHeatmap filters website_id + event_type + a created_at range (page list),
-- and adds url_path for one page's points/scroll depth; the second index covers
-- that with created_at as the trailing range. Not ported (as in 0003): the
-- (website_id) index, a prefix of both, and (visit_id), which no query filters
-- on by itself (visit_id only joins inside a website's date range). Heatmap
-- rows are click/scroll events, so each index costs about as much as one on
-- website_event.
CREATE INDEX "heatmap_event_website_id_created_at_idx" ON "heatmap_event"("website_id", "created_at");
CREATE INDEX "heatmap_event_website_id_url_path_event_type_created_at_idx" ON "heatmap_event"("website_id", "url_path", "event_type", "created_at");
