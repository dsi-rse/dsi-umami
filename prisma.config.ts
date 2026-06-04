import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// PRISMA_TARGET=d1 switches Prisma CLI to the SQLite schema + migrations.
// Default (unset) keeps the upstream PG behavior unchanged.
const isD1 = process.env.PRISMA_TARGET === 'd1';

export default defineConfig({
  schema: isD1 ? 'prisma/schema.d1.prisma' : 'prisma/schema.prisma',
  migrations: {
    path: isD1 ? 'prisma/migrations-d1' : 'prisma/migrations',
  },
  datasource: {
    // For D1 the URL is unused at runtime (driver adapter takes over), but
    // Prisma CLI still needs *some* SQLite URL to drive `migrate diff`.
    url: isD1 ? 'file:./prisma/.d1-shadow.db' : env('DATABASE_URL'),
  },
});
