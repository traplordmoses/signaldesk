'use client'

import { useEffect, useState, useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PostCard } from '@/components/posts/PostCard'
import { Skeleton } from '@/components/ui/skeleton'
import type { GeneratedPost } from '@/types'

const TABS = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'publishing', label: 'Publishing' },
  { value: 'expired', label: 'Expired' },
  { value: 'posted',   label: 'Posted' },
  { value: 'rejected', label: 'Rejected' },
]

export default function ReviewPage() {
  const [tab, setTab] = useState('pending')
  const [posts, setPosts] = useState<GeneratedPost[]>([])
  const [error,setError]=useState('')
  const [metrics,setMetrics]=useState<{outcomes:{status:string;count:number}[];latencySeconds:{ingestToDraftP50:number|null;draftToApprovalP50:number|null}}|null>(null)
  const [loading, setLoading] = useState(true)

  const loadPosts = useCallback(async (status: string, background = false) => {
    if (!background) setLoading(true)
    try {
      const res = await fetch(`/api/posts?status=${status}&limit=50`)
      const data = await res.json() as { posts: GeneratedPost[] }
      setPosts(data.posts ?? [])
    } catch (e) {
      console.error(`loadPosts failed (status=${status}):`, e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadPosts(tab); fetch('/api/newsroom').then(r=>r.ok?r.json():null).then(setMetrics).catch(()=>{}); const timer=setInterval(()=>{if (!['TEXTAREA','INPUT','SELECT'].includes(document.activeElement?.tagName??'')) void loadPosts(tab,true)},30_000);return()=>clearInterval(timer) }, [tab, loadPosts])

  async function updatePost(id:string,body:object) {
    setError('')
    const res=await fetch(`/api/posts/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    if(!res.ok){const data=await res.json();setError(data.error??'Update failed');return}
    await loadPosts(tab)
  }

  async function handleApprove(id:string) { await updatePost(id,{status:'approved'}) }
  async function handleReject(id:string,reason:string) { await updatePost(id,{status:'rejected',rejection_reason:reason}) }
  async function handleArchive(id:string) { await updatePost(id,{status:'archived'}) }
  async function handleContentSave(id:string,content:string) { await updatePost(id,{content}) }

  async function handleCopyAndPost(id: string) {
    const postWindow = window.open('', '_blank')
    try {
      const res = await fetch(`/api/posts/${id}/publish`, { method: 'POST' })
      const data = await res.json() as { intentUrl?: string; error?: string }
      if (!res.ok || !data.intentUrl) throw new Error(data.error ?? 'Publish request failed')
      if (postWindow) {
        postWindow.location.href = data.intentUrl
      } else {
        window.location.href = data.intentUrl
      }
      await loadPosts(tab)
    } catch (e) {
      postWindow?.close()
      setError(e instanceof Error?e.message:String(e))
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Review Queue</h1>
        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">← Dashboard</a>
      </div>

      {error&&<p role="alert" className="text-red-600">{error}</p>}
      {metrics&&<div className="rounded border p-3 text-sm">Last 7 days · {metrics.outcomes.map(o=>`${o.count} ${o.status}`).join(' · ')}<br/>
        Median ingest → draft: {metrics.latencySeconds.ingestToDraftP50==null?'—':Math.round(metrics.latencySeconds.ingestToDraftP50/60)+'m'} · Median draft → approval: {metrics.latencySeconds.draftToApprovalP50==null?'—':Math.round(metrics.latencySeconds.draftToApprovalP50/60)+'m'}
      </div>}
      <Tabs value={tab} onValueChange={v => { setTab(v); setPosts([]) }}>
        <TabsList>
          {TABS.map(t => (
            <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        {TABS.map(t => (
          <TabsContent key={t.value} value={t.value} className="space-y-4 mt-4">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)
            ) : posts.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">No {t.label.toLowerCase()} posts.</p>
            ) : (
              posts.map(post => (
                <PostCard
                  key={post.id}
                  post={post}
                  onChanged={()=>{void loadPosts(tab)}}
                  onApprove={t.value === 'pending' ? handleApprove : undefined}
                  onReject={t.value === 'pending' || t.value === 'approved' ? handleReject : undefined}
                  onArchive={t.value !== 'posted' ? handleArchive : undefined}
                  onCopyAndPost={['approved','publishing'].includes(t.value) ? handleCopyAndPost : undefined}
                  onContentSave={t.value !== 'posted' ? handleContentSave : undefined}
                />
              ))
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
