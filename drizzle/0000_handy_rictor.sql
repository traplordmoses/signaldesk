CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`actor` text DEFAULT 'system',
	`details` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_headline` text NOT NULL,
	`category` text NOT NULL,
	`relevance_score` real DEFAULT 0,
	`risk_level` text DEFAULT 'low',
	`risk_reasons` text,
	`source_count` integer DEFAULT 1,
	`constituent_item_ids` text NOT NULL,
	`constituent_summaries` text,
	`status` text DEFAULT 'new',
	`first_seen_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	`post_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `generated_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`cluster_id` text NOT NULL,
	`content_mode` text NOT NULL,
	`content` text NOT NULL,
	`market_link` text NOT NULL,
	`char_count` integer NOT NULL,
	`estimated_score` real,
	`score_explanation` text,
	`status` text DEFAULT 'pending',
	`rejection_reason` text,
	`posted_at` integer,
	`reviewed_by` text,
	`lark_message_id` text,
	`lark_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`title_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`category` text NOT NULL,
	`published_at` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	`relevance_score` real DEFAULT 0,
	`risk_level` text DEFAULT 'low',
	`risk_reasons` text,
	`cluster_id` text,
	`is_processed` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_items_url_unique` ON `news_items` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `news_items_url_hash_unique` ON `news_items` (`url_hash`);--> statement-breakpoint
CREATE TABLE `news_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`category` text NOT NULL,
	`weight` integer DEFAULT 5,
	`is_active` integer DEFAULT 1,
	`last_fetched_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`platform_name` text DEFAULT 'SignalDesk',
	`market_base_url` text DEFAULT 'https://yourplatform.com/markets',
	`auto_generate_threshold` real DEFAULT 6.5,
	`post_cooldown_minutes` integer DEFAULT 15,
	`daily_post_limit` integer DEFAULT 20,
	`lark_enabled` integer DEFAULT 1,
	`updated_at` integer NOT NULL
);
