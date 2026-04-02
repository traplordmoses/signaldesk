export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { eventClusters, newsItems, generatedPosts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const cluster = db.select().from(eventClusters).where(eq(eventClusters.id, id)).get()
    if (!cluster) return NextResponse.json({ error: 'Cluster not found' }, { status: 404 })

    const items = db.select().from(newsItems).where(eq(newsItems.clusterId, id)).all()
    const posts = db.select().from(generatedPosts).where(eq(generatedPosts.clusterId, id)).all()

    return NextResponse.json({ cluster, newsItems: items, posts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
