import { createHash } from 'node:crypto'
import { db, sqlite } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { GeneratedPost } from '@/types'
import { evidenceFor, freshnessLabel } from './evidence'

export const REJECTION_REASONS = ['stale','weak_story','duplicate','wrong_market','inaccurate','other'] as const
export function contentHash(text: string) { return createHash('sha256').update(text).digest('hex') }
export function approvalProblem(post: GeneratedPost, risk: string | null, now=Date.now()): string|null {
  if (!['pending','approved','publishing'].includes(post.status ?? '')) return 'This draft is no longer awaiting approval.'
  let s: {evidence?:{publishedAt:number;timestampKnown:boolean};verification?:{supported:boolean;contentHash:string};lane?:string}
  try { s=JSON.parse(post.signals??'{}') } catch { return 'Missing source verification. Regenerate this draft.' }
  if (!s.verification?.supported || s.verification.contentHash!==contentHash(post.content)) return 'This version needs evidence verification before approval.'
  if (!s.evidence || now-s.evidence.publishedAt>4*3600_000) return 'This source is over four hours old. Find a fresh development.'
  const actual=post.content.match(/\b(BREAKING|JUST IN|NEW|UPDATE):/i)?.[1]
  const expected=freshnessLabel(s.evidence,s.lane==='urgent',now)
  if ((actual==='BREAKING' && expected!=='BREAKING') || (actual==='JUST IN' && expected==='UPDATE')) return 'This alert label is stale. Refresh the draft in the review dashboard.'
  if (risk==='high' && !post.legalClearedAt) return 'Confirm legal clearance before approving this sensitive story.'
  return null
}
export function requireApprovable(post: GeneratedPost) {
  const cluster=db.select().from(eventClusters).where(eq(eventClusters.id,post.clusterId)).get()
  const problem=approvalProblem(post,cluster?.riskLevel??'high')
  if(problem)throw new Error(problem)
}
export function recordReview(id:string,status:'approved'|'rejected',actor:string,reason?:string) {
  const post=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
  if(!post)throw new Error('Post not found')
  if(status==='approved')requireApprovable(post)
  else if(post.status==='posted')throw new Error('A published post cannot be rejected')
  if(status==='rejected' && !REJECTION_REASONS.includes(reason as typeof REJECTION_REASONS[number]))throw new Error('Choose a rejection reason')
  if(post.status===status)return post
  sqlite.transaction(()=>{
    db.update(generatedPosts).set({status,reviewedBy:actor,rejectionReason:status==='rejected'?reason:null,updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
    db.insert(auditLog).values({id:crypto.randomUUID(),eventType:status==='approved'?'post_approved':'post_rejected',entityType:'generated_post',entityId:id,actor,details:JSON.stringify({reason}),createdAt:Date.now()}).run()
  })()
  return db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!
}
export function legalClear(id:string,actor:string) {
  const allowed=(process.env.LEGAL_REVIEWER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean)
  if(allowed.length && !allowed.includes(actor))throw new Error('Legal clearance requires a configured legal reviewer')
  const post=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
  if(!post || post.status!=='pending')throw new Error('Only pending drafts can receive legal clearance')
  db.update(generatedPosts).set({legalClearedBy:actor,legalClearedAt:Date.now(),updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
  db.insert(auditLog).values({id:crypto.randomUUID(),eventType:'legal_clearance_attested',entityType:'generated_post',entityId:id,actor,createdAt:Date.now()}).run()
}
export async function editAndVerify(id:string,content?:string) {
  const post=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
  if(!post || post.status==='posted')throw new Error('Draft is not editable')
  const cluster=db.select().from(eventClusters).where(eq(eventClusters.id,post.clusterId)).get()
  if(!cluster)throw new Error('Missing event')
  const evidence=evidenceFor(cluster)
  if(!evidence || Date.now()-evidence.publishedAt>4*3600_000)throw new Error('Source is stale; find a fresh development')
  const { applyFreshness }=await import('./evidence')
  const { verifyDraft }=await import('./verify')
  let signals: Record<string,unknown>
  try{signals=JSON.parse(post.signals??'{}')}catch{signals={}}
  const text=applyFreshness((content??post.content).trim(),evidence,signals.lane==='urgent')
  if(text.length<20 || text.length>280)throw new Error('Draft must contain 20–280 characters')
  const verification=await verifyDraft(text,evidence)
  const current=db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()
  if (!current || current.updatedAt!==post.updatedAt || current.status!==post.status) throw new Error('Draft changed during verification. Reload and review the latest version.')
  db.update(generatedPosts).set({content:text,charCount:text.length,status:'pending',legalClearedAt:null,legalClearedBy:null,
    signals:JSON.stringify({...signals,evidence:{...evidence,text:undefined},verification}),updatedAt:Date.now()}).where(eq(generatedPosts.id,id)).run()
  return db.select().from(generatedPosts).where(eq(generatedPosts.id,id)).get()!
}
export function normalizePostUrl(value:string):string {
  const u=new URL(value)
  if(u.protocol!=='https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)
    || !/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/\d+$/.test(u.pathname) || u.username || u.password)throw new Error('Enter a valid https://x.com/.../status/... publication URL')
  return `https://x.com${u.pathname}`
}
