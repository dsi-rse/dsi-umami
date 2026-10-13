# D1 / Cloudflare fork notes

This fork runs umami on Cloudflare Workers (`@opennextjs/cloudflare`) with a D1
(SQLite) database, next to the unchanged upstream Postgres/ClickHouse paths.
The goal is to keep `git merge upstream/master` low-friction: D1 code lives in
new files, and edits to upstream files are kept to a few lines each (listed
below). This file is for rebuilding context after a merge conflict.

## Deploy

```
pnpm install
pnpm cf:build      # checks, shims, next build, OpenNext build, size check
pnpm cf:deploy     # wrangler deploy of .open-next/
```

`pnpm cf:build` runs, in order:

  1. `check-d1-coverage`  — PG-only SQL without a D1 sibling fails the build
  2. `check-drizzle-d1`   — compat layer + upstream queries against in-memory D1
     `check-d1-import`    — import-script SQL generation against node:sqlite
  3. `cf:shims:pre`       — stub pg-cloudflare and the PG Prisma WASM in node_modules
  4. `cf:gen-clients`     — `prisma generate` (PG client; imported but unused on D1)
  5. `build-tracker`, `build-recorder` — `public/script.js`, `public/recorder.js`
  6. `cf:next-build`      — `next build` with `DATABASE_FLAVOR=d1`
  7. `cf:shims:post`      — same stubs in `.next/standalone/`
  8. `cf:build-app`       — `opennextjs-cloudflare build --skipNextBuild`
  9. `cf:shims:bundle`    — empty OpenNext's copy of `.env`, drop stray `.env*`/GeoLite
 10. `cf:shims:restore`   — put node_modules back so the local Postgres path works
 11. `cf:check-size`      — `wrangler deploy --dry-run`; fail above 9.5 MiB gzipped

If a build fails before step 10, run `pnpm cf:shims:restore` (or
`pnpm install --force`) before using the Postgres path locally.

### Required configuration

- `APP_SECRET` — **wrangler secret**, not a var: `wrangler secret put APP_SECRET`.
  It signs login and share tokens and seeds visitor session IDs. Use the
  Vercel deployment's `APP_SECRET`; if it never set one, use its
  `DATABASE_URL` string (umami falls back to hashing that). A different value
  logs everyone out, breaks share links, and counts every returning visitor as
  new at cutover. `secret()` throws if neither is set.
- `DATABASE_FLAVOR=d1` — set in `wrangler.jsonc` vars.
- `CACHE_BACKEND=kv` — optional, off by default (see KV below).
- Local `.env` files are never shipped: step 9 empties the env file OpenNext
  generates from them.

Bindings in `wrangler.jsonc` are local in dev (`pnpm d1:migrate:local`, then
`pnpm cf:preview` or `pnpm cf:dev`). Commands with `--remote` hit production.

## How the D1 path works

`src/lib/prisma.ts` default-exports `src/lib/drizzle-d1.ts` instead of the PG
module when `DATABASE_FLAVOR=d1` (one line; a `satisfies` check fails the build
if a PG helper has no D1 counterpart). `drizzle-d1.ts` has two halves:

**Prisma-compat client.** `client.<model>.<op>(args)` is translated to Drizzle
over `src/db/d1/schema.ts`, so upstream's ~80 `prisma.client.*` call sites run
unchanged. Supported:

- `findUnique/findFirst/findMany/count/create/createMany/update/updateMany/
  delete/deleteMany` (no `upsert`; nothing upstream calls it)
- `where`: equality, null, `in`/`notIn` (one `json_each` parameter however long
  the list), comparisons, `contains/startsWith/endsWith`, `AND/OR/NOT` (array
  or object), compound unique keys (`websiteId_visitId`), and relation filters
  (to-one nested where, to-many `{ some }`) via correlated `EXISTS`
- `include` (nested include, `where`, `orderBy`, scalar `select`/`omit`) and
  `_count: { select }` — one batched query per relation per level
- top-level `select`/`omit`, `orderBy`, `take`, `skip`, `distinct`
- `transaction([...])` and `transaction(async tx => ...)` as one atomic
  `db.batch()`. Writes are lazy like `PrismaPromise`. In the callback form,
  only the write you return resolves to a row; using an earlier write's
  result throws, and reads throw.

Anything it can't translate **throws** (unknown `where` keys, operators,
relations, selects). Silently dropping a filter once returned every team to
every user and made `deleteUser` delete every team.

Relations live in the `RELATIONS` table at the top of `drizzle-d1.ts`; add an
entry when an upstream query filters or includes a new relation.

D1-specific behavior in the compat layer:

- Writes drop `undefined` keys (Prisma semantics), coerce Date → ISO string,
  boolean → 0/1, BigInt → number. JSON columns use Drizzle's json mode.
- `createMany` splits rows so no statement binds more than 100 parameters.
- `deleteMany` on the analytics tables (`website_event`, `event_data`,
  `session_data`, `session`, `revenue`, `session_replay`) first deletes in
  5000-row chunks outside the batch, so deleting a large website fits D1's
  30-second query limit. That part isn't atomic; the final batch is.

**SQL helpers.** `rawQuery`, `parseFilters`, `getDateSQL` and friends emit
SQLite. Queries in `src/queries/sql/**` that use only these helpers run as-is.
Files with PG-only SQL have a sibling in `src/queries/sqlite/**` (same path)
wired with one `[D1]: () => sqliteFoo(...args)` key in their `runQuery` call;
`scripts/check-d1-coverage.js` fails when a PG-only pattern has no sibling.

### Behavior differences on D1

- Date bucketing honors the user's timezone, like PG: SQLite has no IANA
  zones, so `getDateSQL` emits a `CASE` over the zone's UTC-offset changes
  (computed with Intl, cached per zone) from 2015-01-01 to two years ahead.
  Older timestamps use the 2015 offset.
- Regex filters (`re`/`nre`) aren't available; SQLite has no `REGEXP`. The UI
  hides them (`/api/config` → `regexFiltersDisabled`), and the server still
  rejects them in hand-made URLs or saved segments.
- `LIKE` is case-insensitive for ASCII only (PG `ILIKE` folds Unicode), and
  D1 caps a LIKE pattern at 50 bytes.
- Timestamps are ISO text (`…T…Z`). `created_at` defaults come from the app;
  the DDL's `CURRENT_TIMESTAMP` default writes a different format, and
  migration `0002` rewrites rows that used it.
- With `CACHE_BACKEND=kv`, umami's Redis-only behavior turns on: login tokens
  expire after an hour, website/link/pixel lookups are cached for 24 hours
  (edits and deletes take up to a day to apply outside cloud mode), and KV's
  eventual consistency means a logout can take ~60 s to reach every location.
  Off by default to match the Vercel deployment, which runs without Redis.

## Capacity and limits

D1 caps a database at **10 GB**, which can't be raised. With the indexes
trimmed by migration `0003`, a page view costs roughly 0.8 KB including
indexes (about 1.5–1.8 KB before), so 10 GB holds on the order of 12M
events plus sessions. At 1M events/month that's about a year; at 10M/month,
about a month. **Check Supabase's `website_event` count and monthly growth
before cutover**, and plan retention (for example, a scheduled purge of events
older than N months) before the database fills; once full, every write fails.

Other D1 limits the code works around: 100 bound parameters per statement,
5 terms per compound `SELECT`, 30 s per query, and one query at a time per
database (long dashboard queries delay event ingest). Dashboards over long
ranges at high volume will get slow; rollup tables or D1 read replicas are the
next step if that happens.

After a large import, run `wrangler d1 execute umami --remote --command "PRAGMA optimize"`
so SQLite's planner has statistics (it fixes several retention/attribution
plans); repeat it occasionally.

## Why D1 + Drizzle (design record)

- Workers blocks runtime WebAssembly compilation ("Wasm code generation
  disallowed by embedder"). Prisma 7's D1 client, as generated here, compiled
  its SQLite query engine at runtime, so it failed. The attempted workaround
  used `wasm_modules`, which only service-worker-format Workers support.
- Not yet tried: Prisma 7.6 with `runtime = "cloudflare"` on the generator
  emits `import("./query_compiler_fast_bg.wasm?module")`, and the installed
  `@opennextjs/cloudflare` supports `?module` wasm imports. Reports on
  prisma/prisma#28657 are mixed for adapter-d1 under OpenNext. If it works,
  the compat layer could be replaced by Prisma's own D1 adapter.
- Not chosen, and worth revisiting if the 10 GB cap or SQLite query speed
  becomes a problem: keep Supabase Postgres and reach it from Workers through
  Hyperdrive with the upstream Prisma PG path. That removes the compat layer,
  the SQLite query siblings, the data migration and the size cap, at the cost
  of running Postgres.

## Files

Fork-only (no merge conflicts):

- `wrangler.jsonc`, `open-next.config.ts`
- `src/lib/drizzle-d1.ts`, `src/lib/kv.ts`, `src/db/d1/schema.ts`
- `src/queries/sqlite/**`
- `prisma/migrations-d1/*.sql` — D1 migrations, applied by
  `wrangler d1 migrations apply`
- `scripts/cf-apply-shims.mjs`, `scripts/check-d1-coverage.js`,
  `scripts/check-drizzle-d1.ts`, `scripts/migrate-supabase-to-d1.ts`,
  `scripts/check-d1-import.ts`
- `src/queries/sqlite/d1-smoke.test.ts`, `src/lib/detect-location.test.ts`

Upstream files touched (re-apply the same idea if a merge conflicts; don't
take upstream's side blindly or the D1 path breaks):

- `src/lib/prisma.ts` — import `drizzle-d1`, `IS_D1`, `pgModule` +
  one-line swapped default export
- `src/lib/db.ts` — `D1` constant; `runQuery` dispatches `[D1]`, falling back
  to `[PRISMA]`
- `src/lib/redis.ts` — use the KV client when `CACHE_BACKEND=kv` and the
  `CACHE` binding exists
- `src/lib/crypto.ts` — `secret()` throws when unset
- `src/lib/detect.ts` — synchronous local-IP check (is-localhost-ip hangs on
  workerd), `request.cf` geo, tolerate a missing GeoLite database
- `src/lib/kafka.ts`, `src/lib/clickhouse.ts` — lazy imports (bundle size)
- `src/queries/sql/**` files with a `[D1]` key — one import + one key each;
  `check-d1-coverage` lists them
- `next.config.ts` — `initOpenNextCloudflareForDev()` when `CF_DEV=1`
- `prisma.config.ts` — tolerate a missing `DATABASE_URL` (D1 builds)
- `package.json` (`cf:*`, `d1:*`, `check-*` scripts; drizzle-orm, OpenNext,
  wrangler, miniflare), `pnpm-workspace.yaml` (`workerd` build script),
  `.gitignore`
- `src/app/api/config/route.ts`, `src/components/hooks/useConfig.ts`,
  `src/components/hooks/useFilters.ts` — `regexFiltersDisabled` hides
  `re`/`nre` on D1

## Shims

See the header of `scripts/cf-apply-shims.mjs`. In short: pg-cloudflare's
`workerd` export and the PG Prisma WASM are stubbed (pg never runs on D1, and
the WASM costs ~1.5 MB gzipped), node_modules is restored afterwards, and the
bundle's copy of `.env` is emptied. Each step fails if its target moved.

## Data migration and cutover

`scripts/migrate-supabase-to-d1.ts` copies Supabase into D1. Set
`SUPABASE_DB_URL`, and optionally `SUPABASE_CA_CERT` (a CA file) to verify TLS;
without it the connection is encrypted but unverified. It reads every table
in one `REPEATABLE READ` snapshot, writes batch files to `.migration/`, then
applies them with `wrangler d1 execute --file`. Statements are packed to
90 KB (D1's limit is 100 KB); a single row bigger than that fails with its
table and id (use `--exclude=session_replay` if replay chunks are too big).
Writes are `INSERT … ON CONFLICT (pk) DO UPDATE`, so re-runs are idempotent;
runs are not resumable.

- Mutable tables (user, team, team_user, website, report, segment, link,
  pixel, board, share, session_replay_saved) start with `DELETE FROM` on every
  run, so deletions in Supabase propagate. `--skip-mutable` leaves them alone.
- Append-only tables (session, website_event, event_data, session_data,
  revenue, session_replay) honor `--since=<ISO>`. Each run prints the
  `--since` to use next (its snapshot time minus an hour of margin).
- `session_data` keeps only the newest row per `(session_id, data_key)`, as
  umami's own `saveSessionData` does.
- A missing core table, or a source column D1 doesn't have, fails the run
  unless allowed with `--allow-drop=table.col,...`.
- Validation compares row counts and `max(created_at)` per table and exits
  non-zero on a mismatch; `--validate-only` runs just that.

Runbook (each step is `pnpm d1:import:remote <flags>`, which targets remote D1):

1. `pnpm d1:migrate:prod` (applies `0001`–`0003`) and set `APP_SECRET`.
2. Days ahead: a full run (no flags), then
   `wrangler d1 execute umami --remote --command "PRAGMA optimize"`.
3. Smoke-test the Worker on `workers.dev` against the imported data. Lower the
   DNS TTL a day before the flip.
4. Just before the flip: `--since=<printed by step 2>`. Any run without
   `--skip-mutable` must finish **before** the flip, because it replaces the
   mutable tables with Supabase's copy.
5. Flip DNS. After the old TTL has expired:
   `--since=<printed by step 4> --skip-mutable`.
6. Once Supabase gets no more writes: the same flags plus `--validate-only`.

Known gaps: `--since` runs don't carry over deletions from the append-only
tables (website reset/delete, replay delete); events sent with a tracker
`timestamp` older than `--since` minus an hour are missed.

Rollback: point the CNAME back at Vercel. Events recorded on D1 after the
flip exist only in D1; copying them back to Supabase is a manual export
(`wrangler d1 export`, then insert rows with `created_at` after the flip with
`ON CONFLICT DO NOTHING`). Keep the Vercel deployment and Supabase running
until you're past the point you'd roll back.

## After merging upstream

- `pnpm check-d1-coverage`, `pnpm check-drizzle-d1`, `pnpm check-d1-import`,
  `pnpm test` (includes `src/queries/sqlite/d1-smoke.test.ts`, which runs every
  `src/queries/sql/**` query on an in-memory SQLite with D1's limits and fails
  if a new upstream query isn't in its list)
- New upstream Prisma migrations: port each by hand to a new
  `prisma/migrations-d1/NNNN_*.sql` and mirror it in `src/db/d1/schema.ts`;
  `check-drizzle-d1` fails if the two disagree.
- New relation filters/includes in upstream queries: add them to `RELATIONS`.
- `pnpm cf:build` must pass, including the size check.
- Smoke test on `workers.dev`: log in, open a dashboard, a report and a share
  link.
