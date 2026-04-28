'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { ClusterWithPosts } from '@/app/page'

interface Props {
  clusters: ClusterWithPosts[]
  loading?: boolean
  onGenerate: (clusterId: string) => Promise<void>
  onApprove: (postId: string) => Promise<void>
  onReject: (postId: string, reason: string) => Promise<void>
  onCopyAndPost: (postId: string) => Promise<void>
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function getPriority(score: number) {
  if (score >= 8) return { label: 'Urgent', emoji: '🔴', leftBorder: 'border-l-red-500', scoreBg: 'bg-red-500', scoreText: 'text-white', badgeBg: 'bg-red-100', badgeText: 'text-red-700' }
  if (score >= 6) return { label: 'Important', emoji: '🟠', leftBorder: 'border-l-orange-400', scoreBg: 'bg-orange-400', scoreText: 'text-white', badgeBg: 'bg-orange-100', badgeText: 'text-orange-700' }
  if (score >= 4) return { label: 'Watch', emoji: '🟡', leftBorder: 'border-l-yellow-400', scoreBg: 'bg-yellow-400', scoreText: 'text-white', badgeBg: 'bg-yellow-50', badgeText: 'text-yellow-700' }
  return { label: 'Normal', emoji: '⚪', leftBorder: 'border-l-slate-200', scoreBg: 'bg-slate-200', scoreText: 'text-slate-600', badgeBg: 'bg-slate-100', badgeText: 'text-slate-500' }
}

const MODE_LABELS: Record<string, string> = {
  pure_news: '⚡ Breaking',
  news_odds: '📊 News + Odds',
  engagement: '💬 Engagement',
}

const CATEGORY_LABELS: Record<string, string> = {
  politics: '🏛 Politics', economics: '📈 Economics', crypto: '🪙 Crypto',
  sports: '⚽ Sports', tech: '💻 Tech', culture: '🎭 Culture',
}

const TAG_LABELS: Record<string, string> = {
  '🇺🇸 美国': '🇺🇸 United States',
  '🇨🇳 中国': '🇨🇳 China',
  '🇷🇺 俄罗斯': '🇷🇺 Russia',
  '🇺🇦 乌克兰': '🇺🇦 Ukraine',
  '🇮🇷 伊朗': '🇮🇷 Iran',
  '🇮🇱 以色列': '🇮🇱 Israel',
  '🇪🇺 欧盟': '🇪🇺 European Union',
  '🇬🇧 英国': '🇬🇧 United Kingdom',
  '🌏 中东': '🌏 Middle East',
  '🇩🇪 德国': '🇩🇪 Germany',
  '🇯🇵 日本': '🇯🇵 Japan',
  '🇰🇷 韩国': '🇰🇷 South Korea',
  '🗳 选举': '🗳 Elections',
  '💰 利率/央行': '💰 Rates/Central Banks',
  '💥 军事/冲突': '💥 Military/Conflict',
  '⚖️ 制裁/法律': '⚖️ Sanctions/Legal',
  '🪙 加密': '🪙 Crypto',
  '📊 宏观经济': '📊 Macro',
  '🛢 能源': '🛢 Energy',
  '🎵 娱乐': '🎵 Entertainment',
  '🏆 体育': '🏆 Sports',
  '🏥 健康/医疗': '🏥 Health/Medical',
  '🌍 气候': '🌍 Climate',
}

function englishTag(tag: string): string {
  return TAG_LABELS[tag] ?? tag
}

function RejectInline({ postId, onReject }: { postId: string; onReject: (id: string, reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!open) return (
    <button onClick={() => setOpen(true)} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors">
      ❌ Reject
    </button>
  )

  return (
    <div className="mt-2 space-y-2">
      <Textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Rejection reason (required)…"
        className="text-xs min-h-[50px] bg-white"
        autoFocus
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          className="h-6 text-xs"
          disabled={reason.trim().length < 5 || submitting}
          onClick={async () => {
            setSubmitting(true)
            await onReject(postId, reason.trim())
            setOpen(false)
            setReason('')
            setSubmitting(false)
          }}
        >Confirm reject</Button>
        <button onClick={() => { setOpen(false); setReason('') }} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
      </div>
    </div>
  )
}

export function EventFeed({ clusters, loading, onGenerate, onApprove, onReject, onCopyAndPost }: Props) {
  const [generating, setGenerating] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [acting, setActing] = useState<Set<string>>(new Set())

  async function handleGenerate(id: string) {
    setGenerating(prev => new Set(prev).add(id))
    try { await onGenerate(id) }
    finally { setGenerating(prev => { const s = new Set(prev); s.delete(id); return s }) }
  }

  async function handleApprove(postId: string) {
    setActing(prev => new Set(prev).add(postId))
    try { await onApprove(postId) }
    finally { setActing(prev => { const s = new Set(prev); s.delete(postId); return s }) }
  }

  async function handleCopyAndPost(postId: string) {
    setActing(prev => new Set(prev).add(postId))
    try { await onCopyAndPost(postId) }
    finally { setActing(prev => { const s = new Set(prev); s.delete(postId); return s }) }
  }

  if (loading) return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
    </div>
  )

  if (clusters.length === 0) return (
    <div className="text-center py-12 text-slate-500 text-sm">No events yet. Click “Fetch News Now” to start.</div>
  )

  const critical = clusters.filter(c => (c.relevanceScore ?? 0) >= 8)
  const high     = clusters.filter(c => (c.relevanceScore ?? 0) >= 6 && (c.relevanceScore ?? 0) < 8)
  const rest     = clusters.filter(c => (c.relevanceScore ?? 0) < 6)

  function ClusterCard({ c }: { c: ClusterWithPosts }) {
    const score = c.relevanceScore ?? 0
    const p = getPriority(score)
    const pendingPosts = (c.posts ?? []).filter(post => post.status === 'pending')
    const approvedPosts = (c.posts ?? []).filter(post => post.status === 'approved')
    const hasPosts = (c.postCount ?? 0) > 0
    const isExpanded = expanded.has(c.id)
    const topicsArr: string[] = (() => { try { return JSON.parse(c.topics ?? '[]') } catch { return [] } })()

    return (
      <div className={`bg-white rounded-lg shadow-sm border border-slate-200 border-l-4 ${p.leftBorder} overflow-hidden`}>
        {/* Cluster header */}
        <div className="px-4 py-3 flex items-start gap-3">
          <div className={`${p.scoreBg} ${p.scoreText} rounded-md px-2 py-1 text-xs font-bold tabular-nums shrink-0 min-w-[2.5rem] text-center mt-0.5`}>
            {score.toFixed(1)}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 leading-snug">{c.canonicalHeadline}</p>

            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{CATEGORY_LABELS[c.category] ?? c.category}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${p.badgeBg} ${p.badgeText}`}>{p.emoji} {p.label}</span>
              {topicsArr.map(tag => (
                <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">{englishTag(tag)}</span>
              ))}
              {c.riskLevel === 'high' && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">⚠️ High risk</span>}
              {c.riskLevel === 'medium' && <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-semibold">⚠️ Medium risk</span>}
              {(c.sourceCount ?? 1) > 1 && <span className="text-xs text-slate-400">{c.sourceCount} sources</span>}
              <span className="text-xs text-slate-400">{timeAgo(c.lastUpdatedAt)}</span>
            </div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1">
            {!hasPosts ? (
              <Button size="sm" variant="outline" className="text-xs h-7 border-slate-300" disabled={generating.has(c.id)} onClick={() => handleGenerate(c.id)}>
                {generating.has(c.id) ? 'Generating…' : 'Generate posts'}
              </Button>
            ) : (
              <button
                onClick={() => setExpanded(prev => { const s = new Set(prev); s.has(c.id) ? s.delete(c.id) : s.add(c.id); return s })}
                className="text-xs font-semibold px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
              >
                {pendingPosts.length > 0 ? `📝 ${pendingPosts.length} pending` : approvedPosts.length > 0 ? `✓ ${approvedPosts.length} approved` : `✓ ${c.postCount} posts`}
                <span className="ml-1">{isExpanded ? '▲' : '▼'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Inline post preview */}
        {isExpanded && (c.posts ?? []).length > 0 && (
          <div className="border-t border-slate-100 divide-y divide-slate-100">
            {(c.posts ?? []).map(post => (
              <div key={post.id} className="px-4 py-3 bg-slate-50">
                {/* Mode + score */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-500">{MODE_LABELS[post.contentMode] ?? post.contentMode}</span>
                  {post.estimatedScore != null && (
                    <span className="text-xs text-slate-400" title={post.scoreExplanation ?? ''}>{post.estimatedScore}/10</span>
                  )}
                </div>

                {/* Tweet content — clear, readable */}
                <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 font-sans text-[15px] leading-relaxed text-slate-900 whitespace-pre-wrap tracking-normal shadow-sm">
                  {post.content}
                </div>

                <div className="flex items-center justify-between mt-2">
                  <span className={`text-xs ${post.charCount > 280 ? 'text-red-500 font-semibold' : 'text-slate-400'}`}>
                    {post.charCount}/280
                  </span>

                  {post.status === 'pending' && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleApprove(post.id)}
                        disabled={acting.has(post.id)}
                        className="text-xs font-semibold px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                      >
                        ✅ Approve
                      </button>
                      <RejectInline postId={post.id} onReject={onReject} />
                    </div>
                  )}

                  {post.status === 'approved' && (
                    <button
                      onClick={() => handleCopyAndPost(post.id)}
                      disabled={acting.has(post.id)}
                      className="text-xs font-semibold px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      🐦 Post to X
                    </button>
                  )}

                  {post.status === 'rejected' && (
                    <span className="text-xs text-slate-400 italic">Rejected</span>
                  )}
                </div>

                {post.status === 'pending' && <RejectInline postId={post.id} onReject={onReject} />}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  function Section({ title, color, divider, items }: { title: string; color: string; divider: string; items: ClusterWithPosts[] }) {
    if (items.length === 0) return null
    return (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs font-bold uppercase tracking-widest ${color}`}>{title}</span>
          <div className={`flex-1 h-px ${divider}`} />
          <span className={`text-xs ${color} opacity-60`}>{items.length} items</span>
        </div>
        <div className="space-y-2">{items.map(c => <ClusterCard key={c.id} c={c} />)}</div>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      <Section title="🔴 Urgent" color="text-red-600" divider="bg-red-200" items={critical} />
      <Section title="🟠 Important" color="text-orange-500" divider="bg-orange-200" items={high} />
      <Section title="Other" color="text-slate-400" divider="bg-slate-200" items={rest} />
    </div>
  )
}
