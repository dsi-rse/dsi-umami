#!/usr/bin/env node
/**
 * Build-time patches for the Cloudflare Workers bundle (see `cf:build` in
 * package.json). Every mode fails the build when its target is missing, so an
 * upstream or dependency bump that moves a file can't silently undo a patch.
 *
 *   --root=<dir>     Stub two packages under <dir> (node_modules before
 *                    `next build`, .next/standalone after it):
 *     1. pg-cloudflare/package.json: its `workerd` export points at a file
 *        OpenNext's package copy drops, so bundling fails with "Could not
 *        resolve pg-cloudflare". pg never runs with DATABASE_FLAVOR=d1, so
 *        point every condition at the empty stub.
 *     2. @prisma/client's PostgreSQL query-compiler WASM (base64 .mjs). The PG
 *        client is imported statically but never used on D1; stubbing it
 *        saves ~1.5 MB gzipped against the 10 MiB Workers limit.
 *     Originals are kept as <file>.cf-orig so --restore can put them back.
 *
 *   --restore=<dir>  Undo --root under <dir>. cf:build runs this on
 *                    node_modules at the end, so the local Postgres path keeps
 *                    working. If a build fails midway, run
 *                    `pnpm cf:shims:restore` (or `pnpm install --force`).
 *
 *   --strip-bundle   After `opennextjs-cloudflare build`:
 *     - empty .open-next/cloudflare/next-env.mjs. OpenNext copies the local
 *       .env* files into it and loads them into process.env at runtime, which
 *       would ship local credentials (e.g. Supabase) inside the Worker. Runtime
 *       config comes only from wrangler vars and secrets.
 *     - delete .env* files Next copied into the server function directory.
 *     - delete the GeoLite database if Next's file tracing copied it (63 MB).
 *
 *   --check-size     `wrangler deploy --dry-run` and fail above MAX_GZIP_KIB.
 *
 * Idempotent. Safe to re-run.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const eq = a.indexOf('=');
    return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true];
  }),
);

const cwd = process.cwd();
const ORIG = '.cf-orig';
// Workers paid plan limit is 10 MiB gzipped; leave headroom for growth.
const MAX_GZIP_KIB = 9.5 * 1024;

const PG_CLOUDFLARE_STUB =
  '{"name":"pg-cloudflare","main":"dist/empty.js","exports":{".":{"workerd":"./dist/empty.js","default":"./dist/empty.js"},"./package.json":"./package.json"}}';
const PG_WASM_STUB = "export default '';\n";

const TARGETS = [
  {
    name: 'pg-cloudflare',
    match: file =>
      path.basename(file) === 'package.json' &&
      path.basename(path.dirname(file)) === 'pg-cloudflare',
    stub: PG_CLOUDFLARE_STUB,
  },
  {
    name: 'PG Prisma WASM',
    match: file => path.basename(file) === 'query_compiler_fast_bg.postgresql.wasm-base64.mjs',
    stub: PG_WASM_STUB,
  },
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function* walk(dir, depth = 0) {
  if (depth > 12 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

// Replace rather than write in place: on Linux pnpm hard-links packages from
// its global store, and an in-place write would patch every project using it.
function replaceFile(file, content) {
  rmSync(file);
  writeFileSync(file, content);
}

function applyStubs(root) {
  if (!existsSync(root)) fail(`${root} does not exist`);
  const files = [...walk(root)];
  for (const target of TARGETS) {
    const matches = files.filter(target.match);
    if (matches.length === 0) fail(`no ${target.name} found under ${root}; update the shim`);
    for (const file of matches) {
      if (!existsSync(file + ORIG)) {
        // Stubbed by an older version of this script, with no original kept.
        if (readFileSync(file, 'utf8') === target.stub) {
          fail(`${file} is already stubbed with no backup; run \`pnpm install --force\` first`);
        }
        copyFileSync(file, file + ORIG);
      }
      replaceFile(file, target.stub);
      console.log(`  stub ${target.name}: ${path.relative(cwd, file)}`);
    }
  }
}

function restore(root) {
  let restored = 0;
  for (const file of walk(root)) {
    if (!file.endsWith(ORIG)) continue;
    const original = file.slice(0, -ORIG.length);
    if (existsSync(original)) rmSync(original);
    copyFileSync(file, original);
    rmSync(file);
    restored++;
  }
  console.log(`  restored ${restored} file(s) under ${path.relative(cwd, root)}`);
}

function stripBundle() {
  const envFile = path.resolve(cwd, '.open-next/cloudflare/next-env.mjs');
  if (!existsSync(envFile)) fail(`${envFile} not found; OpenNext's layout changed`);
  writeFileSync(
    envFile,
    ['production', 'development', 'test'].map(m => `export const ${m} = {};\n`).join(''),
  );
  console.log(`  emptied ${path.relative(cwd, envFile)}`);

  const serverDir = path.resolve(cwd, '.open-next/server-functions/default');
  if (!existsSync(serverDir)) fail(`${serverDir} not found; OpenNext's layout changed`);
  for (const name of readdirSync(serverDir)) {
    if (name.startsWith('.env')) {
      rmSync(path.join(serverDir, name));
      console.log(`  removed ${path.join('.open-next/server-functions/default', name)}`);
    }
  }

  const geoDir = path.join(serverDir, 'geo');
  if (existsSync(geoDir)) {
    rmSync(geoDir, { recursive: true });
    console.log(`  removed ${path.relative(cwd, geoDir)}`);
  }
}

function checkSize() {
  const output = execFileSync(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--outdir', '.wrangler/dry-run'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const match = output.match(/gzip:\s*([\d.]+)\s*KiB/);
  if (!match) fail(`couldn't read the gzip size from wrangler:\n${output}`);
  const kib = Number(match[1]);
  console.log(`  worker size: ${kib.toFixed(0)} KiB gzipped (limit ${MAX_GZIP_KIB} KiB)`);
  if (kib > MAX_GZIP_KIB) fail('worker bundle is too close to the 10 MiB Workers limit');
}

if (args.root) applyStubs(path.resolve(cwd, args.root));
else if (args.restore) restore(path.resolve(cwd, args.restore));
else if (args['strip-bundle']) stripBundle();
else if (args['check-size']) checkSize();
else fail('pass --root=<dir>, --restore=<dir>, --strip-bundle or --check-size');
