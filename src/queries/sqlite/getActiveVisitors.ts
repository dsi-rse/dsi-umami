import { subMinutes } from 'date-fns';
import prisma from '@/lib/prisma';
import type { ActiveVisitors } from '@/lib/types';

const FUNCTION_NAME = 'getActiveVisitors';

// SQLite otherwise picks the covering (website_id, session_id, created_at)
// index and filters created_at across the site's whole history (seconds at a
// few million rows, polled every minute per open dashboard). INDEXED BY
// keeps it a range seek over the last five minutes.
export async function sqliteGetActiveVisitors(websiteId: string): Promise<ActiveVisitors | null> {
  const { rawQuery } = prisma;
  const startDate = subMinutes(new Date(), 5);

  const result = await rawQuery(
    `
    select count(distinct session_id) as "visitors"
    from website_event indexed by website_event_website_id_created_at_idx
    where website_id = {{websiteId}}
    and created_at >= {{startDate}}
    `,
    { websiteId, startDate },
    FUNCTION_NAME,
  );

  return result?.[0] ?? null;
}

export default sqliteGetActiveVisitors;
