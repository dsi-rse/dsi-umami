import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasource: {
    // Not env('DATABASE_URL'): it throws when unset, which breaks `prisma generate`
    // on D1 builds that have no Postgres (see D1_FORK.md). Commands that connect
    // still fail loudly against the placeholder.
    url: process.env.DATABASE_URL || 'postgres://placeholder@localhost:5432/placeholder',
  },
});
