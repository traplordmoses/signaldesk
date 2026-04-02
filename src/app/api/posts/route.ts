export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generatedPosts } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const limit = parseInt(searchParams.get('limit') ?? '20', 10)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    let query = db.select().from(generatedPosts).$dynamic()

    if (status) {
      query = query.where(eq(generatedPosts.status, status))
    }

    const all = await query.orderBy(desc(generatedPosts.createdAt)).all()
    const total = all.length
    const posts = all.slice(offset, offset + limit)

    return NextResponse.json({ posts, total })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
