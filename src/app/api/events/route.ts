import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { eventClusters, generatedPosts } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const includePosts = searchParams.get('include_posts') === 'true'

    const clusters = db.select()
      .from(eventClusters)
      .orderBy(desc(eventClusters.relevanceScore), desc(eventClusters.lastUpdatedAt))
      .limit(50)
      .all()

    if (!includePosts) {
      return NextResponse.json({ clusters })
    }

    // Attach posts to each cluster — latest one per mode only
    const clustersWithPosts = clusters.map(cluster => {
      const allPosts = db.select()
        .from(generatedPosts)
        .where(eq(generatedPosts.clusterId, cluster.id))
        .all()
        .filter(p => p.status === 'pending' || p.status === 'approved')
        .sort((a, b) => b.createdAt - a.createdAt)

      // Keep only the latest post per content mode
      const seen = new Set<string>()
      const posts = allPosts.filter(p => {
        if (seen.has(p.contentMode)) return false
        seen.add(p.contentMode)
        return true
      })

      return { ...cluster, posts }
    })

    return NextResponse.json({ clusters: clustersWithPosts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
