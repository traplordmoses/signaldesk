export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generatedPosts, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const post = db.select().from(generatedPosts).where(eq(generatedPosts.id, id)).get()
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })

    db.update(generatedPosts)
      .set({ status: 'posted', postedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(generatedPosts.id, id))
      .run()

    try {
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_published',
        entityType: 'generated_post',
        entityId: id,
        details: JSON.stringify({ clusterId: post.clusterId }),
        createdAt: Date.now(),
      }).run()
    } catch {}

    const intentUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(post.content)
    return NextResponse.json({ success: true, intentUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
