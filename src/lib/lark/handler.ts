import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  updateGroupCard,
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
    const card = buildReviewCard(cluster, clusterPosts, {
      editingPostId: actionType === 'show_edit' ? postId : undefined,
    })
    // Schema 2.0 inline card-update response shape — `{ toast, card }` per
    // docs, no top-level `code`. Toast is informational; the actual update
    // happens via card.type='raw'.
    const response = {
      toast: { type: 'info', content: actionType === 'show_edit' ? 'Editing…' : 'Edit cancelled' },
      card: { type: 'raw' as const, data: card },
    }
    console.log(`[lark callback] ${actionType} → returning inline card update`, {
      postId,
      cardKeys: Object.keys(card),
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
        details: JSON.stringify({ clusterId: cluster.id, landedIn }),
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
        details: JSON.stringify({ clusterId: cluster.id }),
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
        details: JSON.stringify({ clusterId: cluster.id, charCount: editedContent.length }),
        createdAt: Date.now(),
      }).run()

      // Re-render the review card inline (read-only, with the new content).
      // Same atomic mechanism as show_edit / cancel_edit — sidesteps the
      // silent no-op that the separate larkPatch path can hit when a card's
      // structure changes between sends.
      const clusterPosts = db.select()
        .from(generatedPosts)
        .where(eq(generatedPosts.clusterId, cluster.id))
        .all()
      const card = buildReviewCard(cluster, clusterPosts)
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
