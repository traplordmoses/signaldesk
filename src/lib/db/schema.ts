import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const newsSources = sqliteTable('news_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  category: text('category').notNull(),
  weight: integer('weight').default(5),
  isActive: integer('is_active').default(1),
  lastFetchedAt: integer('last_fetched_at'),
  lastError: text('last_error'),
})

export const newsItems = sqliteTable('news_items', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  summary: text('summary'),
  url: text('url').notNull().unique(),
  urlHash: text('url_hash').notNull().unique(),
  titleHash: text('title_hash').notNull(),
  sourceId: text('source_id').notNull(),
  sourceName: text('source_name').notNull(),
  category: text('category').notNull(),
  publishedAt: integer('published_at').notNull(),
  ingestedAt: integer('ingested_at').notNull(),
  relevanceScore: real('relevance_score').default(0),
  riskLevel: text('risk_level').default('low'),
  riskReasons: text('risk_reasons'),
  clusterId: text('cluster_id'),
  isProcessed: integer('is_processed').default(0),
})

export const eventClusters = sqliteTable('event_clusters', {
  id: text('id').primaryKey(),
  canonicalHeadline: text('canonical_headline').notNull(),
  category: text('category').notNull(),
  relevanceScore: real('relevance_score').default(0),
  riskLevel: text('risk_level').default('low'),
  riskReasons: text('risk_reasons'),
  sourceCount: integer('source_count').default(1),
  constituentItemIds: text('constituent_item_ids').notNull(),
  constituentSummaries: text('constituent_summaries'),
  status: text('status').default('new'),
  topics: text('topics'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastUpdatedAt: integer('last_updated_at').notNull(),
  postCount: integer('post_count').default(0),
})

export const generatedPosts = sqliteTable('generated_posts', {
  id: text('id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  contentMode: text('content_mode').notNull(),
  content: text('content').notNull(),
  marketLink: text('market_link').notNull(),
  charCount: integer('char_count').notNull(),
  estimatedScore: real('estimated_score'),
  scoreExplanation: text('score_explanation'),
  status: text('status').default('pending'),
  rejectionReason: text('rejection_reason'),
  postedAt: integer('posted_at'),
  reviewedBy: text('reviewed_by'),
  larkMessageId: text('lark_message_id'),
  larkSentAt: integer('lark_sent_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  actor: text('actor').default('system'),
  details: text('details'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey().default('singleton'),
  platformName: text('platform_name').default('SignalDesk'),
  marketBaseUrl: text('market_base_url').default('https://yourplatform.com/markets'),
  autoGenerateThreshold: real('auto_generate_threshold').default(6.5),
  postCooldownMinutes: integer('post_cooldown_minutes').default(15),
  dailyPostLimit: integer('daily_post_limit').default(20),
  larkEnabled: integer('lark_enabled').default(1),
  updatedAt: integer('updated_at').notNull(),
})
