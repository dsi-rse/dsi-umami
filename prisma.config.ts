import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// PRISMA_TARGET=d1 switches Prisma CLI to the SQLite schema + migrations.
// Default (unset) keeps the upstream PG behavior unchanged.
const isD1 = process.env.PRISMA_TARGET === 'd1';

// Resolve DATABASE_URL lazily without `env()` so `prisma generate` (which
// doesn't need a real connection) doesn't crash when DATABASE_URL is unset
// on the Cloudflare build host. Commands that *do* need to connect (e.g.
// `prisma migrate deploy` against Postgres) will still fail loudly because
// the placeholder URL won't accept connections.
const resolvedUrl = isD1
  ? 'file:./prisma/.d1-shadow.db'
  : process.env.DATABASE_URL || 'postgres://placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: isD1 ? 'prisma/schema.d1.prisma' : 'prisma/schema.prisma',
  migrations: {
    path: isD1 ? 'prisma/migrations-d1' : 'prisma/migrations',
  },
  datasource: {
    url: resolvedUrl,
  },
});
