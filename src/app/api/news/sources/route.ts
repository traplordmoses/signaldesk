export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { newsSources } from '@/lib/db/schema'

export async function GET() {
  try {
    const sources = db.select().from(newsSources).all()
    return NextResponse.json({ sources })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
