import { createHash } from 'node:crypto'
import { db, sqlite } from '@/lib/db'
import { newsItems, newsSources } from '@/lib/db/schema'
import { scoreItem, detectRisk } from './scorer'
import { eq } from 'drizzle-orm'

export async function ingestExternalSignal(s: {id:string;title:string;text:string;url:string;publishedAt:number;sourceId:string;sourceName:string;category:string}) {
  if (!Number.isFinite(s.publishedAt) || Date.now()-s.publishedAt>4*3600_000 || s.publishedAt>Date.now()+60_000) return
  const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
  const source=db.select().from(newsSources).where(eq(newsSources.id,s.sourceId)).get()
  if (source?.isActive===0) return
  if (!source) db.insert(newsSources).values({id:s.sourceId,name:s.sourceName,url:`signaldesk://external/${s.sourceId}`,category:s.category,weight:10,isActive:1}).onConflictDoNothing().run()
  // External adapters have their own timers; the RSS fetcher excludes their source URLs.
  const risk=detectRisk(`${s.title} ${s.text}`)
  db.insert(newsItems).values({id:crypto.randomUUID(),title:s.title.slice(0,500),summary:s.text.slice(0,3000),url:s.sourceId==='probly_movement'?`${s.url}#${s.id}`:s.url,
    urlHash:hash(s.id),titleHash:hash(s.title),sourceId:s.sourceId,sourceName:s.sourceName,category:s.category,
    publishedAt:s.publishedAt,timestampConfidence:'feed',ingestedAt:Date.now(),relevanceScore:scoreItem(s.title,s.text,10,s.publishedAt),
    riskLevel:risk.level,riskReasons:JSON.stringify(risk.reasons),isProcessed:0}).onConflictDoNothing().run()
  const { requestPipeline }=await import('@/lib/cron/scheduler');requestPipeline()
}
let started=false
/** Uses pre-provisioned stream rules; this code never broadens account access or buys API credits. */
export function startSocialStream() {
  const token=process.env.X_BEARER_TOKEN
  const allowed=new Set((process.env.X_NEWS_AUTHOR_IDS??'').split(',').map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))
  if(started || !token || !allowed.size) return
  started=true
  const run=async()=>{
    let delay=5000
    while(started){
      try{
        const res=await fetch('https://api.x.com/2/tweets/search/stream?tweet.fields=created_at,author_id,referenced_tweets',{
          signal:AbortSignal.timeout(15*60_000),headers:{Authorization:`Bearer ${token}`}})
        if(!res.ok || !res.body) throw new Error(`X stream HTTP ${res.status}`)
        const reader=res.body.getReader();const decoder=new TextDecoder();let buffer=''
        try {
          while(started){
            const chunk=await reader.read();if(chunk.done)break
            buffer+=decoder.decode(chunk.value,{stream:true})
            if(buffer.length>1_000_000)throw new Error('X stream frame too large')
            let n:number
            while((n=buffer.indexOf('\n'))>=0){
              const line=buffer.slice(0,n).trim();buffer=buffer.slice(n+1);if(!line)continue
              const payload=JSON.parse(line) as {data?:{id:string;author_id:string;text:string;created_at:string;referenced_tweets?:unknown[]}}
              const p=payload.data;if(!p || !allowed.has(p.author_id) || p.referenced_tweets?.length)continue
              await ingestExternalSignal({id:`x-${p.id}`,title:p.text.split('\n')[0],text:p.text,url:`https://x.com/i/status/${p.id}`,
                publishedAt:Date.parse(p.created_at),sourceId:`primary_x_${p.author_id}`,sourceName:`Primary X account ${p.author_id}`,category:'politics'})
              sqlite.prepare(`INSERT INTO newsroom_heartbeat(name,last_success) VALUES ('x-stream',?) ON CONFLICT(name) DO UPDATE SET last_success=excluded.last_success,last_error=NULL`).run(Date.now())
            }
          }
        } finally { await reader.cancel().catch(()=>{}) }
        delay=5000
      }catch(e){
        sqlite.prepare(`INSERT INTO newsroom_heartbeat(name,last_error) VALUES ('x-stream',?) ON CONFLICT(name) DO UPDATE SET last_error=excluded.last_error`).run(String(e).slice(0,300))
        console.error('[x-stream]',String(e));delay=Math.min(delay*2,300_000)
      }
      await new Promise(r=>{const timer=setTimeout(r,delay);timer.unref()})
    }
  }
  process.once('SIGTERM',()=>{started=false});process.once('SIGINT',()=>{started=false});void run()
}
