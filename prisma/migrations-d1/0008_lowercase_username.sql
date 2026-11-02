-- Port of prisma/migrations/24_lowercase_username (logins now look up
-- lower(username), and SQLite's = is case-sensitive). SQLite has no MD5, so the
-- suffix for renamed soft-deleted rows is the last 8 hex digits of user_id
-- instead of md5(user_id): deterministic, and random bits for v4 and v7 UUIDs.
-- SQLite's lower() folds ASCII only (PG's LOWER and JS toLowerCase fold
-- Unicode), so an existing username with a non-ASCII capital keeps it, and that
-- user can't log in until an admin renames them.
-- Idempotent; scripts/migrate-supabase-to-d1.ts re-runs this file after
-- importing users from a database that predates the upstream migration.

-- Rename only soft-deleted rows that block lowercasing a live username.
UPDATE "user" AS d
SET "username" = substr(d."username", 1, 246) || '-' || substr(d."user_id", -8)
WHERE d."deleted_at" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "user" AS a
    WHERE a."deleted_at" IS NULL
      AND a."user_id" <> d."user_id"
      AND a."username" <> lower(a."username")
      AND lower(a."username") = lower(d."username")
  );

-- Lowercase live usernames unless another live row would still collide.
UPDATE "user" AS u
SET "username" = lower(u."username")
WHERE u."deleted_at" IS NULL
  AND u."username" <> lower(u."username")
  AND NOT EXISTS (
    SELECT 1
    FROM "user" AS c
    WHERE c."user_id" <> u."user_id"
      AND lower(c."username") = lower(u."username")
  );
