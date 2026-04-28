'use client'

import { useEffect, useState, useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PostCard } from '@/components/posts/PostCard'
import { Skeleton } from '@/components/ui/skeleton'
import type { GeneratedPost } from '@/types'

const TABS = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'posted',   label: 'Posted' },
  { value: 'rejected', label: 'Rejected' },
]

export default function ReviewPage() {
  const [tab, setTab] = useState('pending')
  const [posts, setPosts] = useState<GeneratedPost[]>([])
  const [loading, setLoading] = useState(true)

  const loadPosts = useCallback(async (status: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/posts?status=${status}&limit=50`)
      const data = await res.json() as { posts: GeneratedPost[] }
      setPosts(data.posts ?? [])
    } catch (e) {
      console.error(`loadPosts failed (status=${status}):`, e)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadPosts(tab) }, [tab, loadPosts])

  async function handleApprove(id: string) {
    await fetch(`/api/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', reviewed_by: 'web' }),
    })
    await loadPosts(tab)
  }

  async function handleReject(id: string, reason: string) {
    await fetch(`/api/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', rejection_reason: reason, reviewed_by: 'web' }),
    })
    await loadPosts(tab)
  }

  async function handleArchive(id: string) {
    await fetch(`/api/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    })
    await loadPosts(tab)
  }

  async function handleContentSave(id: string, content: string) {
    await fetch(`/api/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  }

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
      console.error(`copy/post failed (post=${id}):`, e)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Review Queue</h1>
        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">← Dashboard</a>
      </div>

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
                  onApprove={t.value === 'pending' ? handleApprove : undefined}
                  onReject={t.value === 'pending' || t.value === 'approved' ? handleReject : undefined}
                  onArchive={t.value !== 'posted' ? handleArchive : undefined}
                  onCopyAndPost={t.value === 'approved' ? handleCopyAndPost : undefined}
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
