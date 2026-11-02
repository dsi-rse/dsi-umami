-- CreateTable
CREATE TABLE "user" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "logo_url" TEXT,
    "display_name" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "session" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "browser" TEXT,
    "os" TEXT,
    "device" TEXT,
    "screen" TEXT,
    "language" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "distinct_id" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "website" (
    "website_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "reset_at" DATETIME,
    "user_id" TEXT,
    "team_id" TEXT,
    "created_by" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME,
    "deleted_at" DATETIME,
    "replay_enabled" BOOLEAN NOT NULL DEFAULT false,
    "replay_config" TEXT
);

-- CreateTable
CREATE TABLE "website_event" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "url_path" TEXT NOT NULL,
    "url_query" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "referrer_path" TEXT,
    "referrer_query" TEXT,
    "referrer_domain" TEXT,
    "page_title" TEXT,
    "gclid" TEXT,
    "fbclid" TEXT,
    "msclkid" TEXT,
    "ttclid" TEXT,
    "li_fat_id" TEXT,
    "twclid" TEXT,
    "event_type" INTEGER NOT NULL DEFAULT 1,
    "event_name" TEXT,
    "tag" TEXT,
    "hostname" TEXT,
    "lcp" DECIMAL,
    "inp" DECIMAL,
    "cls" DECIMAL,
    "fcp" DECIMAL,
    "ttfb" DECIMAL
);

-- CreateTable
CREATE TABLE "event_data" (
    "event_data_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "website_event_id" TEXT NOT NULL,
    "data_key" TEXT NOT NULL,
    "string_value" TEXT,
    "number_value" DECIMAL,
    "date_value" DATETIME,
    "data_type" INTEGER NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "session_data" (
    "session_data_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "data_key" TEXT NOT NULL,
    "string_value" TEXT,
    "number_value" DECIMAL,
    "date_value" DATETIME,
    "data_type" INTEGER NOT NULL,
    "distinct_id" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "team" (
    "team_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "access_code" TEXT,
    "logo_url" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "team_user" (
    "team_user_id" TEXT NOT NULL PRIMARY KEY,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateTable
CREATE TABLE "report" (
    "report_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateTable
CREATE TABLE "segment" (
    "segment_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateTable
CREATE TABLE "revenue" (
    "revenue_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "revenue" DECIMAL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "link" (
    "link_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "user_id" TEXT,
    "team_id" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "pixel" (
    "pixel_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "user_id" TEXT,
    "team_id" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "board" (
    "board_id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "user_id" TEXT,
    "team_id" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateTable
CREATE TABLE "share" (
    "share_id" TEXT NOT NULL PRIMARY KEY,
    "entity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "share_type" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateTable
CREATE TABLE "session_replay" (
    "replay_id" TEXT NOT NULL PRIMARY KEY,
    "website_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "events" BLOB NOT NULL,
    "event_count" INTEGER NOT NULL,
    "started_at" DATETIME NOT NULL,
    "ended_at" DATETIME NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "session_replay_saved" (
    "saved_replay_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE INDEX "session_created_at_idx" ON "session"("created_at");

-- CreateIndex
CREATE INDEX "session_website_id_idx" ON "session"("website_id");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_idx" ON "session"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_browser_idx" ON "session"("website_id", "created_at", "browser");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_os_idx" ON "session"("website_id", "created_at", "os");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_device_idx" ON "session"("website_id", "created_at", "device");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_screen_idx" ON "session"("website_id", "created_at", "screen");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_language_idx" ON "session"("website_id", "created_at", "language");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_country_idx" ON "session"("website_id", "created_at", "country");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_region_idx" ON "session"("website_id", "created_at", "region");

-- CreateIndex
CREATE INDEX "session_website_id_created_at_city_idx" ON "session"("website_id", "created_at", "city");

-- CreateIndex
CREATE INDEX "website_user_id_idx" ON "website"("user_id");

-- CreateIndex
CREATE INDEX "website_team_id_idx" ON "website"("team_id");

-- CreateIndex
CREATE INDEX "website_created_at_idx" ON "website"("created_at");

-- CreateIndex
CREATE INDEX "website_created_by_idx" ON "website"("created_by");

-- CreateIndex
CREATE INDEX "website_event_created_at_idx" ON "website_event"("created_at");

-- CreateIndex
CREATE INDEX "website_event_session_id_idx" ON "website_event"("session_id");

-- CreateIndex
CREATE INDEX "website_event_visit_id_idx" ON "website_event"("visit_id");

-- CreateIndex
CREATE INDEX "website_event_website_id_idx" ON "website_event"("website_id");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_idx" ON "website_event"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_url_path_idx" ON "website_event"("website_id", "created_at", "url_path");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_url_query_idx" ON "website_event"("website_id", "created_at", "url_query");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_referrer_domain_idx" ON "website_event"("website_id", "created_at", "referrer_domain");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_page_title_idx" ON "website_event"("website_id", "created_at", "page_title");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_event_name_idx" ON "website_event"("website_id", "created_at", "event_name");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_tag_idx" ON "website_event"("website_id", "created_at", "tag");

-- CreateIndex
CREATE INDEX "website_event_website_id_session_id_created_at_idx" ON "website_event"("website_id", "session_id", "created_at");

-- CreateIndex
CREATE INDEX "website_event_website_id_visit_id_created_at_idx" ON "website_event"("website_id", "visit_id", "created_at");

-- CreateIndex
CREATE INDEX "website_event_website_id_created_at_hostname_idx" ON "website_event"("website_id", "created_at", "hostname");

-- CreateIndex
CREATE INDEX "event_data_created_at_idx" ON "event_data"("created_at");

-- CreateIndex
CREATE INDEX "event_data_website_id_idx" ON "event_data"("website_id");

-- CreateIndex
CREATE INDEX "event_data_website_event_id_idx" ON "event_data"("website_event_id");

-- CreateIndex
CREATE INDEX "event_data_website_id_created_at_idx" ON "event_data"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "event_data_website_id_created_at_data_key_idx" ON "event_data"("website_id", "created_at", "data_key");

-- CreateIndex
CREATE INDEX "session_data_created_at_idx" ON "session_data"("created_at");

-- CreateIndex
CREATE INDEX "session_data_website_id_idx" ON "session_data"("website_id");

-- CreateIndex
CREATE INDEX "session_data_session_id_idx" ON "session_data"("session_id");

-- CreateIndex
CREATE INDEX "session_data_session_id_created_at_idx" ON "session_data"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "session_data_website_id_created_at_data_key_idx" ON "session_data"("website_id", "created_at", "data_key");

-- CreateIndex
CREATE UNIQUE INDEX "team_access_code_key" ON "team"("access_code");

-- CreateIndex
CREATE INDEX "team_access_code_idx" ON "team"("access_code");

-- CreateIndex
CREATE INDEX "team_user_team_id_idx" ON "team_user"("team_id");

-- CreateIndex
CREATE INDEX "team_user_user_id_idx" ON "team_user"("user_id");

-- CreateIndex
CREATE INDEX "report_user_id_idx" ON "report"("user_id");

-- CreateIndex
CREATE INDEX "report_website_id_idx" ON "report"("website_id");

-- CreateIndex
CREATE INDEX "report_type_idx" ON "report"("type");

-- CreateIndex
CREATE INDEX "report_name_idx" ON "report"("name");

-- CreateIndex
CREATE INDEX "segment_website_id_idx" ON "segment"("website_id");

-- CreateIndex
CREATE INDEX "revenue_website_id_idx" ON "revenue"("website_id");

-- CreateIndex
CREATE INDEX "revenue_session_id_idx" ON "revenue"("session_id");

-- CreateIndex
CREATE INDEX "revenue_website_id_created_at_idx" ON "revenue"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "revenue_website_id_session_id_created_at_idx" ON "revenue"("website_id", "session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "link_slug_key" ON "link"("slug");

-- CreateIndex
CREATE INDEX "link_slug_idx" ON "link"("slug");

-- CreateIndex
CREATE INDEX "link_user_id_idx" ON "link"("user_id");

-- CreateIndex
CREATE INDEX "link_team_id_idx" ON "link"("team_id");

-- CreateIndex
CREATE INDEX "link_created_at_idx" ON "link"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pixel_slug_key" ON "pixel"("slug");

-- CreateIndex
CREATE INDEX "pixel_slug_idx" ON "pixel"("slug");

-- CreateIndex
CREATE INDEX "pixel_user_id_idx" ON "pixel"("user_id");

-- CreateIndex
CREATE INDEX "pixel_team_id_idx" ON "pixel"("team_id");

-- CreateIndex
CREATE INDEX "pixel_created_at_idx" ON "pixel"("created_at");

-- CreateIndex
CREATE INDEX "board_user_id_idx" ON "board"("user_id");

-- CreateIndex
CREATE INDEX "board_team_id_idx" ON "board"("team_id");

-- CreateIndex
CREATE INDEX "board_created_at_idx" ON "board"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "share_slug_key" ON "share"("slug");

-- CreateIndex
CREATE INDEX "share_entity_id_idx" ON "share"("entity_id");

-- CreateIndex
CREATE INDEX "session_replay_website_id_idx" ON "session_replay"("website_id");

-- CreateIndex
CREATE INDEX "session_replay_session_id_idx" ON "session_replay"("session_id");

-- CreateIndex
CREATE INDEX "session_replay_visit_id_idx" ON "session_replay"("visit_id");

-- CreateIndex
CREATE INDEX "session_replay_website_id_session_id_idx" ON "session_replay"("website_id", "session_id");

-- CreateIndex
CREATE INDEX "session_replay_website_id_visit_id_idx" ON "session_replay"("website_id", "visit_id");

-- CreateIndex
CREATE INDEX "session_replay_website_id_created_at_idx" ON "session_replay"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "session_replay_session_id_chunk_index_idx" ON "session_replay"("session_id", "chunk_index");

-- CreateIndex
CREATE INDEX "session_replay_saved_website_id_idx" ON "session_replay_saved"("website_id");

-- CreateIndex
CREATE INDEX "session_replay_saved_visit_id_idx" ON "session_replay_saved"("visit_id");

-- CreateIndex
CREATE INDEX "session_replay_saved_website_id_created_at_idx" ON "session_replay_saved"("website_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "session_replay_saved_website_id_visit_id_key" ON "session_replay_saved"("website_id", "visit_id");

