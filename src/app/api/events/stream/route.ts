import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { eventClusters } from '@/lib/db/schema'
import { desc, gt } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      // Send initial heartbeat
      controller.enqueue(encoder.encode(': heartbeat\n\n'))

      // Track last seen cluster time
      let lastSeenAt = Date.now()

      const interval = setInterval(() => {
        if (closed) { clearInterval(interval); return }

        try {
          // Check for new high-score clusters
          const newClusters = db.select()
            .from(eventClusters)
            .where(gt(eventClusters.firstSeenAt, lastSeenAt))
            .orderBy(desc(eventClusters.relevanceScore))
            .all()
            .filter(c => (c.relevanceScore ?? 0) >= 5)

          if (newClusters.length > 0) {
            lastSeenAt = Math.max(...newClusters.map(c => c.firstSeenAt))
            const payload = JSON.stringify({
              type: 'new_clusters',
              count: newClusters.length,
              topScore: newClusters[0].relevanceScore,
              topHeadline: newClusters[0].canonicalHeadline,
              clusters: newClusters.slice(0, 3).map(c => ({
                id: c.id,
                headline: c.canonicalHeadline,
                score: c.relevanceScore,
                topics: c.topics,
              })),
            })
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
          } else {
            // Heartbeat every 15s to keep connection alive
            controller.enqueue(encoder.encode(': ping\n\n'))
          }
        } catch (e) {
          // DB errors shouldn't kill the stream — but log them so we know it's happening
          console.error('event stream poll failed:', e)
          controller.enqueue(encoder.encode(': error\n\n'))
        }
      }, 15000)

      // Clean up when client disconnects
      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
