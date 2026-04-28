export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { eventClusters } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateAllModes, generatePost } from '@/lib/ai/generator'

type ContentMode = 'pure_news' | 'news_odds' | 'engagement'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { cluster_id?: string; mode?: ContentMode }
    const clusterId = body.cluster_id

    if (!clusterId) {
      return NextResponse.json({ error: 'cluster_id is required' }, { status: 400 })
    }

    const cluster = db.select().from(eventClusters).where(eq(eventClusters.id, clusterId)).get()
    if (!cluster) {
      return NextResponse.json({ error: 'Cluster not found' }, { status: 404 })
    }

    // If mode is specified, generate just that mode; otherwise smart-pick
    const posts = body.mode ? [await generatePost(cluster, body.mode)] : await generateAllModes(cluster)
    return NextResponse.json({ posts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
