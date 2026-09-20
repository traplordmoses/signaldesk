import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { recordReview, legalClear, approvalProblem } from '@/lib/editorial/review'
import {
  buildRejectReasons,
  updateGroupCard,
  updateReviewCardMode,
  buildReviewCard,
  sendApprovalDM,
  sendApprovalThreadReply,
  sendBotStatusToGroup,
} from './messages'

interface ActionValue {
  action: string
  postId?: string
  editedContent?: string
}

interface CallbackPayload {
  action: {
    value: ActionValue
  }
  operator: {
    open_id: string
    name?: string
  }
  context: {
    open_message_id: string
  }
}

/**
 * Audit-log a click as soon as it lands, before any downstream side effect.
 * If the approve/reject/save flow later throws, we still have an immutable
 * record of WHO clicked WHAT and WHEN — useful for postmortems and for
 * tracing if a "this post should never have gone out" question ever comes
 * up later. Captures both the human-readable name AND the open_id so we can
 * always identify the Lark user, regardless of name collisions or display
 * name changes.
 */
function logActionClick(
  actionType: string,
  operator: { open_id: string; name?: string },
  postId: string | undefined,
  clusterId: string | undefined,
): void {
  try {
    db.insert(auditLog).values({
      id: crypto.randomUUID(),
      eventType: `click_${actionType}`,
      entityType: postId ? 'generated_post' : 'system',
      entityId: postId ?? 'singleton',
      actor: operator.name ?? operator.open_id,
      details: JSON.stringify({
        operatorOpenId: operator.open_id,
        operatorName: operator.name ?? null,
        clusterId: clusterId ?? null,
      }),
      createdAt: Date.now(),
    }).run()
  } catch (e) {
    // Audit-log failure shouldn't kill the action — log it and continue.
    console.error(`audit log click write failed (${actionType}, post=${postId}):`, e)
  }
}

// Lark Schema 2.0 callback response. The legacy v1 `code` field is omitted
// from card-update responses — including it appears to make Lark's client
// interpret the response as v1 legacy and silently drop the `card` update.
export async function handleLarkCallback(payload: CallbackPayload): Promise<{
  code?: number
  toast?: { type: string; content: string }
  card?: { type: 'raw'; data: object }
}> {
  const { action, operator, context } = payload
  const { postId, action: actionType } = action.value
  const actorName = operator.name ?? operator.open_id
  const messageId = context.open_message_id

  // First thing we do on every click — record it. Captures the operator's
  // open_id even if downstream side effects later throw or no-op.
  logActionClick(actionType, operator, postId, undefined)

  // Pause / resume don't need a postId
  if (actionType === 'pause_bot' || actionType === 'resume_bot') {
    const paused = actionType === 'pause_bot'
    db.update(settings)
      .set({ larkEnabled: paused ? 0 : 1, updatedAt: Date.now() })
      .where(eq(settings.id, 'singleton'))
      .run()
    await sendBotStatusToGroup(paused)
    return {
      code: 0,
      toast: {
        type: paused ? 'info' : 'success',
        content: paused ? 'Bot paused. No more posts until you resume.' : 'Bot resumed!',
      },
    }
  }

  if (!postId) return { code: 1 }
  const post = db.select().from(generatedPosts).where(eq(generatedPosts.id, postId)).get()
  if (!post) return { code: 1 }

  const cluster = db.select().from(eventClusters).where(eq(eventClusters.id, post.clusterId)).get()
  if (!cluster) return { code: 1 }

  if (actionType === 'reject') return { card: { type: 'raw', data: buildRejectReasons(postId) } }
  if (actionType === 'legal_clear') {
    try {
      legalClear(postId, operator.open_id)
      const refreshed = db.select().from(generatedPosts).where(eq(generatedPosts.id, postId)).get()!
      const card = buildReviewCard(cluster, [refreshed])
      await updateReviewCardMode(messageId, cluster, [refreshed])
      return {toast:{type:'success',content:'Legal clearance recorded. Review and approve the draft.'},card:{type:'raw',data:card}}
    } catch(e) { return {toast:{type:'error',content:String(e)}} }
  }
  if (actionType.startsWith('reject_')) {
    try {
      const rejected=recordReview(postId,'rejected',actorName,actionType.slice(7))
      await updateGroupCard(messageId,cluster,rejected,actorName,false)
      return {toast:{type:'info',content:'Rejection reason saved.'}}
    } catch(e) {return {toast:{type:'error',content:String(e)}}}
  }
  if (actionType === 'approve') {
    const problem=approvalProblem(post,cluster.riskLevel)
    if(problem)return {toast:{type:'error',content:problem}}
    if(post.status==='publishing')return {toast:{type:'info',content:'Publishing already started. Record its X URL in the dashboard.'}}
  }

  // show_edit / cancel_edit — toggle the inline edit textbox without changing
  // any DB state. Returns the new card *inline* in the callback response —
  // Schema 2.0's preferred update mechanism. The earlier separate-PATCH-call
  // approach silently no-op'd in production: the API returned 200/code:0 but
  // Lark's client-side renderer doesn't always re-paint a patched card when
  // the structure changes (e.g. read-only → form). Inline `card.type: 'raw'`
  // forces a re-render atomically with the click.
  if (actionType === 'show_edit' || actionType === 'cancel_edit') {
    const clusterPosts = db.select()
      .from(generatedPosts)
      .where(eq(generatedPosts.clusterId, cluster.id))
      .all()
    const editingPostId = actionType === 'show_edit' ? postId : undefined

    // Two-pronged update:
    //   1. larkPatch (await) — replaces the message server-side. Critical
    //      for binding the buttons in the new card structure (the form +
    //      Save edit button) to live callbacks. Without this, the visual
    //      update happens but the buttons silently don't fire callbacks
    //      when clicked.
    //   2. inline `card.type:'raw'` response — gives immediate visual
    //      feedback so the reviewer doesn't see a render delay.
    try {
      await updateReviewCardMode(messageId, cluster, clusterPosts, editingPostId)
    } catch (err) {
      // Patch failure is non-fatal — the inline response will still update
      // visually, just buttons in the new state may not fire. Log so we can
      // diagnose if save_edit goes silent again.
      console.error(`[lark callback] ${actionType} patchCard failed (non-fatal):`, (err as Error).message)
    }

    const card = buildReviewCard(cluster, clusterPosts, { editingPostId })
    const response = {
      toast: { type: 'info', content: actionType === 'show_edit' ? 'Editing…' : 'Edit cancelled' },
      card: { type: 'raw' as const, data: card },
    }
    console.log(`[lark callback] ${actionType} → patched + returning inline card update`, {
      postId,
      hasForm: actionType === 'show_edit',
    })
    return response
  }

  if (actionType === 'approve') {
    try {
      const approved = recordReview(postId, 'approved', actorName)
      // Card patch failure must not swallow the publishing handoff.
      try { await updateGroupCard(messageId, cluster, approved, actorName, true) }
      catch (e) { console.error('[review] approval card patch failed', String(e)) }
      try {
        await sendApprovalDM(operator.open_id, approved)
        return {toast:{type:'success',content:'Approved. Check your DMs, then record the X post URL in the dashboard.'}}
      } catch {
        await sendApprovalThreadReply(messageId, approved)
        return {toast:{type:'success',content:'Approved. Open the thread reply to publish.'}}
      }
    } catch (e) {
      console.error('[review] approval handoff failed', String(e))
      return {toast:{type:'error',content:'Publishing handoff failed. Click Approve again to retry.'}}
    }
  }

  // save_edit — submitted by the inline form on the review card. The route's
  // extractFormString pulls form_value.edited_content into action.value.editedContent
  // before this handler runs, so all we do here is validate, persist, and patch
  // the visible card.
  if (actionType === 'save_edit') return {toast:{type:'error',content:'Use the review dashboard to edit and verify this draft.'}}

  return { code: 0 }
}
