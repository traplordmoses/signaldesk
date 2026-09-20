export const dynamic='force-dynamic'
import { NextRequest,NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generatedPosts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { recordReview,editAndVerify,legalClear } from '@/lib/editorial/review'

export async function PATCH(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const {id}=await params
    const b=await req.json() as {status?:string;content?:string;rejection_reason?:string;refresh?:boolean;legal_clear?:boolean}
    if(!db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get())return NextResponse.json({error:'Post not found'},{status:404})
    if(b.content!==undefined || b.refresh) {
      if(b.content!==undefined && typeof b.content!=='string')throw new Error('Content must be text')
      await editAndVerify(id,b.content)
    } else if(b.legal_clear)legalClear(id,'web')
    else if(b.status==='approved' || b.status==='rejected')recordReview(id,b.status,'web',b.rejection_reason)
    else if(b.status==='archived')db.update(generatedPosts).set({status:'archived',updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
    else throw new Error('Unsupported review action')
    return NextResponse.json(db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get())
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400})}
}
