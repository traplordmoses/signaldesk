export const dynamic='force-dynamic'
import { NextRequest,NextResponse } from 'next/server'
import { db,sqlite } from '@/lib/db'
import { generatedPosts,eventClusters } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { evidenceFor } from '@/lib/editorial/evidence'
import { problyMarketFor } from '@/lib/markets/probly'
import { detectCategory } from '@/lib/news/scorer'
import { freshMarketReply } from '@/lib/markets/feed'

export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const {id}=await params
    const b=await req.json() as {action?:string}
    const post=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
    if(!post || !['approved','publishing','posted'].includes(post.status??''))throw new Error('Approve the main news post first')
    if(b.action==='prepare') {
      const cluster=db.select().from(eventClusters).where(eq(eventClusters.id,post.clusterId)).get()
      const evidence=cluster&&evidenceFor(cluster)
      const match=evidence&&problyMarketFor(evidence.headline,evidence.text,detectCategory(evidence.headline,evidence.text))
      const content=match&&freshMarketReply(id,match)
      if(!content)throw new Error('No precise market match with a fresh, liquid Probly quote is available')
      return NextResponse.json({content})
    }
    if(b.action!=='approve')throw new Error('Choose prepare or approve')
    if (!post.publishedUrl) throw new Error('Record the main X post URL before publishing its reply')
    const reply=sqlite.prepare('SELECT content,quote_at FROM market_replies WHERE post_id=?').get(id) as {content:string;quote_at:number}|undefined
    if(!reply || Date.now()-reply.quote_at>60_000)throw new Error('Quote expired. Prepare a fresh reply and review it again')
    sqlite.prepare("UPDATE market_replies SET state='approved',approved_by='web',approved_at=? WHERE post_id=?").run(Date.now(),id)
    const parent=post.publishedUrl?.split('/').pop()
    return NextResponse.json({intentUrl:`https://twitter.com/intent/tweet?text=${encodeURIComponent(reply.content)}${parent?`&in_reply_to=${parent}`:''}`})
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400})}
}
