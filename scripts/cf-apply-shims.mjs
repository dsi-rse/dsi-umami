#!/usr/bin/env node
/**
 * Applies the Cloudflare-Workers-specific bundle shims under a given root.
 *
 * Why these exist:
 *
 *   1. pg-cloudflare/package.json
 *      Upstream pg uses `require('pg-cloudflare')` to get a Workers-compatible
 *      socket. Its exports map has a `workerd` condition that points at
 *      ./dist/index.js, but esbuild's package-copy step in @opennextjs/cloudflare
 *      drops index.js while keeping only ./dist/empty.js — so the bundle step
 *      fails with "Could not resolve pg-cloudflare". We never actually use pg
 *      at runtime when DATABASE_FLAVOR=d1, so we rewrite the exports map to
 *      always resolve to the empty stub.
 *
 *   2. @prisma/client query_compiler_fast_bg.postgresql.wasm-base64.mjs
 *      Prisma 7 ships separate ~5MB WASM query compilers for each provider.
 *      With DATABASE_FLAVOR=d1 only the sqlite compiler is loaded at runtime,
 *      but the PG one is statically referenced and ends up in the worker
 *      bundle. Replacing the .mjs file with `export default ''` saves ~5MB raw
 *      / ~1.5MB compressed — meaningful against the 10 MiB Workers cap.
 *
 *   3. .open-next/server-functions/default/geo/GeoLite2-City.mmdb
 *      Next.js tracing copies the 63 MB GeoLite database into the bundle even
 *      though src/lib/detect.ts gets geo from request headers on Cloudflare
 *      (`cf-ipcountry`, `cf-ipcity`, `cf-region-code`) and never reaches the
 *      maxmind fallback. Drop the file post-bundle.
 *
 *   4. src/generated/prisma-d1/internal/class.ts + sqlite WASM staging
 *      Prisma 7's generated D1 client loads the SQLite query compiler by
 *      decoding a base64 .mjs at runtime and calling `new WebAssembly.Module()`.
 *      Workers blocks that with "Wasm code generation disallowed by embedder".
 *      We rewrite the generated client to use a static binary WASM import
 *      (`import wasm from "*.wasm"`) which wrangler/esbuild bundles as a
 *      separately-uploaded WebAssembly.Module. The raw .wasm file ships in
 *      `prisma/build/` but the generated client imports from the @prisma/client
 *      runtime dir, so we also copy it into place.
 *
 * Run as:
 *   node scripts/cf-apply-shims.mjs --root=node_modules        # pre-build
 *   node scripts/cf-apply-shims.mjs --gen-client                # post-prisma-generate
 *   node scripts/cf-apply-shims.mjs --root=.next/standalone    # post-next-build
 *   node scripts/cf-apply-shims.mjs --strip-geo                # post-opennext
 *
 * Idempotent. Safe to re-run.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const eq = a.indexOf('=');
    return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), true];
  }),
);

const cwd = process.cwd();
const root = args.root ? path.resolve(cwd, args.root) : cwd;
const stripGeo = !!args['strip-geo'];
const genClient = !!args['gen-client'];

const PG_CLOUDFLARE_STUB =
  '{"name":"pg-cloudflare","version":"1.3.0","main":"dist/empty.js","exports":{".":{"workerd":"./dist/empty.js","default":"./dist/empty.js"},"./package.json":"./package.json"}}';

const PG_WASM_STUB = "export default '';\n";

let patched = 0;

function* walk(dir, depth = 0) {
  if (depth > 12 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.next' && depth === 0 && dir === root) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function stubPgCloudflare(searchRoot) {
  // Match any package.json whose parent directory is named exactly 'pg-cloudflare'.
  for (const file of walk(searchRoot)) {
    if (!file.endsWith('/package.json')) continue;
    if (path.basename(path.dirname(file)) !== 'pg-cloudflare') continue;
    writeFileSync(file, PG_CLOUDFLARE_STUB);
    patched++;
    console.log(`  stub pg-cloudflare: ${path.relative(cwd, file)}`);
  }
}

function stubPgPrismaWasm(searchRoot) {
  const target = 'query_compiler_fast_bg.postgresql.wasm-base64.mjs';
  for (const file of walk(searchRoot)) {
    if (path.basename(file) !== target) continue;
    writeFileSync(file, PG_WASM_STUB);
    patched++;
    console.log(`  stub PG Prisma WASM: ${path.relative(cwd, file)}`);
  }
}

function stripGeoFromBundle() {
  const geoDir = path.resolve(cwd, '.open-next/server-functions/default/geo');
  if (existsSync(geoDir)) {
    rmSync(geoDir, { recursive: true });
    patched++;
    console.log(`  strip geo: ${path.relative(cwd, geoDir)}`);
  }
}

function patchGeneratedD1Client() {
  // 1. Stage the raw .wasm at prisma/d1-sqlite-compiler.wasm so wrangler.jsonc's
  //    wasm_modules binding can find it.
  const wasmSrc = findFirst(
    path.resolve(cwd, 'node_modules'),
    p => p.endsWith('/prisma/build/query_compiler_fast_bg.sqlite.wasm'),
  );
  if (wasmSrc) {
    const wasmDest = path.resolve(cwd, 'prisma/d1-sqlite-compiler.wasm');
    copyFileSync(wasmSrc, wasmDest);
    patched++;
    console.log(`  staged WASM: ${path.relative(cwd, wasmDest)}`);
  } else {
    console.warn('  WARNING: could not find prisma sqlite .wasm');
  }

  // 2. Patch the generated D1 client to read the precompiled WASM module
  //    from wrangler's wasm_modules binding (env.PRISMA_SQLITE_WASM).
  const classFile = path.resolve(cwd, 'src/generated/prisma-d1/internal/class.ts');
  if (!existsSync(classFile)) {
    console.warn(`  skipped: ${classFile} doesn't exist yet (run prisma generate first)`);
    return;
  }
  let src = readFileSync(classFile, 'utf8');
  if (src.includes('cf-apply-shims.mjs')) {
    console.log(`  already patched: ${path.relative(cwd, classFile)}`);
    return;
  }
  const needle =
    /async function decodeBase64AsWasm[\s\S]+?importName: "\.\/query_compiler_fast_bg\.js"\s*\}/m;
  if (!needle.test(src)) {
    console.warn(`  WARNING: generated D1 client doesn't match expected shape; leaving as-is`);
    return;
  }
  src = src.replace(
    needle,
    `// PATCHED for Cloudflare Workers by scripts/cf-apply-shims.mjs:
// Workers blocks \`new WebAssembly.Module()\` everywhere ("Wasm code generation
// disallowed by embedder"). The supported path is wrangler's \`wasm_modules\`
// binding which precompiles the file at deploy time and exposes a
// \`WebAssembly.Module\` via env.PRISMA_SQLITE_WASM. Configured in wrangler.jsonc.
import { getCloudflareContext } from '@opennextjs/cloudflare'

config.compilerWasm = {
  getRuntime: async () => await import("@prisma/client/runtime/query_compiler_fast_bg.sqlite.mjs"),

  getQueryCompilerWasmModule: async () => {
    const { env } = getCloudflareContext()
    return (env as any).PRISMA_SQLITE_WASM as WebAssembly.Module
  },

  importName: "./query_compiler_fast_bg.js"
}`,
  );
  writeFileSync(classFile, src);
  patched++;
  console.log(`  patched generated D1 client: ${path.relative(cwd, classFile)}`);
}

function findFirst(root, pred) {
  for (const file of walk(root)) {
    if (pred(file)) return file;
  }
  return null;
}

function findFirstDir(root, pred, depth = 0) {
  if (depth > 12 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (pred(full)) return full;
      const sub = findFirstDir(full, pred, depth + 1);
      if (sub) return sub;
    }
  }
  return null;
}

if (genClient) {
  console.log('Patching generated D1 Prisma client...');
  patchGeneratedD1Client();
} else if (stripGeo) {
  console.log('Stripping geo from .open-next bundle...');
  stripGeoFromBundle();
} else {
  if (!existsSync(root)) {
    console.error(`error: root ${root} does not exist`);
    process.exit(1);
  }
  console.log(`Applying CF shims under ${path.relative(cwd, root) || '.'}/`);
  stubPgCloudflare(root);
  stubPgPrismaWasm(root);
}

console.log(`Done. ${patched} file(s) patched.`);
