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
import type { RevenuParameters } from '@/queries/sql/revenue/getRevenueChart';
import type {
  RevenueMetricsResult,
  RevenueMetricType,
} from '@/queries/sql/revenue/getRevenueMetrics';
import { toSqliteLikeClause } from '@/queries/sqlite/_helpers';

// PG regexp_replace(hostname, '^www.', ''): strip "www" plus any one character,
// only at the start.
const STRIP_WWW_HOSTNAME =
  "(case when substr(hostname, 1, 3) = 'www' and length(hostname) > 3 then substr(hostname, 5) else hostname end)";

// Same queries as the PG branch; ilike -> LIKE (ASCII case-insensitive),
// regexp_replace -> STRIP_WWW_HOSTNAME, concat -> ||.
export async function sqliteGetRevenueMetrics(
  websiteId: string,
  parameters: RevenuParameters,
  filters: QueryFilters,
  type: RevenueMetricType,
): Promise<RevenueMetricsResult[RevenueMetricType]> {
  const { startDate, endDate, currency } = parameters;
  const { rawQuery, parseFilters } = prisma;
  const { queryParams, filterQuery, cohortQuery, joinSessionQuery, dateQuery } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
    currency,
  });
  const filteredSessionsQuery = `
    filtered_sessions as (
      select distinct website_event.website_id, website_event.session_id
      from website_event
      ${cohortQuery}
      ${joinSessionQuery}
      where website_event.website_id = {{websiteId}}
        and website_event.event_type != ${EVENT_TYPE.performance}
      ${dateQuery}
      ${filterQuery}
    )
  `;
  const filteredRevenueQuery = `
    filtered_revenue as (
      select revenue.website_id, revenue.session_id, revenue.created_at, revenue.revenue
      from revenue
      join filtered_sessions
        on filtered_sessions.website_id = revenue.website_id
       and filtered_sessions.session_id = revenue.session_id
      where revenue.website_id = {{websiteId}}
        and revenue.created_at between {{startDate}} and {{endDate}}
        and upper(revenue.currency) = {{currency}}
    )
  `;

  if (type === 'country') {
    return rawQuery(
      `
      with
      ${filteredSessionsQuery},
      ${filteredRevenueQuery}
      select
        session.country as "name",
        sum(filtered_revenue.revenue) as "value"
      from filtered_revenue
      join session
        on session.website_id = filtered_revenue.website_id
          and session.session_id = filtered_revenue.session_id
      group by session.country
      order by value desc
      `,
      queryParams,
    );
  }

  if (type === 'region') {
    return rawQuery(
      `
      with
      ${filteredSessionsQuery},
      ${filteredRevenueQuery}
      select
        session.country,
        session.region as "name",
        sum(filtered_revenue.revenue) as "value"
      from filtered_revenue
      join session
        on session.website_id = filtered_revenue.website_id
          and session.session_id = filtered_revenue.session_id
      group by session.country, session.region
      order by value desc
      `,
      queryParams,
    );
  }

  const revenueDataQuery = `
    events as (
      select
        revenue.website_id,
        revenue.session_id,
        sum(revenue.revenue) as "value"
      from revenue
      join filtered_sessions
        on filtered_sessions.website_id = revenue.website_id
       and filtered_sessions.session_id = revenue.session_id
      where revenue.website_id = {{websiteId}}
        and revenue.created_at between {{startDate}} and {{endDate}}
        and upper(revenue.currency) = {{currency}}
      group by revenue.website_id, revenue.session_id),

    revenue_data as (
      select
        e.website_id,
        e.session_id,
        e.value,
        we.min_date as created_at
      from events e
      join (
        select session_id, min(created_at) as min_date
        from website_event
        where website_id = {{websiteId}}
          and created_at between {{startDate}} and {{endDate}}
        group by session_id
      ) we on we.session_id = e.session_id)
  `;

  if (type === 'referrer') {
    return rawQuery(
      `
      with
      ${filteredSessionsQuery},
      ${revenueDataQuery}
      select
        we.referrer_domain as "name",
        sum(revenue_data.value) as "value"
      from revenue_data
      join (
        select website_id, session_id, referrer_domain, created_at
        from website_event
        where website_id = {{websiteId}}
          and created_at between {{startDate}} and {{endDate}}) we
      on we.website_id = revenue_data.website_id
        and we.session_id = revenue_data.session_id
        and we.created_at = revenue_data.created_at
      group by we.referrer_domain
      order by value desc
      `,
      queryParams,
    );
  }

  return rawQuery(
    `
    with
    ${filteredSessionsQuery},
    ${revenueDataQuery},

    revenue_prefix as (
      select
        case when we.utm_medium LIKE '%cp%' OR
              we.utm_medium LIKE '%ppc%' OR
              we.utm_medium LIKE '%retargeting%' OR
              we.utm_medium LIKE '%paid%' then 'paid' else 'organic' end AS prefix,
        coalesce(we.referrer_domain, '') as referrer_domain,
        coalesce(we.url_query, '') as url_query,
        we.utm_medium,
        we.utm_source,
        we.hostname,
        r.value
      from revenue_data r
      join (
        select website_id, session_id, referrer_domain, url_query, utm_medium, utm_source, hostname, created_at
        from website_event
        where website_id = {{websiteId}}
          and created_at between {{startDate}} and {{endDate}}) we
      on we.website_id = r.website_id
        and we.session_id = r.session_id
        and we.created_at = r.created_at),

    channels AS (
      select
        case
          when referrer_domain = '' and url_query = '' then 'direct'
          when ${toSqliteLikeClause('url_query', PAID_AD_PARAMS)} then 'paidAds'
          when ${toSqliteLikeClause('utm_medium', ['referral', 'app', 'link'])} then 'referral'
          when utm_medium LIKE '%affiliate%' then 'affiliate'
          when utm_medium LIKE '%sms%' or utm_source LIKE '%sms%' then 'sms'
          when ${toSqliteLikeClause('referrer_domain', LLM_DOMAINS)} then 'llm'
          when ${toSqliteLikeClause('referrer_domain', SEARCH_DOMAINS)} or utm_medium LIKE '%organic%' then prefix || 'Search'
          when ${toSqliteLikeClause('referrer_domain', SOCIAL_DOMAINS)} then prefix || 'Social'
          when ${toSqliteLikeClause('referrer_domain', EMAIL_DOMAINS)} or utm_medium LIKE '%mail%' then 'email'
          when ${toSqliteLikeClause('referrer_domain', SHOPPING_DOMAINS)} or utm_medium LIKE '%shop%' then prefix || 'Shopping'
          when ${toSqliteLikeClause('referrer_domain', VIDEO_DOMAINS)} or utm_medium LIKE '%video%' then prefix || 'Video'
          when referrer_domain != ${STRIP_WWW_HOSTNAME} and referrer_domain != '' then 'referral'
          else 'Unknown' end AS "name",
        value
      from revenue_prefix)

    select name, sum(value) as value
    from channels
    group by name
    order by value desc
    `,
    queryParams,
  );
}

export default sqliteGetRevenueMetrics;
