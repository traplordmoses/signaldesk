import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { newsSources } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json() as { isActive?: number; weight?: number }

    const update: Partial<typeof newsSources.$inferInsert> = {}
    if (body.isActive !== undefined) update.isActive = body.isActive
    if (body.weight !== undefined) update.weight = body.weight

    db.update(newsSources).set(update).where(eq(newsSources.id, id)).run()

    const source = db.select().from(newsSources).where(eq(newsSources.id, id)).get()
    return NextResponse.json(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
