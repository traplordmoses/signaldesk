export const dynamic='force-dynamic'
import { NextRequest,NextResponse } from 'next/server'
import { db,sqlite } from '@/lib/db'
import { generatedPosts,auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireApprovable,normalizePostUrl } from '@/lib/editorial/review'

export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const {id}=await params
    const post=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
    if(!post)return NextResponse.json({error:'Post not found'},{status:404})
    const raw=await req.text()
    const body=raw?JSON.parse(raw):{}
    if(body.published_url) {
      if(!['approved','publishing','posted'].includes(post.status??''))throw new Error('Approve the draft before confirming publication')
      const url=normalizePostUrl(body.published_url)
      if(post.status==='posted') {
        if(post.publishedUrl!==url)throw new Error('Publication already recorded with a different URL')
        return NextResponse.json({success:true,publishedUrl:url})
      }
      sqlite.transaction(()=>{
        db.update(generatedPosts).set({status:'posted',publishedUrl:url,postedAt:Date.now(),updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
        db.insert(auditLog).values({id:crypto.randomUUID(),eventType:'publication_confirmed_by_reviewer',entityType:'generated_post',entityId:id,actor:'web',details:JSON.stringify({url}),createdAt:Date.now()}).run()
      })()
      return NextResponse.json({success:true,publishedUrl:url})
    }
    if(!['approved','publishing'].includes(post.status??''))throw new Error('Approve the draft before opening X')
    requireApprovable(post)
    db.update(generatedPosts).set({status:'publishing',updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
    return NextResponse.json({success:true,intentUrl:'https://twitter.com/intent/tweet?text='+encodeURIComponent(post.content)})
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400})}
}
