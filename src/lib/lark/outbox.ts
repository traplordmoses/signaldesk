import { db, sqlite } from '@/lib/db'
import { generatedPosts, eventClusters, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { sendClusterToLark } from './messages'

export function claimDelivery(now = Date.now()): string | null {
  return sqlite.transaction(() => {
    const job = sqlite.prepare(`SELECT post_id FROM delivery_outbox
      WHERE (state='pending' AND available_at<=?) OR (state='sending' AND lease_until<=?)
      ORDER BY created_at LIMIT 1`).get(now, now) as { post_id: string } | undefined
    if (!job) return null
    sqlite.prepare("UPDATE delivery_outbox SET state='sending',lease_until=?,attempts=attempts+1 WHERE post_id=?")
      .run(now + 120_000, job.post_id)
    return job.post_id
  })()
}
let running = false
export async function drainOutbox() {
  if (running || !process.env.LARK_REVIEW_CHAT_ID) return
  if (db.select().from(settings).limit(1).get()?.larkEnabled !== 1) return
  running = true
  try {
    for (let i = 0; i < 4; i++) {
      const id = claimDelivery()
      if (!id) break
      const post = db.select().from(generatedPosts).where(eq(generatedPosts.id, id)).get()
      const cluster = post && db.select().from(eventClusters).where(eq(eventClusters.id, post.clusterId)).get()
      if (!post || !cluster || post.larkSentAt || post.status !== 'pending' || Date.now() - post.createdAt > 8 * 3600_000) {
        sqlite.prepare("UPDATE delivery_outbox SET state='cancelled',lease_until=NULL WHERE post_id=?").run(id)
        continue
      }
      try {
        const messageId = await sendClusterToLark(cluster, [post], id)
        if (!messageId) throw new Error('Lark returned no message ID')
        sqlite.transaction(() => {
          db.update(generatedPosts).set({ larkMessageId: messageId, larkSentAt: Date.now() }).where(eq(generatedPosts.id, id)).run()
          sqlite.prepare("UPDATE delivery_outbox SET state='sent',lease_until=NULL,last_error=NULL WHERE post_id=?").run(id)
        })()
      } catch (e) {
        const attempts = (sqlite.prepare('SELECT attempts FROM delivery_outbox WHERE post_id=?').get(id) as { attempts: number }).attempts
        sqlite.prepare("UPDATE delivery_outbox SET state=?,available_at=?,lease_until=NULL,last_error=? WHERE post_id=?")
          .run(attempts >= 8 ? 'failed' : 'pending', Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** attempts), String(e).slice(0, 500), id)
      }
    }
  } finally { running = false }
}
