'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { GeneratedPost } from '@/types'

interface Props {
  post: GeneratedPost
  onApprove?: (id: string) => Promise<void>
  onReject?: (id: string, reason: string) => Promise<void>
  onArchive?: (id: string) => Promise<void>
  onCopyAndPost?: (id: string) => Promise<void>
  onContentSave?: (id: string, content: string) => Promise<void>
  showRejectDialog?: boolean
  onRejectDialogClose?: () => void
}

const MODE_STYLES: Record<string, { label: string; className: string }> = {
  pure_news:  { label: 'PURE NEWS',   className: 'bg-blue-100 text-blue-700' },
  news_odds:  { label: 'NEWS+ODDS',   className: 'bg-purple-100 text-purple-700' },
  engagement: { label: 'ENGAGEMENT',  className: 'bg-green-100 text-green-700' },
}

export function PostCard({ post, onApprove, onReject, onArchive, onCopyAndPost, onContentSave }: Props) {
  const [content, setContent] = useState(post.content)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState(false)

  const charCount = content.length
  const isOverLimit = charCount > 280
  const mode = MODE_STYLES[post.contentMode] ?? { label: post.contentMode.toUpperCase(), className: 'bg-gray-100 text-gray-700' }
  const risk = post.status

  async function handleBlur() {
    if (content === post.content || !onContentSave) return
    setSaving(true)
    try { await onContentSave(post.id, content) } finally { setSaving(false) }
  }

  async function handleApprove() {
    if (!onApprove) return
    setActing(true)
    try { await onApprove(post.id) } finally { setActing(false) }
  }

  async function handleArchive() {
    if (!onArchive) return
    setActing(true)
    try { await onArchive(post.id) } finally { setActing(false) }
  }

  async function handleCopyAndPost() {
    if (!onCopyAndPost) return
    setActing(true)
    try { await onCopyAndPost(post.id) } finally { setActing(false) }
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className={`text-xs font-bold px-2 py-1 rounded ${mode.className}`}>{mode.label}</span>
          {post.estimatedScore != null && (
            <span className="text-xs text-muted-foreground" title={post.scoreExplanation ?? ''}>
              Score: {post.estimatedScore}/10
            </span>
          )}
        </div>

        <Textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          onBlur={handleBlur}
          className="font-mono text-sm min-h-[100px]"
          disabled={post.status === 'posted'}
        />

        <div className="flex items-center justify-between">
          <span className={`text-xs ${isOverLimit ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
            {charCount}/280 characters {saving && '(saving…)'}
          </span>
        </div>

        {(post.status === 'pending' || post.status === 'approved') && (
          <>
            {post.rejectionReason && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">Rejected: {post.rejectionReason}</AlertDescription>
              </Alert>
            )}
          </>
        )}

        <div className="flex flex-wrap gap-2">
          {post.status === 'pending' && onApprove && (
            <Button size="sm" onClick={handleApprove} disabled={acting || isOverLimit}>Approve</Button>
          )}
          {post.status === 'approved' && onCopyAndPost && (
            <Button size="sm" onClick={handleCopyAndPost} disabled={acting}>Copy & Post to X</Button>
          )}
          {(post.status === 'pending' || post.status === 'approved') && onReject && (
            <RejectButton postId={post.id} onReject={onReject} />
          )}
          {post.status !== 'archived' && post.status !== 'posted' && onArchive && (
            <Button size="sm" variant="ghost" onClick={handleArchive} disabled={acting}>Archive</Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function RejectButton({ postId, onReject }: { postId: string; onReject: (id: string, reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (reason.trim().length < 5) return
    setSubmitting(true)
    try {
      await onReject(postId, reason.trim())
      setOpen(false)
      setReason('')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>Reject</Button>
    )
  }

  return (
    <div className="w-full space-y-2 border border-destructive/30 rounded-md p-3 bg-destructive/5">
      <p className="text-xs font-medium text-destructive">Reason for rejection (required)</p>
      <Textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Explain why this post is being rejected…"
        className="text-sm min-h-[60px]"
        autoFocus
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={reason.trim().length < 5 || submitting}
          onClick={handleSubmit}
        >
          {submitting ? 'Rejecting…' : 'Confirm Reject'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setReason('') }}>Cancel</Button>
      </div>
    </div>
  )
}
