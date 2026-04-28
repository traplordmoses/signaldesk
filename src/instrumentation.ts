// Indexes for hot-path queries. Idempotent — `IF NOT EXISTS` so it's safe to
// re-run on every boot. The original schema had zero indexes, so dedup queries
// were full scans within a month of running. These cover dedup, cron candidate
// scans, audit-log queries, and post review.
const HOT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_news_items_url_hash       ON news_items(url_hash)',
  'CREATE INDEX IF NOT EXISTS idx_news_items_title_hash     ON news_items(title_hash)',
  'CREATE INDEX IF NOT EXISTS idx_news_items_ingested_at    ON news_items(ingested_at)',
  'CREATE INDEX IF NOT EXISTS idx_news_items_cluster_id     ON news_items(cluster_id)',
  'CREATE INDEX IF NOT EXISTS idx_news_items_published_at   ON news_items(published_at)',
  'CREATE INDEX IF NOT EXISTS idx_event_clusters_status     ON event_clusters(status)',
  'CREATE INDEX IF NOT EXISTS idx_event_clusters_first_seen ON event_clusters(first_seen_at)',
  'CREATE INDEX IF NOT EXISTS idx_generated_posts_cluster   ON generated_posts(cluster_id)',
  'CREATE INDEX IF NOT EXISTS idx_generated_posts_status    ON generated_posts(status)',
  'CREATE INDEX IF NOT EXISTS idx_generated_posts_created   ON generated_posts(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_created_at      ON audit_log(created_at)',
]

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
      const { db, sqlite } = await import('@/lib/db')

      // The original code ran `migrate()` on every boot. That's a known footgun —
      // mid-rollout migration on a flaky droplet that OOM-restarts can leave the DB
      // in an inconsistent state. Gate it behind RUN_MIGRATIONS=1 so production
      // deploys explicitly opt in (e.g. as a one-shot job before flipping traffic).
      if (process.env.NODE_ENV !== 'production' || process.env.RUN_MIGRATIONS === '1') {
        migrate(db, { migrationsFolder: './drizzle' })
        console.log('[startup] DB migrations applied')
      } else {
        console.log('[startup] migrations skipped (set RUN_MIGRATIONS=1 to enable)')
      }

      // Hot-path indexes (idempotent — always safe to ensure)
      for (const sql of HOT_INDEXES) {
        try { sqlite.exec(sql) } catch (e) {
          console.error(`[startup] index create failed: ${sql.slice(0, 60)}…`, e)
        }
      }
      console.log(`[startup] verified ${HOT_INDEXES.length} hot-path indexes`)
    } catch (e) {
      console.error('[startup] Migration error:', e)
    }

    try {
      const { seedIfEmpty } = await import('@/lib/db/seed')
      await seedIfEmpty()
    } catch (e) {
      console.error('[startup] Seed error:', e)
    }

    const { startScheduler } = await import('@/lib/cron/scheduler')
    startScheduler()
  }
}
