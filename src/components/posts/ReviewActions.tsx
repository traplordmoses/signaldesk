'use client'
import { useState } from 'react'
import type { GeneratedPost } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ReviewActions({post,onChanged}:{post:GeneratedPost;onChanged:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState(''),[reply,setReply]=useState('')
  const act=async(path:string,body:object,method='POST')=>{
    setBusy(true);setError('')
    try{
      const res=await fetch(`/api/posts/${post.id}${path}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      const data=await res.json();if(!res.ok)throw new Error(data.error??'Request failed')
      if(data.content && path==='/market-reply')setReply(data.content)
      else if(data.intentUrl)window.open(data.intentUrl,'_blank','noopener,noreferrer')
      else onChanged()
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  let signals:{lane?:string;evidence?:{url:string;source:string;publishedAt:number};probly?:{question:string;url:string;matchReason?:string}}
  try{signals=JSON.parse(post.signals??'{}')}catch{signals={}}
  return <div className="space-y-3 text-sm">
    {signals.lane==='urgent'&&<p className="font-semibold text-orange-700">Urgent development</p>}
    {signals.evidence&&<p><a href={signals.evidence.url} target="_blank" rel="noreferrer" className="underline">{signals.evidence.source}</a> · Published {new Date(signals.evidence.publishedAt).toLocaleString()}</p>}
    {signals.probly&&<p><a href={signals.probly.url} className="underline" target="_blank" rel="noreferrer">{signals.probly.question}</a><br/>{signals.probly.matchReason}</p>}
    {post.status==='pending'&&<div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>act('',{refresh:true},'PATCH')}>Refresh & verify</Button>
      {!post.legalClearedAt&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>{if(window.confirm('Confirm that legal has cleared this exact draft. Your attestation will be recorded.'))void act('',{legal_clear:true},'PATCH')}}>Record legal clearance</Button>}
    </div>}
    {['approved','publishing'].includes(post.status??'')&&<div className="space-y-2">
      <label htmlFor={`url-${post.id}`}>After publishing, paste the X post URL</label>
      <Input id={`url-${post.id}`} value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://x.com/ProblyHQ/status/…"/>
      <Button size="sm" disabled={busy||!url} onClick={()=>act('/publish',{published_url:url})}>Confirm published</Button>
    </div>}
    {['approved','publishing','posted'].includes(post.status??'')&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>act('/market-reply',{action:'prepare'})}>Prepare optional market reply</Button>}
    {reply&&<div className="rounded border p-3 space-y-2"><p className="whitespace-pre-wrap">{reply}</p><Button size="sm" disabled={busy} onClick={()=>act('/market-reply',{action:'approve'})}>Approve reply & open X</Button></div>}
    {post.publishedUrl&&<a className="underline block" href={post.publishedUrl} target="_blank" rel="noreferrer">View published post</a>}
    {error&&<p role="alert" className="text-red-600">{error}</p>}
  </div>
}
