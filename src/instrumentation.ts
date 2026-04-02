export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Run DB migrations and seed on every startup (safe to run multiple times)
    try {
      const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
      const { db, sqlite } = await import('@/lib/db')
      migrate(db, { migrationsFolder: './drizzle' })
      console.log('[startup] DB migrations applied')
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
