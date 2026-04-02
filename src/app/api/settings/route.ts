export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function GET() {
  try {
    const row = db.select().from(settings).where(eq(settings.id, 'singleton')).get()
    if (!row) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })
    return NextResponse.json(row)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as Partial<typeof settings.$inferInsert>

    const update = { ...body, updatedAt: Date.now() }
    delete update.id

    db.update(settings).set(update).where(eq(settings.id, 'singleton')).run()

    const row = db.select().from(settings).where(eq(settings.id, 'singleton')).get()
    return NextResponse.json(row)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
