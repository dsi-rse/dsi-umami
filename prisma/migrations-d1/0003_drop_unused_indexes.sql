-- SQLite can't seek past a range on created_at, so the (website_id, created_at, X)
-- indexes never serve a query; the single-column ones are prefixes of composites
-- or unused without website_id. Measured on 1M events: same query plans, 57%
-- smaller database, ~6 instead of ~16 rows written per event. D1 caps a
-- database at 10 GB, so run this before importing data.
-- Kept: website_event (website_id, created_at), (website_id, session_id,
-- created_at), (website_id, visit_id, created_at), (session_id); session
-- (website_id, created_at).

DROP INDEX IF EXISTS "session_created_at_idx";
DROP INDEX IF EXISTS "session_website_id_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_browser_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_os_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_device_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_screen_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_language_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_country_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_region_idx";
DROP INDEX IF EXISTS "session_website_id_created_at_city_idx";
DROP INDEX IF EXISTS "website_event_created_at_idx";
DROP INDEX IF EXISTS "website_event_visit_id_idx";
DROP INDEX IF EXISTS "website_event_website_id_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_url_path_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_url_query_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_referrer_domain_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_page_title_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_event_name_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_tag_idx";
DROP INDEX IF EXISTS "website_event_website_id_created_at_hostname_idx";
