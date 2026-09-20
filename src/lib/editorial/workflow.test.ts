import { beforeAll,beforeEach,describe,it,expect,vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { NextRequest } from 'next/server'
import { db,sqlite } from '@/lib/db'
import { migrateNewsroom } from '@/lib/db/newsroom'
import { eventClusters,generatedPosts,settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { contentHash } from './review'
import { POST as publish } from '@/app/api/posts/[id]/publish/route'
import { PATCH as patch } from '@/app/api/posts/[id]/route'
import { drainOutbox } from '@/lib/lark/outbox'
import { sendClusterToLark } from '@/lib/lark/messages'
vi.mock('@/lib/lark/messages',()=>({sendClusterToLark:vi.fn()}))
beforeAll(()=>{migrate(db,{migrationsFolder:'./drizzle'});migrateNewsroom(sqlite)})
beforeEach(()=>{sqlite.exec('DELETE FROM delivery_outbox');vi.mocked(sendClusterToLark).mockReset()})
function post(status='approved') {
  const now=Date.now(),id=crypto.randomUUID(),clusterId=crypto.randomUUID(),content='🟣 JUST IN: Arsenal confirms its lineup.'
  db.insert(eventClusters).values({id:clusterId,canonicalHeadline:'Arsenal confirms its lineup',category:'sports',riskLevel:'low',constituentItemIds:'[]',firstSeenAt:now,lastUpdatedAt:now}).run()
  db.insert(generatedPosts).values({id,clusterId,contentMode:'pure_news',content,marketLink:'',charCount:content.length,status,createdAt:now,updatedAt:now,
    signals:JSON.stringify({lane:'routine',evidence:{publishedAt:now,timestampKnown:true},verification:{supported:true,contentHash:contentHash(content)}})}).run()
  return id
}
const ctx=(id:string)=>({params:Promise.resolve({id})})
describe('publishing workflow',()=>{
  it('opening X does not claim the post was published',async()=>{
    const id=post()
    const res=await publish(new NextRequest('http://localhost/api/posts/id/publish',{method:'POST'}),ctx(id))
    expect(res.status).toBe(200)
    expect((await res.json()).intentUrl).toContain('intent/tweet')
    const row=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!
    expect(row.status).toBe('publishing');expect(row.postedAt).toBeNull();expect(row.publishedUrl).toBeNull()
  })
  it('confirmation needs approval and stores the actual URL idempotently',async()=>{
    const id=post('pending')
    const request=()=>new NextRequest('http://localhost/api/posts/id/publish',{method:'POST',body:JSON.stringify({published_url:'https://x.com/ProblyHQ/status/123456'})})
    expect((await publish(request(),ctx(id))).status).toBe(400)
    db.update(generatedPosts).set({status:'approved'}).where(eq(generatedPosts.id,id)).run()
    expect((await publish(request(),ctx(id))).status).toBe(200)
    expect((await publish(request(),ctx(id))).status).toBe(200)
    const row=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!
    expect(row.status).toBe('posted');expect(row.publishedUrl).toContain('/status/123456')
    expect((sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND event_type='publication_confirmed_by_reviewer'").get(id) as {n:number}).n).toBe(1)
  })
  it('generic PATCH cannot bypass publication confirmation',async()=>{
    const id=post()
    const res=await patch(new NextRequest('http://localhost/api/posts/id',{method:'PATCH',body:JSON.stringify({status:'posted'})}),ctx(id))
    expect(res.status).toBe(400)
    expect(db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!.status).toBe('approved')
  })
  it('records an actionable rejection reason and keeps it separate from expiration',async()=>{
    const id=post('pending')
    const res=await patch(new NextRequest('http://localhost/api/posts/id',{method:'PATCH',body:JSON.stringify({status:'rejected',rejection_reason:'wrong_market'})}),ctx(id))
    expect(res.status).toBe(200)
    expect(db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!.rejectionReason).toBe('wrong_market')
  })
})
describe('Lark delivery recovery',()=>{
  it('retries a failed send independently of a completed generation cluster',async()=>{
    process.env.LARK_REVIEW_CHAT_ID='test-chat'
    db.insert(settings).values({id:'singleton',larkEnabled:1,updatedAt:Date.now()}).onConflictDoUpdate({target:settings.id,set:{larkEnabled:1}}).run()
    const id=post('pending')
    sqlite.prepare('INSERT INTO delivery_outbox(post_id,available_at,created_at) VALUES (?,?,?)').run(id,Date.now(),Date.now())
    vi.mocked(sendClusterToLark).mockRejectedValueOnce(new Error('temporary transport failure'))
    await drainOutbox()
    expect((sqlite.prepare('SELECT state FROM delivery_outbox WHERE post_id=?').get(id) as {state:string}).state).toBe('pending')
    sqlite.prepare('UPDATE delivery_outbox SET available_at=0 WHERE post_id=?').run(id)
    vi.mocked(sendClusterToLark).mockResolvedValueOnce('message-123')
    await drainOutbox()
    expect(db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!.larkMessageId).toBe('message-123')
    expect(vi.mocked(sendClusterToLark).mock.calls[0][2]).toBe(id)
    expect(vi.mocked(sendClusterToLark).mock.calls[1][2]).toBe(id)
    await drainOutbox();expect(sendClusterToLark).toHaveBeenCalledTimes(2)
  })
  it('pausing the bot preserves pending delivery jobs',async()=>{
    db.update(settings).set({larkEnabled:0}).where(eq(settings.id,'singleton')).run()
    const id=post('pending')
    sqlite.prepare('INSERT INTO delivery_outbox(post_id,available_at,created_at) VALUES (?,?,?)').run(id,0,Date.now())
    await drainOutbox();expect(sendClusterToLark).not.toHaveBeenCalled()
    expect((sqlite.prepare('SELECT state FROM delivery_outbox WHERE post_id=?').get(id) as {state:string}).state).toBe('pending')
  })
})
