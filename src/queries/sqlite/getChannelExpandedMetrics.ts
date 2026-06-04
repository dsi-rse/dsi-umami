import {
  EMAIL_DOMAINS,
  PAID_AD_PARAMS,
  SEARCH_DOMAINS,
  SHOPPING_DOMAINS,
  SOCIAL_DOMAINS,
  VIDEO_DOMAINS,
} from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type { ChannelExpandedMetricsData } from '@/queries/sql/getChannelExpandedMetrics';
import { toSqliteLikeClause } from '@/queries/sqlite/_helpers';

const FUNCTION_NAME = 'getChannelExpandedMetrics';

export async function sqliteGetChannelExpandedMetrics(
  websiteId: string,
  filters: QueryFilters,
): Promise<ChannelExpandedMetricsData[]> {
  const { rawQuery, parseFilters, getTimestampDiffSQL } = prisma;
  const { queryParams, filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, dateQuery } =
    parseFilters({
      ...filters,
      websiteId,
    });

  return rawQuery(
    `
      WITH prefix AS (
        select case when website_event.utm_medium LIKE 'p%' OR
            website_event.utm_medium LIKE '%ppc%' OR
            website_event.utm_medium LIKE '%retargeting%' OR
            website_event.utm_medium LIKE '%paid%' then 'paid' else 'organic' end prefix,
            website_event.referrer_domain,
            website_event.url_query,
            website_event.utm_medium,
            website_event.utm_source,
            website_event.session_id,
            website_event.visit_id,
            website_event.hostname,
            count(*) c,
            min(website_event.created_at) min_time,
            max(website_event.created_at) max_time
        from website_event
        ${cohortQuery}
        ${excludeBounceQuery}
        ${joinSessionQuery}
        where website_event.website_id = {{websiteId}}
          and website_event.event_type NOT IN (2, 5)
          ${dateQuery}
          ${filterQuery}
        group by prefix,
            website_event.referrer_domain,
            website_event.url_query,
            website_event.utm_medium,
            website_event.utm_source,
            website_event.session_id,
            website_event.visit_id,
            website_event.hostname),

      channels as (
        select case
            when referrer_domain = '' and url_query = '' then 'direct'
            when ${toSqliteLikeClause('url_query', PAID_AD_PARAMS)} then 'paidAds'
            when ${toSqliteLikeClause('utm_medium', ['referral', 'app', 'link'])} then 'referral'
            when utm_medium LIKE '%affiliate%' then 'affiliate'
            when utm_medium LIKE '%sms%' or utm_source LIKE '%sms%' then 'sms'
            when ${toSqliteLikeClause('referrer_domain', SEARCH_DOMAINS)} or utm_medium LIKE '%organic%' then concat(prefix, 'Search')
            when ${toSqliteLikeClause('referrer_domain', SOCIAL_DOMAINS)} then concat(prefix, 'Social')
            when ${toSqliteLikeClause('referrer_domain', EMAIL_DOMAINS)} or utm_medium LIKE '%mail%' then 'email'
            when ${toSqliteLikeClause('referrer_domain', SHOPPING_DOMAINS)} or utm_medium LIKE '%shop%' then concat(prefix, 'Shopping')
            when ${toSqliteLikeClause('referrer_domain', VIDEO_DOMAINS)} or utm_medium LIKE '%video%' then concat(prefix, 'Video')
            when referrer_domain != replace(hostname, 'www.', '') and referrer_domain != '' then 'referral'
            else '' end as "name",
            session_id,
            visit_id,
            c,
            min_time,
            max_time
        from prefix)

      select
        name,
        sum(c) as "pageviews",
        count(distinct session_id) as "visitors",
        count(distinct visit_id) as "visits",
        sum(case when c = 1 then 1 else 0 end) as "bounces",
        sum(${getTimestampDiffSQL('min_time', 'max_time')}) as "totaltime"
      from channels
      where name != ''
      group by name
      order by visitors desc, visits desc
      `,
    queryParams,
    FUNCTION_NAME,
  ).then((results: any[]) => results.map(item => ({ ...item, y: Number((item as any).y) })));
}

export default sqliteGetChannelExpandedMetrics;
