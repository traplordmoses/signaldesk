import { describe,it,expect,beforeAll,vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db,sqlite } from '@/lib/db'
import { migrateNewsroom } from '@/lib/db/newsroom'
import { checkFactualSupport,freshnessLabel,applyFreshness,type Evidence } from './evidence'
import { laneFor,routineDue } from './priority'
import { approvalProblem,contentHash,normalizePostUrl } from './review'
import { claimDelivery } from '@/lib/lark/outbox'
import { claimGeneration } from '@/lib/cron/scheduler'
import { parseMarketFeed } from '@/lib/markets/feed'
import { independentHits,PROBLY_MARKETS_DDL,PROBLY_ALIASES_DDL,resetProblyCache,problyMarketFor } from '@/lib/markets/probly'
import type { GeneratedPost } from '@/types'
import { materialChange } from '@/lib/news/updates'

beforeAll(()=>{migrate(db,{migrationsFolder:'./drizzle'});migrateNewsroom(sqlite)})
const now=Date.now()
const evidence:Evidence={headline:'Club confirms striker ruled out',text:'Club confirms striker ruled out',publishedAt:now-60_000,ingestedAt:now,source:'Club',url:'https://club.example/news',timestampKnown:true,primary:true}

describe('freshness and evidence',()=>{
  it('uses publication age and unknown timestamps cannot become breaking',()=>{
    expect(freshnessLabel({...evidence,publishedAt:now-3*3600_000},true,now)).toBe('UPDATE')
    expect(freshnessLabel({...evidence,timestampKnown:false},true,now)).toBe('UPDATE')
    expect(freshnessLabel(evidence,true,now)).toBe('BREAKING')
  })
  it('rejects the unsupported year found in production',()=>{
    expect(()=>checkFactualSupport('Zidane succeeds Deschamps after the 2024 World Cup cycle.', 'Zidane may be the next France manager.')).toThrow('unsupported numeric')
  })
  it('allows supported numbers but preserves uncertainty',()=>{
    expect(()=>checkFactualSupport('The rate is 4.5%.','The rate is 4.5%.')).not.toThrow()
    expect(()=>checkFactualSupport('The minister resigns.','The minister reportedly resigns.')).toThrow('uncertainty')
  })
  it('urgent budget eligibility needs a fresh material signal and market or primary source',()=>{
    expect(laneFor(evidence,false,'low',now)).toBe('urgent')
    expect(laneFor({...evidence,publishedAt:now-20*60_000},true,'low',now)).toBe('routine')
    expect(laneFor(evidence,true,'high',now)).toBe('routine')
    expect(laneFor({...evidence,headline:'Club could confirm new striker'},true,'low',now)).toBe('routine')
  })
  it('routine cooldown becomes due without waiting another five-minute tick',()=>{
    expect(routineDue(now-15*60_000+1,15,now)).toBe(false)
    expect(routineDue(now-15*60_000-1,15,now)).toBe(true)
  })
})

describe('durable jobs',()=>{
  it('delivery leases prevent duplicate workers and allow crash recovery',()=>{
    sqlite.prepare('INSERT INTO delivery_outbox(post_id,available_at,created_at) VALUES (?,?,?)').run('test-post',now,now)
    expect(claimDelivery(now)).toBe('test-post')
    expect(claimDelivery(now+1)).toBeNull()
    expect(claimDelivery(now+120_001)).toBe('test-post')
  })
  it('generation leases serialize one event and recover after a restart',()=>{
    expect(claimGeneration('test-cluster',now)).toBe(true)
    expect(claimGeneration('test-cluster',now+1)).toBe(false)
    expect(claimGeneration('test-cluster',now+180_001)).toBe(true)
  })
})

describe('review integrity',()=>{
  const content='🟣 JUST IN: Club confirms striker ruled out.'
  const post={status:'pending',content,signals:JSON.stringify({evidence,verification:{supported:true,contentHash:contentHash(content)},lane:'routine'})} as GeneratedPost
  it('prevents stale or unverified approval and checks the exact reviewed text',()=>{
    expect(approvalProblem(post,'low',now)).toBeNull()
    expect(approvalProblem({...post,content:'Changed claim'},'low',now)).toContain('verification')
    expect(approvalProblem(post,'low',now+5*3600_000)).toContain('four hours')
    expect(approvalProblem(post,'high',now)).toContain('legal')
    expect(approvalProblem({...post,legalClearedAt:now},'high',now)).toBeNull()
  })
  it('requires a concrete X status URL',()=>{
    expect(normalizePostUrl('https://twitter.com/ProblyHQ/status/123456?s=20')).toBe('https://x.com/ProblyHQ/status/123456')
    expect(()=>normalizePostUrl('https://x.com.evil.example/ProblyHQ/status/123456')).toThrow()
    expect(()=>normalizePostUrl('https://x.com/ProblyHQ')).toThrow()
  })
  it('recognizes a confirmed development following speculation',()=>{
    expect(materialChange('Senate approves the Clarity Act','Senate may vote on Clarity Act')).toBe(true)
    expect(materialChange('Senate approves the Clarity Act','Senate approves the Clarity Act')).toBe(false)
  })
})

describe('production market regressions',()=>{
  beforeAll(()=>{
    sqlite.exec(PROBLY_MARKETS_DDL);sqlite.exec(PROBLY_ALIASES_DDL)
    const market=(slug:string,event:string,q:string,cat:string,liq=1000)=>sqlite.prepare('INSERT INTO probly_markets VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(slug,event,q,cat,cat==='sports'?'Premier League':null,.5,liq,now+2*86400_000,`https://www.probly.com/en/event/${event}`,now)
    const alias=(subject:string,kind:string,names:string[])=>sqlite.prepare('INSERT INTO probly_aliases VALUES (?,?,?,?)').run(subject,kind,JSON.stringify(names),now)
    const day=new Date(now+86400_000).toISOString().slice(0,10)
    const trump='Will Donald Trump post 100-119 Truth Social posts this week?'
    market('trump-posts','trump-posts',trump,'politics');alias(trump,'market',['donald trump','trump','truth social'])
    market('liv',`epl-liv-${day}`,`Will Liverpool FC win on ${day}?`,'sports');alias('Liverpool FC','subject',['liverpool','liverpool fc'])
    market('pal',`epl-lee-pal-${day}`,'Leeds United FC vs. Crystal Palace FC: O/U 2.5','sports',100000)
    alias('Leeds United FC','subject',['leeds united','leeds']);alias('Crystal Palace FC','subject',['crystal palace','palace'])
    market('ars',`epl-ars-che-${day}`,'Arsenal FC vs. Chelsea FC','sports')
    alias('Arsenal FC','subject',['arsenal']);alias('Chelsea FC','subject',['chelsea'])
    resetProblyCache()
  })
  it('Donald Trump and Trump count as one identity',()=>{
    expect(independentHits('donald trump signs election legislation',['donald trump','trump','truth social'])).toEqual(['donald trump'])
    expect(problyMarketFor('Newsom signs election laws','Donald Trump opposed the measures.','politics')).toBeNull()
    expect(problyMarketFor('Donald Trump posts on Truth Social','','politics')).not.toBeNull()
  })
  it('Liverpool the city in a sports summary is not Liverpool FC',()=>{
    expect(problyMarketFor('Everton and Ipswich pay tribute','The match was in Liverpool.','sports')).toBeNull()
  })
  it('a Palace result cannot select Leeds-Palace totals',()=>{
    expect(problyMarketFor('Crystal Palace won against Lech Poznan','','sports')).toBeNull()
  })
  it('both teams can identify the correct upcoming fixture',()=>{
    expect(problyMarketFor('Arsenal and Chelsea confirm lineups','','sports')?.matchType).toBe('direct')
  })
  it('one-team availability news is explicitly contextual',()=>{
    expect(problyMarketFor('Arsenal striker ruled out','','sports')?.matchType).toBe('contextual')
  })
  it('old catalogue data abstains',()=>{
    sqlite.prepare('UPDATE probly_markets SET fetched_at=?').run(now-3*3600_000);resetProblyCache()
    expect(problyMarketFor('Arsenal and Chelsea confirm lineups','','sports')).toBeNull()
  })
})

describe('live feed boundaries',()=>{
  const row={slug:'test',eventSlug:'test-event',question:'Will the event occur this week?',category:'politics',priceYes:.6,bid:.59,ask:.61,liquidity:20000,observedAt:now,endMs:now+86400_000}
  it('validates fresh quotes and constructs a canonical Probly URL',()=>{
    expect(parseMarketFeed({markets:[row]},now)[0].url).toBe('https://www.probly.com/en/event/test-event')
    expect(()=>parseMarketFeed({markets:[{...row,observedAt:now-120_000}]},now)).toThrow('stale')
    expect(()=>parseMarketFeed({markets:[{...row,bid:.9,ask:.1}]},now)).toThrow()
    expect(()=>parseMarketFeed({markets:[row,row]},now)).toThrow()
  })
})
