import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { eventClusters } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateAllModes } from '@/lib/ai/generator'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { cluster_id?: string }
    const clusterId = body.cluster_id

    if (!clusterId) {
      return NextResponse.json({ error: 'cluster_id is required' }, { status: 400 })
    }

    const cluster = db.select().from(eventClusters).where(eq(eventClusters.id, clusterId)).get()
    if (!cluster) {
      return NextResponse.json({ error: 'Cluster not found' }, { status: 404 })
    }

    const posts = await generateAllModes(cluster)
    return NextResponse.json({ posts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
