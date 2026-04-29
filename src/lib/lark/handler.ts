import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  updateGroupCard,
  updateReviewCardMode,
  buildReviewCard,
  sendApprovalDM,
  sendApprovalThreadReply,
  sendBotStatusToGroup,
} from './messages'

interface ActionValue {
  action: 'approve' | 'reject' | 'save_edit' | 'show_edit' | 'cancel_edit' | 'pause_bot' | 'resume_bot'
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
    let landedIn: 'dm' | 'thread' | 'none' = 'none'
    try {
      db.update(generatedPosts)
        .set({ status: 'approved', reviewedBy: actorName, updatedAt: Date.now() })
        .where(eq(generatedPosts.id, postId))
        .run()

      await updateGroupCard(messageId, cluster, post, actorName, true)

      try {
        await sendApprovalDM(operator.open_id, post)
        landedIn = 'dm'
      } catch (dmErr) {
        console.warn(`approval DM failed (post=${postId}): ${(dmErr as Error).message} — falling back to thread reply`)
        try {
          db.insert(auditLog).values({
            id: crypto.randomUUID(),
            eventType: 'fallback',
            entityType: 'generated_post',
            entityId: postId,
            errorCode: 'APPROVE_DM_FALLBACK',
            errorMessage: (dmErr as Error).message,
            createdAt: Date.now(),
          }).run()
        } catch (e) {
          console.error(`audit log write failed (approve fallback, post=${postId}):`, e)
        }
        await sendApprovalThreadReply(messageId, post)
        landedIn = 'thread'
      }

      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_approved',
        entityType: 'generated_post',
        entityId: postId,
        actor: actorName,
        details: JSON.stringify({
          clusterId: cluster.id,
          landedIn,
          operatorOpenId: operator.open_id,
          operatorName: operator.name ?? null,
        }),
        createdAt: Date.now(),
      }).run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'error',
        entityType: 'generated_post',
        entityId: postId,
        errorCode: 'APPROVE_FAILED',
        errorMessage: msg,
        createdAt: Date.now(),
      }).run()
    }

    const toastContent =
      landedIn === 'thread' ? 'Post approved! Open the thread reply to publish.'
      : landedIn === 'dm'   ? 'Post approved! Check your DMs.'
      :                       'Post approved!'
    return { code: 0, toast: { type: 'success', content: toastContent } }
  }

  if (actionType === 'reject') {
    try {
      db.update(generatedPosts)
        .set({ status: 'rejected', reviewedBy: actorName, updatedAt: Date.now() })
        .where(eq(generatedPosts.id, postId))
        .run()

      await updateGroupCard(messageId, cluster, post, actorName, false)

      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_rejected',
        entityType: 'generated_post',
        entityId: postId,
        actor: actorName,
        details: JSON.stringify({
          clusterId: cluster.id,
          operatorOpenId: operator.open_id,
          operatorName: operator.name ?? null,
        }),
        createdAt: Date.now(),
      }).run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'error',
        entityType: 'generated_post',
        entityId: postId,
        errorCode: 'REJECT_FAILED',
        errorMessage: msg,
        createdAt: Date.now(),
      }).run()
    }

    return { code: 0, toast: { type: 'info', content: 'Post rejected.' } }
  }

  // save_edit — submitted by the inline form on the review card. The route's
  // extractFormString pulls form_value.edited_content into action.value.editedContent
  // before this handler runs, so all we do here is validate, persist, and patch
  // the visible card.
  if (actionType === 'save_edit') {
    const editedContent = action.value.editedContent?.trim()
    if (!editedContent) {
      return { code: 1, toast: { type: 'error', content: 'Edited text cannot be empty.' } }
    }
    if (editedContent.length > 280) {
      return { code: 1, toast: { type: 'error', content: `Edited text is ${editedContent.length}/280 characters.` } }
    }
    if (editedContent === post.content) {
      return { code: 0, toast: { type: 'info', content: 'No changes to save.' } }
    }

    try {
      db.update(generatedPosts)
        .set({
          content: editedContent,
          charCount: editedContent.length,
          reviewedBy: actorName,
          updatedAt: Date.now(),
        })
        .where(eq(generatedPosts.id, postId))
        .run()

      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_edited',
        entityType: 'generated_post',
        entityId: postId,
        actor: actorName,
        details: JSON.stringify({
          clusterId: cluster.id,
          charCount: editedContent.length,
          operatorOpenId: operator.open_id,
          operatorName: operator.name ?? null,
        }),
        createdAt: Date.now(),
      }).run()

      // Two-pronged update: patchCard server-side (so the Approve button
      // in the post-save read-only card is properly bound) + inline card
      // response for immediate visual feedback. Same lesson as show_edit:
      // inline alone leaves the next round of buttons un-bound.
      const clusterPosts = db.select()
        .from(generatedPosts)
        .where(eq(generatedPosts.clusterId, cluster.id))
        .all()
      const card = buildReviewCard(cluster, clusterPosts)

      try {
        await updateReviewCardMode(messageId, cluster, clusterPosts)
      } catch (err) {
        console.error('[lark callback] save_edit patchCard failed (non-fatal):', (err as Error).message)
      }

      return {
        toast: { type: 'success', content: 'Edit saved.' },
        card: { type: 'raw', data: card },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'error',
        entityType: 'generated_post',
        entityId: postId,
        errorCode: 'EDIT_SAVE_FAILED',
        errorMessage: msg,
        createdAt: Date.now(),
      }).run()
      return { code: 1, toast: { type: 'error', content: 'Could not save edit.' } }
    }
  }

  return { code: 0 }
}
