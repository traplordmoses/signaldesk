export const dynamic='force-dynamic'
import { NextResponse } from 'next/server'
import { sqlite } from '@/lib/db'
export async function GET() {
  const now=Date.now()
  const outcomes=sqlite.prepare('SELECT status,COUNT(*) count FROM generated_posts WHERE created_at>? GROUP BY status').all(now-7*86400_000)
  const timings=sqlite.prepare(`SELECT p.created_at,p.lark_sent_at,json_extract(p.signals,'$.evidence.ingestedAt') ingested_at
    FROM generated_posts p WHERE p.created_at>? AND json_valid(p.signals)`).all(now-7*86400_000) as {created_at:number;lark_sent_at:number|null;ingested_at:number|null}[]
  const quantile=(xs:number[],q:number)=>xs.length?Math.round(xs.sort((a,b)=>a-b)[Math.floor((xs.length-1)*q)]):null
  const ingress=timings.filter(p=>p.ingested_at).map(p=>(p.created_at-p.ingested_at!)/1000)
  const review=sqlite.prepare(`SELECT MIN(a.created_at)-p.created_at elapsed FROM audit_log a JOIN generated_posts p ON p.id=a.entity_id
    WHERE a.event_type='post_approved' AND p.created_at>? GROUP BY p.id`).all(now-7*86400_000) as {elapsed:number}[]
  return NextResponse.json({windowDays:7,outcomes,
    latencySeconds:{ingestToDraftP50:quantile(ingress,.5),ingestToDraftP95:quantile(ingress,.95),draftToApprovalP50:quantile(review.map(r=>r.elapsed/1000),.5)},
    rejectionReasons:sqlite.prepare("SELECT rejection_reason reason,COUNT(*) count FROM generated_posts WHERE status='rejected' AND created_at>? GROUP BY rejection_reason").all(now-7*86400_000),
    outbox:sqlite.prepare('SELECT state,COUNT(*) count FROM delivery_outbox GROUP BY state').all(),
    jobs:sqlite.prepare('SELECT state,COUNT(*) count FROM generation_jobs GROUP BY state').all(),
    heartbeat:sqlite.prepare('SELECT * FROM newsroom_heartbeat').all(),
    sources:sqlite.prepare('SELECT name,last_error,last_fetched_at FROM news_sources WHERE is_active=1 AND last_error IS NOT NULL').all(),
    integrations:{problyFeed:!!process.env.PROBLY_MARKET_FEED_URL,xStream:!!process.env.X_BEARER_TOKEN&&!!process.env.X_NEWS_AUTHOR_IDS},
  })
}
