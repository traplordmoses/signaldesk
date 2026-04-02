import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generatedPosts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json() as {
      status?: string
      content?: string
      rejection_reason?: string
      reviewed_by?: string
    }

    const update: Partial<typeof generatedPosts.$inferInsert> = {
      updatedAt: Date.now(),
    }
    if (body.status !== undefined) update.status = body.status
    if (body.content !== undefined) update.content = body.content
    if (body.rejection_reason !== undefined) update.rejectionReason = body.rejection_reason
    if (body.reviewed_by !== undefined) update.reviewedBy = body.reviewed_by

    db.update(generatedPosts).set(update).where(eq(generatedPosts.id, id)).run()

    const post = db.select().from(generatedPosts).where(eq(generatedPosts.id, id)).get()
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })

    return NextResponse.json(post)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
