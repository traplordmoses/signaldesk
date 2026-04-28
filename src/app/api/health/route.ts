export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { newsSources, newsItems, eventClusters, generatedPosts } from '@/lib/db/schema'
import { gt } from 'drizzle-orm'

// Public health endpoint. Monitoring tools (uptime checks, k8s probes) hit this
// without auth. Returns aggregate state — never PII or secrets.
export async function GET() {
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000
    const hourAgo = Date.now() - 60 * 60 * 1000

    const recentItems = db.select().from(newsItems).where(gt(newsItems.ingestedAt, hourAgo)).all().length
    const todayClusters = db.select().from(eventClusters).where(gt(eventClusters.firstSeenAt, dayAgo)).all().length
    const todayPosts = db.select().from(generatedPosts).where(gt(generatedPosts.createdAt, dayAgo)).all().length
    const sourcesActive = db.select().from(newsSources).all().filter(s => s.isActive === 1).length

    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      stats: {
        sources_active: sourcesActive,
        items_last_hour: recentItems,
        clusters_today: todayClusters,
        posts_today: todayPosts,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
