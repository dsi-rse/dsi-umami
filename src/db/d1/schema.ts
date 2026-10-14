/**
 * Drizzle schema for the D1 (SQLite) database. Mirrors prisma/schema.prisma —
 * keep them in lockstep on upstream merges. The on-disk schema is the SQL in
 * prisma/migrations-d1/*.sql; `pnpm check-drizzle-d1` fails if the two drift.
 *
 * Type choices:
 *   - UUIDs stored as TEXT (matching prisma's @db.Uuid → SQLite TEXT)
 *   - Timestamps stored as TEXT ISO 8601 ('YYYY-MM-DDTHH:MM:SS.sssZ'), the
 *     format range filters compare against, and read back as Date like
 *     Prisma's DateTime (upstream calls .getTime() and compares with
 *     `new Date()`). createdAt defaults are generated here, not by the DDL's
 *     CURRENT_TIMESTAMP (which writes a different format)
 *   - Prisma @updatedAt is $onUpdateFn on the new tables (set on every
 *     update), where the column is NOT NULL or upstream relies on it
 *   - Prisma cuid() ids (two_factor_*) are random UUIDs; any unique text works
 *   - JSON columns stored as TEXT with Drizzle's json mode (prisma Json)
 *   - Decimal stored as REAL or TEXT depending on caller — use real() here.
 *   - Bytes stored as BLOB
 */
import {
  blob,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = () => new Date();
const cuid = () => crypto.randomUUID();

// Writes reach here already ISO (the compat layer converts Dates before
// binding); the space-separated form is SQLite's CURRENT_TIMESTAMP, in UTC.
const timestamp = customType<{ data: Date; driverData: string }>({
  dataType: () => 'text',
  toDriver: v => (v instanceof Date ? v.toISOString() : v),
  fromDriver: v => new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`),
});

export const user = sqliteTable(
  'user',
  {
    id: text('user_id').primaryKey(),
    username: text('username').notNull(),
    password: text('password').notNull(),
    role: text('role').notNull(),
    logoUrl: text('logo_url'),
    displayName: text('display_name'),
    twoFactorRequired: integer('two_factor_required', { mode: 'boolean' }).default(false).notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
    deletedAt: timestamp('deleted_at'),
  },
  t => [uniqueIndex('user_username_key').on(t.username)],
);

export const apiKey = sqliteTable(
  'api_key',
  {
    id: text('api_key_id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    uniqueIndex('api_key_key_hash_key').on(t.keyHash),
    index('api_key_user_id_idx').on(t.userId),
  ],
);

export const team = sqliteTable(
  'team',
  {
    id: text('team_id').primaryKey(),
    name: text('name').notNull(),
    accessCode: text('access_code'),
    logoUrl: text('logo_url'),
    twoFactorRequired: integer('two_factor_required', { mode: 'boolean' }).default(false).notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
    deletedAt: timestamp('deleted_at'),
  },
  t => [
    uniqueIndex('team_access_code_key').on(t.accessCode),
    index('team_access_code_idx').on(t.accessCode),
  ],
);

export const teamUser = sqliteTable(
  'team_user',
  {
    id: text('team_user_id').primaryKey(),
    teamId: text('team_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [index('team_user_team_id_idx').on(t.teamId), index('team_user_user_id_idx').on(t.userId)],
);

export const website = sqliteTable(
  'website',
  {
    id: text('website_id').primaryKey(),
    name: text('name').notNull(),
    domain: text('domain'),
    resetAt: timestamp('reset_at'),
    userId: text('user_id'),
    teamId: text('team_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
    deletedAt: timestamp('deleted_at'),
    recorderEnabled: integer('recorder_enabled', { mode: 'boolean' }).default(false).notNull(),
    replayConfig: text('replay_config', { mode: 'json' }),
  },
  t => [
    index('website_user_id_idx').on(t.userId),
    index('website_team_id_idx').on(t.teamId),
    index('website_created_at_idx').on(t.createdAt),
    index('website_created_by_idx').on(t.createdBy),
  ],
);

export const session = sqliteTable(
  'session',
  {
    id: text('session_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    browser: text('browser'),
    os: text('os'),
    device: text('device'),
    screen: text('screen'),
    language: text('language'),
    country: text('country'),
    region: text('region'),
    city: text('city'),
    distinctId: text('distinct_id'),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [index('session_website_id_created_at_idx').on(t.websiteId, t.createdAt)],
);

export const sessionLink = sqliteTable(
  'session_link',
  {
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    distinctId: text('distinct_id').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    primaryKey({ columns: [t.websiteId, t.distinctId, t.sessionId] }),
    index('session_link_website_id_session_id_idx').on(t.websiteId, t.sessionId),
  ],
);

export const websiteEvent = sqliteTable(
  'website_event',
  {
    id: text('event_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    visitId: text('visit_id').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    urlPath: text('url_path').notNull(),
    urlQuery: text('url_query'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    referrerPath: text('referrer_path'),
    referrerQuery: text('referrer_query'),
    referrerDomain: text('referrer_domain'),
    pageTitle: text('page_title'),
    gclid: text('gclid'),
    fbclid: text('fbclid'),
    msclkid: text('msclkid'),
    ttclid: text('ttclid'),
    lifatid: text('li_fat_id'),
    twclid: text('twclid'),
    eventType: integer('event_type').default(1).notNull(),
    eventName: text('event_name'),
    tag: text('tag'),
    hostname: text('hostname'),
    lcp: real('lcp'),
    inp: real('inp'),
    cls: real('cls'),
    fcp: real('fcp'),
    ttfb: real('ttfb'),
  },
  t => [
    index('website_event_session_id_idx').on(t.sessionId),
    index('website_event_website_id_created_at_idx').on(t.websiteId, t.createdAt),
    index('website_event_website_id_session_id_created_at_idx').on(
      t.websiteId,
      t.sessionId,
      t.createdAt,
    ),
    index('website_event_website_id_visit_id_created_at_idx').on(
      t.websiteId,
      t.visitId,
      t.createdAt,
    ),
  ],
);

export const eventData = sqliteTable(
  'event_data',
  {
    id: text('event_data_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    websiteEventId: text('website_event_id').notNull(),
    dataKey: text('data_key').notNull(),
    stringValue: text('string_value'),
    numberValue: real('number_value'),
    dateValue: timestamp('date_value'),
    dataType: integer('data_type').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    index('event_data_created_at_idx').on(t.createdAt),
    index('event_data_website_id_idx').on(t.websiteId),
    index('event_data_website_event_id_idx').on(t.websiteEventId),
    index('event_data_website_id_created_at_idx').on(t.websiteId, t.createdAt),
    index('event_data_website_id_created_at_data_key_idx').on(t.websiteId, t.createdAt, t.dataKey),
  ],
);

export const sessionData = sqliteTable(
  'session_data',
  {
    id: text('session_data_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    dataKey: text('data_key').notNull(),
    stringValue: text('string_value'),
    numberValue: real('number_value'),
    dateValue: timestamp('date_value'),
    dataType: integer('data_type').notNull(),
    distinctId: text('distinct_id'),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    index('session_data_created_at_idx').on(t.createdAt),
    index('session_data_website_id_idx').on(t.websiteId),
    index('session_data_session_id_created_at_idx').on(t.sessionId, t.createdAt),
    index('session_data_website_id_created_at_data_key_idx').on(
      t.websiteId,
      t.createdAt,
      t.dataKey,
    ),
    uniqueIndex('session_data_session_id_data_key_key').on(t.sessionId, t.dataKey),
  ],
);

export const report = sqliteTable(
  'report',
  {
    id: text('report_id').primaryKey(),
    userId: text('user_id').notNull(),
    websiteId: text('website_id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    parameters: text('parameters', { mode: 'json' }).notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [
    index('report_user_id_idx').on(t.userId),
    index('report_website_id_idx').on(t.websiteId),
    index('report_type_idx').on(t.type),
    index('report_name_idx').on(t.name),
  ],
);

export const annotation = sqliteTable(
  'annotation',
  {
    id: text('annotation_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    userId: text('user_id'),
    date: timestamp('date').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).default(true).notNull(),
    note: text('note').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at').$defaultFn(now).$onUpdateFn(now),
  },
  t => [index('annotation_website_id_date_idx').on(t.websiteId, t.date)],
);

export const segment = sqliteTable(
  'segment',
  {
    id: text('segment_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    parameters: text('parameters', { mode: 'json' }).notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [index('segment_website_id_idx').on(t.websiteId)],
);

export const revenue = sqliteTable(
  'revenue',
  {
    id: text('revenue_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id').notNull(),
    eventName: text('event_name').notNull(),
    currency: text('currency').notNull(),
    revenue: real('revenue'),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    index('revenue_website_id_idx').on(t.websiteId),
    index('revenue_session_id_idx').on(t.sessionId),
    index('revenue_website_id_created_at_idx').on(t.websiteId, t.createdAt),
    index('revenue_website_id_session_id_created_at_idx').on(t.websiteId, t.sessionId, t.createdAt),
  ],
);

export const link = sqliteTable(
  'link',
  {
    id: text('link_id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    slug: text('slug').notNull(),
    userId: text('user_id'),
    teamId: text('team_id'),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
    deletedAt: timestamp('deleted_at'),
  },
  t => [
    uniqueIndex('link_slug_key').on(t.slug),
    index('link_slug_idx').on(t.slug),
    index('link_user_id_idx').on(t.userId),
    index('link_team_id_idx').on(t.teamId),
    index('link_created_at_idx').on(t.createdAt),
  ],
);

export const pixel = sqliteTable(
  'pixel',
  {
    id: text('pixel_id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    userId: text('user_id'),
    teamId: text('team_id'),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
    deletedAt: timestamp('deleted_at'),
  },
  t => [
    uniqueIndex('pixel_slug_key').on(t.slug),
    index('pixel_slug_idx').on(t.slug),
    index('pixel_user_id_idx').on(t.userId),
    index('pixel_team_id_idx').on(t.teamId),
    index('pixel_created_at_idx').on(t.createdAt),
  ],
);

export const board = sqliteTable(
  'board',
  {
    id: text('board_id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    parameters: text('parameters', { mode: 'json' }).notNull(),
    userId: text('user_id'),
    teamId: text('team_id'),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [
    index('board_user_id_idx').on(t.userId),
    index('board_team_id_idx').on(t.teamId),
    index('board_created_at_idx').on(t.createdAt),
  ],
);

export const share = sqliteTable(
  'share',
  {
    id: text('share_id').primaryKey(),
    entityId: text('entity_id').notNull(),
    name: text('name').notNull(),
    shareType: integer('share_type').notNull(),
    slug: text('slug').notNull(),
    parameters: text('parameters', { mode: 'json' }).notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [uniqueIndex('share_slug_key').on(t.slug), index('share_entity_id_idx').on(t.entityId)],
);

export const sessionReplay = sqliteTable(
  'session_replay',
  {
    id: text('replay_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    visitId: text('visit_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    events: blob('events').notNull(),
    eventCount: integer('event_count').notNull(),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
  },
  t => [
    index('session_replay_website_id_idx').on(t.websiteId),
    index('session_replay_session_id_idx').on(t.sessionId),
    index('session_replay_visit_id_idx').on(t.visitId),
    index('session_replay_website_id_session_id_idx').on(t.websiteId, t.sessionId),
    index('session_replay_website_id_visit_id_idx').on(t.websiteId, t.visitId),
    index('session_replay_website_id_created_at_idx').on(t.websiteId, t.createdAt),
    index('session_replay_session_id_chunk_index_idx').on(t.sessionId, t.chunkIndex),
  ],
);

export const sessionReplaySaved = sqliteTable(
  'session_replay_saved',
  {
    id: text('saved_replay_id').primaryKey(),
    name: text('name').notNull(),
    websiteId: text('website_id').notNull(),
    visitId: text('visit_id').notNull(),
    createdAt: timestamp('created_at').$defaultFn(now),
    updatedAt: timestamp('updated_at'),
  },
  t => [
    uniqueIndex('session_replay_saved_website_id_visit_id_key').on(t.websiteId, t.visitId),
    index('session_replay_saved_website_id_idx').on(t.websiteId),
    index('session_replay_saved_visit_id_idx').on(t.visitId),
    index('session_replay_saved_website_id_created_at_idx').on(t.websiteId, t.createdAt),
  ],
);

export const heatmapEvent = sqliteTable(
  'heatmap_event',
  {
    id: text('heatmap_event_id').primaryKey(),
    websiteId: text('website_id').notNull(),
    sessionId: text('session_id').notNull(),
    visitId: text('visit_id').notNull(),
    urlPath: text('url_path').notNull(),
    eventType: integer('event_type').notNull(),
    x: integer('x'),
    y: integer('y'),
    pageX: integer('page_x'),
    pageY: integer('page_y'),
    pageW: integer('page_w'),
    viewportW: integer('viewport_w'),
    viewportH: integer('viewport_h'),
    pageH: integer('page_h'),
    scrollPct: integer('scroll_pct'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
  },
  t => [
    index('heatmap_event_website_id_created_at_idx').on(t.websiteId, t.createdAt),
    index('heatmap_event_website_id_url_path_event_type_created_at_idx').on(
      t.websiteId,
      t.urlPath,
      t.eventType,
      t.createdAt,
    ),
  ],
);

export const twoFactorAuth = sqliteTable(
  'two_factor_auth',
  {
    id: text('id').primaryKey().$defaultFn(cuid),
    userId: text('user_id').notNull(),
    secret: text('secret').notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).default(false).notNull(),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  },
  t => [uniqueIndex('two_factor_auth_user_id_key').on(t.userId)],
);

export const twoFactorBackupCode = sqliteTable(
  'two_factor_backup_code',
  {
    id: text('id').primaryKey().$defaultFn(cuid),
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    used: integer('used', { mode: 'boolean' }).default(false).notNull(),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
  },
  t => [index('two_factor_backup_code_user_id_idx').on(t.userId)],
);

export const twoFactorOtpUsed = sqliteTable(
  'two_factor_otp_used',
  {
    id: text('id').primaryKey().$defaultFn(cuid),
    userId: text('user_id').notNull(),
    otp: text('otp').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  t => [uniqueIndex('two_factor_otp_used_user_id_otp_key').on(t.userId, t.otp)],
);

export const twoFactorRateLimit = sqliteTable(
  'two_factor_rate_limit',
  {
    id: text('id').primaryKey().$defaultFn(cuid),
    userId: text('user_id').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lockedUntil: timestamp('locked_until'),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
  },
  t => [uniqueIndex('two_factor_rate_limit_user_id_key').on(t.userId)],
);

export const appSetting = sqliteTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
