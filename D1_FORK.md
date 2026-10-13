# D1 / Cloudflare fork notes

This fork runs on Cloudflare Workers (`@opennextjs/cloudflare`) + D1 (SQLite) +
Workers KV, in parallel with the upstream Postgres/ClickHouse paths. Goal:
keep `git merge upstream/master` low-friction. Everything below is so you
(or future you) can rebuild context after a merge conflict.

## Deploy pipeline at a glance

```
pnpm install                     # installs deps; shims wiped here
pnpm cf:build                    # see breakdown below
wrangler deploy                  # or: pnpm cf:deploy
```

`pnpm cf:build` runs `npm-run-all` over:

  1. `cf:shims:pre`     — patches `node_modules` (pg-cloudflare, PG Prisma WASM)
  2. `cf:gen-clients`   — `prisma generate` for both PG and D1 schemas
  3. `build-tracker`    — rollup tracker → `public/script.js`
  4. `build-recorder`   — rollup recorder → `public/recorder.js`
  5. `cf:next-build`    — `next build` with `DATABASE_FLAVOR=d1`, skips upstream's `check-env`/`check-db`
  6. `cf:shims:post`    — re-applies shims to `.next/standalone/` (next build copies fresh deps)
  7. `cf:build-app`     — `opennextjs-cloudflare build --skipNextBuild`
  8. `cf:shims:bundle`  — strips the 63 MB GeoLite mmdb from `.open-next/`

If you reorder or skip any step the deploy will likely fail with either
"Could not resolve pg-cloudflare" (shims missing) or the Workers 10 MiB cap
(geo + PG WASM not stripped).

## Phase 7: Why Drizzle and not Prisma (important)

Cloudflare Workers blocks runtime `new WebAssembly.Module()` calls everywhere
("Wasm code generation disallowed by embedder"). Prisma 7's generated D1
client decodes a base64-encoded 4.6 MB SQLite query-compiler WASM at request
time, which fails on Workers. The supported path (binary `import wasm from
"*.wasm"` precompiled by wrangler) requires the import to be in the worker
entry, but Prisma's WASM call is buried inside the OpenNext-bundled
`handler.mjs` where neither Next.js nor OpenNext exposes a way to hoist it.

Drizzle is hand-rolled JS with no WASM dependency on D1 — it works on Workers
out of the box. We replaced the Prisma D1 path with Drizzle while keeping
the Prisma PG path untouched (Vercel/Supabase still works as-is).

The replaced files:
  - `src/db/d1/schema.ts` — Drizzle TypeScript schema (17 tables, mirrors
    `prisma/schema.d1.prisma` which mirrors upstream `prisma/schema.prisma`)
  - `src/lib/drizzle-d1.ts` — drop-in for `src/lib/prisma-d1.ts`. Same
    default-export shape (`{ client, rawQuery, parseFilters, ... }`) so
    `src/lib/prisma.ts`'s dispatch and all `src/queries/sqlite/*.ts` call
    sites continue to work via the same helper API.
  - `src/lib/prisma.ts` — one line changed: `import d1Module from './drizzle-d1'`

`src/lib/prisma-d1.ts` and `prisma/schema.d1.prisma` are retained as
reference but not loaded at runtime when `DATABASE_FLAVOR=d1`.

### Phase 8: Prisma-compat proxy on top of Drizzle

`src/lib/drizzle-d1.ts` exposes `client` as a Proxy that translates Prisma's
`client.{model}.{method}(args)` API into Drizzle ops. This means the ~50
upstream `prisma.client.X` call sites work without per-file edits.

Covered methods: `findUnique`, `findFirst`, `findMany`, `create`,
`createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `count`,
`upsert`.

Covered `where` operators: equality, `null`/not-null, `in`/`notIn`,
`gt`/`gte`/`lt`/`lte`, `contains`/`startsWith`/`endsWith`, `AND`/`OR`/`NOT`.

Covered query options: `orderBy` (single or array, asc/desc), `take`, `skip`.

**Not covered — throws clearly at the callsite:** `include` (relation
loading). Drizzle requires explicit joins; emulating Prisma's include shape
generally would be a much larger compat layer. Affected callsites today
(found via `grep -rn "include\s*:" src/queries/prisma/`):

  - `src/queries/prisma/report.ts` — `report.findMany({ include: { website
    : { select: { domain: true } } } })`
  - `src/queries/prisma/team.ts` — `team.findMany({ include: { members: { include
    : { user: { select: ... } } } } })`
  - ~~`src/queries/prisma/website.ts` — `website.findMany({ include: { user: {
    select: { username: true } } } })` and `include: { createUser: ... }`~~
    **Fixed in Phase 6b** — `getWebsites` dispatches to
    `src/queries/drizzle/website.ts:drizzleGetWebsites` when
    `DATABASE_FLAVOR=d1`. Two-line touch in upstream (`runQuery({ [PRISMA], [D1] })`
    around the existing `pagedQuery` call). New Drizzle sibling handles the
    `include: { user }` / `include: { createUser }` leftJoins, plus the nested
    `team.members.some` subquery used by
    `getAllUserWebsitesIncludingTeamOwner`, and reshapes rows to match
    Prisma's include shape so frontend destructuring is unchanged. This is
    the recommended pattern for the remaining include callsites — replicate
    in `src/queries/drizzle/report.ts`, `src/queries/drizzle/team.ts` etc.

For each, the recommended fix is a per-call Drizzle rewrite that does an
explicit join (`db.select({...}).from(report).leftJoin(website, ...)`) or
two queries + an in-memory merge. Add under `src/queries/drizzle/` mirroring
`src/queries/prisma/` and dispatch via the same `[D1]` key pattern used by
`src/queries/sql/` ↔ `src/queries/sqlite/`.

Smoke-tested live (2026-06-04):
  - `POST /api/auth/login` → 401 incorrect-username-password ✓
  - `POST /api/send` (synthetic event) → 400 "Website not found" ✓
  - `GET /api/share/<slug>` → 404 ✓
  - `GET /api/heartbeat` → 200 ✓
  - `GET /` (login page SSR) → 200 ✓

## Cloudflare-specific files (additive — no upstream conflicts)

  - `wrangler.jsonc` — bindings: `DB` (D1), `CACHE` (KV), `ASSETS`
  - `open-next.config.ts` — minimal `defineCloudflareConfig({})`
  - `prisma/schema.d1.prisma` — SQLite-flavored mirror of `schema.prisma`
  - `prisma/migrations-d1/` — D1 migrations (start from a fresh `0001_init`,
    do **not** auto-translate upstream PG migrations)
  - `src/lib/prisma-d1.ts` — D1 client + SQLite-flavored SQL helpers
  - `src/lib/kv.ts` — Workers KV-backed redis shim
  - `src/queries/sqlite/` — SQLite siblings of the PG-specific raw SQL files,
    plus `_helpers.ts` (`toSqliteLikeClause`, `toSqliteGroupedReferrer`)
  - `src/generated/prisma-d1/` — Prisma client output for D1 (gitignored)
  - `scripts/cf-apply-shims.mjs` — the patches documented under Shims below
  - `scripts/check-d1-coverage.js` — fails if a `src/queries/sql/*.ts` file
    contains PG-specific patterns but has no D1 sibling
  - `scripts/migrate-supabase-to-d1.ts` — one-time data import (cursor pages
    Supabase, batches `INSERT OR REPLACE`, validates via row counts)

## Upstream files touched (the ones merges will conflict on)

Each is a localized, minimal-diff change. When upstream changes the
surrounding code on merge, re-apply the same idea — don't accept upstream as-is
or you'll re-break the D1 path.

  - `prisma.config.ts` — switches schema/migrations based on `PRISMA_TARGET=d1`;
    tolerant of missing `DATABASE_URL` (Cloudflare build hosts may not have it)
  - `next.config.ts` — calls `initOpenNextCloudflareForDev()` when `CF_DEV=1`
  - `package.json` — adds `cf:*` and `d1:*` scripts
  - `pnpm-workspace.yaml` — allows `workerd`, `esbuild` build scripts
  - `.gitignore` — ignores `.open-next/`, `.wrangler/`, `.migration/`, etc.
  - `src/lib/db.ts` — adds `D1` constant; `runQuery` dispatches `[D1]` and falls
    back to `[PRISMA]` for queries that work as-is on both
  - `src/lib/prisma.ts` — conditionally re-exports `prisma-d1` when
    `DATABASE_FLAVOR=d1` (~5-line additive diff at the imports and default export)
  - `src/lib/redis.ts` — early-returns to the KV shim when `CACHE` binding is
    present and `REDIS_URL` is unset
  - `src/lib/{kafka,clickhouse,detect}.ts` — top-level imports of `kafkajs`,
    `@clickhouse/client`, `maxmind` converted to lazy `await import()` inside
    the env-gated init paths. **Required** to fit under the Workers 10 MiB cap.
  - 12 files under `src/queries/sql/` — each adds an import of the
    `src/queries/sqlite/` sibling and one `[D1]: () => sqliteFoo(...args)` key
    on the existing `runQuery({...})` call (~2-line diff per file)

The 12 query files are tracked by `scripts/check-d1-coverage.js`. If upstream
adds a new `src/queries/sql/*.ts` with PG-specific SQL (`extract(epoch)`,
`date_trunc`, `ilike`, `~*`, `regexp_replace`, `ANY(arr[])`, etc.), the
coverage check will flag it and require a sibling.

## Shims (lossy patches `cf-apply-shims.mjs` reapplies on every build)

These are not changes to source — they patch `node_modules` and intermediate
build output. `pnpm install`, `prisma generate`, and `next build` all wipe
them, which is why `cf:build` re-runs the shim script at three points.

  1. **`pg-cloudflare/package.json`** → exports map rewritten so the `workerd`
     condition resolves to `./dist/empty.js` instead of `./dist/index.js`.
     Without this, `opennextjs-cloudflare build` fails with
     `Could not resolve "pg-cloudflare"`. pg itself is never invoked at
     runtime when `DATABASE_FLAVOR=d1`, so the empty stub is safe.

  2. **`@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs`**
     → replaced with `export default '';`. Prisma 7 statically references both
     the PG and SQLite WASM compilers; only the SQLite one is loaded at runtime
     when D1 is active. Saves ~4.7 MB raw / ~1.5 MB compressed in the worker
     bundle.

  3. **`.open-next/server-functions/default/geo/GeoLite2-City.mmdb`** → deleted
     post-bundle. Next.js tracing copies the 63 MB GeoLite database in even
     though `src/lib/detect.ts` reads geo from Cloudflare headers
     (`cf-ipcountry`, `cf-ipcity`) on Workers and never reaches the maxmind
     fallback.

If you switch back to a Node deployment with Postgres + maxmind, run `pnpm
install --force` to restore the original `pg-cloudflare`/Prisma WASM files.

## Data migration

One-time Supabase → D1 cutover via `scripts/migrate-supabase-to-d1.ts`:

```
SUPABASE_DB_URL=postgres://...
pnpm d1:import:dry-run                    # validate plan against local D1
pnpm d1:import:local                      # populate local D1 from Supabase
pnpm d1:import:remote                     # populate remote D1
```

The script cursor-paginates per table in FK order, transforms PG types
(`uuid`/`timestamptz`/`jsonb`/`numeric`/`bytea`), emits batched
`INSERT OR REPLACE` SQL into `.migration/`, and applies each batch via
`wrangler d1 execute`. Re-runnable — partial runs resume without unique
conflicts. Validates by comparing per-table row counts at the end.

Expected workflow: run an initial import to populate ahead of cutover, then
re-run on cutover day for the delta, then flip DNS.

## Verification checklist after a merge

  - `pnpm check-d1-coverage` passes (no new PG patterns without D1 siblings)
  - `pnpm cf:build` completes through all 8 steps
  - `wrangler deploy` reports a worker under 10 MiB compressed
  - `/api/heartbeat` returns 200
  - A login + one report query succeeds in the browser
