import {
  EMAIL_DOMAINS,
  EVENT_TYPE,
  LLM_DOMAINS,
  PAID_AD_PARAMS,
  SEARCH_DOMAINS,
  SHOPPING_DOMAINS,
  SOCIAL_DOMAINS,
  VIDEO_DOMAINS,
} from '@/lib/constants';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import type { ChannelExpandedMetricsData } from '@/queries/sql/getChannelExpandedMetrics';
import { SQLITE_STRIP_WWW_HOSTNAME, toSqliteLikeClause } from '@/queries/sqlite/getChannelMetrics';

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
  const needsBounceEvents = filters.excludeBounce !== true;
  const bounceQuery = needsBounceEvents
    ? `sum(case when visit_stats.c = 1 and coalesce(visit_events.has_custom_event, 0) = 0 then 1 else 0 end) as "bounces",`
    : '0 as "bounces",';
  const visitEventsQuery = needsBounceEvents
    ? `,

      visit_events as (
        select
          session_id,
          visit_id,
          1 as has_custom_event
        from website_event
        where website_id = {{websiteId}}
          and created_at between {{startDate}} and {{endDate}}
          and event_type = ${EVENT_TYPE.customEvent}
        group by session_id, visit_id)`
    : '';
  const visitEventsJoin = needsBounceEvents
    ? `left join visit_events
        on visit_events.session_id = visit_stats.session_id
        and visit_events.visit_id = visit_stats.visit_id`
    : '';

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
            website_event.event_id,
            website_event.created_at
        from website_event
        ${cohortQuery}
        ${excludeBounceQuery}
        ${joinSessionQuery}
        where website_event.website_id = {{websiteId}}
          and website_event.event_type NOT IN (2, 5)
          ${dateQuery}
          ${filterQuery}),

      channels as (
        select case
            when referrer_domain = '' and url_query = '' then 'direct'
            when ${toSqliteLikeClause('url_query', PAID_AD_PARAMS)} then 'paidAds'
            when ${toSqliteLikeClause('utm_medium', ['referral', 'app', 'link'])} then 'referral'
            when utm_medium LIKE '%affiliate%' then 'affiliate'
            when utm_medium LIKE '%sms%' or utm_source LIKE '%sms%' then 'sms'
            when ${toSqliteLikeClause('referrer_domain', LLM_DOMAINS)} then 'llm'
            when ${toSqliteLikeClause('referrer_domain', SEARCH_DOMAINS)} or utm_medium LIKE '%organic%' then concat(prefix, 'Search')
            when ${toSqliteLikeClause('referrer_domain', SOCIAL_DOMAINS)} then concat(prefix, 'Social')
            when ${toSqliteLikeClause('referrer_domain', EMAIL_DOMAINS)} or utm_medium LIKE '%mail%' then 'email'
            when ${toSqliteLikeClause('referrer_domain', SHOPPING_DOMAINS)} or utm_medium LIKE '%shop%' then concat(prefix, 'Shopping')
            when ${toSqliteLikeClause('referrer_domain', VIDEO_DOMAINS)} or utm_medium LIKE '%video%' then concat(prefix, 'Video')
            when referrer_domain != ${SQLITE_STRIP_WWW_HOSTNAME} and referrer_domain != '' then 'referral'
            else '' end as "name",
            session_id,
            visit_id,
            event_id,
            created_at
        from prefix),

      visit_channels as (
        select
          session_id,
          visit_id,
          coalesce(nullif(name, ''), 'direct') as "name"
        from (
          select
            name,
            session_id,
            visit_id,
            row_number() over (
              partition by session_id, visit_id
              order by case when name != '' then 0 else 1 end, created_at, event_id
            ) as row_num
          from channels
        ) as ranked_channels
        where row_num = 1),

      visit_stats as (
        select
          session_id,
          visit_id,
          count(*) as c,
          min(created_at) as min_time,
          max(created_at) as max_time
        from prefix
        group by session_id, visit_id)
      ${visitEventsQuery}

      select
        visit_channels.name,
        sum(visit_stats.c) as "pageviews",
        count(distinct visit_stats.session_id) as "visitors",
        count(distinct visit_stats.visit_id) as "visits",
        ${bounceQuery}
        sum(${getTimestampDiffSQL('visit_stats.min_time', 'visit_stats.max_time')}) as "totaltime"
      from visit_stats
      join visit_channels
        on visit_channels.session_id = visit_stats.session_id
        and visit_channels.visit_id = visit_stats.visit_id
      ${visitEventsJoin}
      group by visit_channels.name
      order by visitors desc, visits desc
      `,
    queryParams,
    FUNCTION_NAME,
  );
}

export default sqliteGetChannelExpandedMetrics;
