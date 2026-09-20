import type Database from 'better-sqlite3'

/** Additive, restart-safe migrations. Never rewrites existing editorial history. */
export function migrateNewsroom(sqlite: Database.Database) {
  const add = (table: string, column: string, definition: string) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.length && !columns.some(c => c.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  // Older releases added these before the base migrations existed on a new DB.
  add('generated_posts', 'signals', 'TEXT')
  add('news_sources', 'weight_bonus', 'REAL NOT NULL DEFAULT 0')
  add('news_items', 'timestamp_confidence', "TEXT NOT NULL DEFAULT 'unknown'")
  add('generated_posts', 'published_url', 'TEXT')
  add('generated_posts', 'legal_cleared_by', 'TEXT')
  add('generated_posts', 'legal_cleared_at', 'INTEGER')
  add('event_clusters', 'parent_cluster_id', 'TEXT')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS delivery_outbox (
      post_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delivery_due ON delivery_outbox(state, available_at);
    CREATE TABLE IF NOT EXISTS generation_jobs (
      cluster_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS newsroom_heartbeat (
      name TEXT PRIMARY KEY, last_started INTEGER, last_success INTEGER, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS market_quotes (
      market_id TEXT NOT NULL, observed_at INTEGER NOT NULL, price REAL NOT NULL,
      bid REAL, ask REAL, liquidity REAL NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (market_id, observed_at)
    );
    CREATE TABLE IF NOT EXISTS market_replies (
      post_id TEXT PRIMARY KEY, content TEXT NOT NULL, quote_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, approved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS market_alerts (
      market_id TEXT PRIMARY KEY, last_alert_at INTEGER NOT NULL
    );
  `)
}
