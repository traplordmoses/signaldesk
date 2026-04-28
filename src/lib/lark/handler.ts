import { db, sqlite } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { updateGroupCard, updateGroupCardEdited, sendApprovalDM, sendEditDM, sendSavedEditDM, updateEditDM, sendBotStatusToGroup } from './messages'

interface ActionValue {
  action: 'approve' | 'reject' | 'edit' | 'save_edit' | 'pause_bot' | 'resume_bot'
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

export async function handleLarkCallback(payload: CallbackPayload): Promise<{
  code: number
  toast?: { type: string; content: string }
}> {
  const { action, operator, context } = payload
  const { postId, action: actionType } = action.value
  const actorName = operator.name ?? operator.open_id
  const messageId = context.open_message_id

  // Handle pause/resume — no postId needed
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

  if (actionType === 'approve') {
    try {
      db.update(generatedPosts)
        .set({ status: 'approved', reviewedBy: actorName, updatedAt: Date.now() })
        .where(eq(generatedPosts.id, postId))
        .run()

      await updateGroupCard(messageId, cluster, post, actorName, true)
      await sendApprovalDM(operator.open_id, post)

      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_approved',
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
        errorCode: 'APPROVE_FAILED',
        errorMessage: msg,
        createdAt: Date.now(),
      }).run()
    }

    return { code: 0, toast: { type: 'success', content: 'Post approved! Check your DMs.' } }
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

  if (actionType === 'edit') {
    try {
      await sendEditDM(operator.open_id, post)
      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'edit_requested',
        entityType: 'generated_post',
        entityId: postId,
        actor: operator.open_id,
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
        errorCode: 'EDIT_DM_FAILED',
        errorMessage: msg,
        createdAt: Date.now(),
      }).run()
    }

    return { code: 0, toast: { type: 'info', content: 'Check your DMs, then reply with the edited draft.' } }
  }

  if (actionType === 'save_edit') {
    const editedContent = action.value.editedContent?.trim()
    if (!editedContent) {
      return { code: 1, toast: { type: 'error', content: 'Edited text cannot be empty.' } }
    }

    if (editedContent.length > 280) {
      return { code: 1, toast: { type: 'error', content: `Edited text is ${editedContent.length}/280 characters.` } }
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

      const updatedPost = db.select().from(generatedPosts).where(eq(generatedPosts.id, postId)).get()
      if (updatedPost) {
        await updateEditDM(messageId, updatedPost)
        if (updatedPost.larkMessageId) {
          await updateGroupCardEdited(updatedPost.larkMessageId, cluster, updatedPost, actorName)
        }
      }

      db.insert(auditLog).values({
        id: crypto.randomUUID(),
        eventType: 'post_edited',
        entityType: 'generated_post',
        entityId: postId,
        actor: actorName,
        details: JSON.stringify({ clusterId: cluster.id, charCount: editedContent.length }),
        createdAt: Date.now(),
      }).run()
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

    return { code: 0, toast: { type: 'success', content: 'Draft updated.' } }
  }

  return { code: 0 }
}

export async function handleLarkMessage(payload: {
  openId: string
  actorName?: string
  text: string
}): Promise<{ code: number }> {
  const editedContent = payload.text.trim()
  if (!editedContent) return { code: 0 }

  const latestRequest = sqlite.prepare(`
    SELECT entity_id AS postId, created_at AS createdAt
    FROM audit_log
    WHERE event_type = 'edit_requested'
      AND actor = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(payload.openId) as { postId: string; createdAt: number } | undefined

  if (!latestRequest) return { code: 0 }

  const latestCompletion = sqlite.prepare(`
    SELECT created_at AS createdAt
    FROM audit_log
    WHERE event_type IN ('post_edited', 'edit_cancelled')
      AND actor = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(payload.openId) as { createdAt: number } | undefined

  if (latestCompletion && latestCompletion.createdAt > latestRequest.createdAt) {
    return { code: 0 }
  }

  const ageMs = Date.now() - latestRequest.createdAt
  if (ageMs > 30 * 60 * 1000) return { code: 0 }

  if (editedContent.length > 280) {
    console.warn('lark message edit ignored: over 280 chars', {
      openId: payload.openId,
      postId: latestRequest.postId,
      charCount: editedContent.length,
    })
    return { code: 0 }
  }

  const post = db.select().from(generatedPosts).where(eq(generatedPosts.id, latestRequest.postId)).get()
  if (!post) return { code: 0 }

  const cluster = db.select().from(eventClusters).where(eq(eventClusters.id, post.clusterId)).get()
  if (!cluster) return { code: 0 }

  const actorName = payload.actorName ?? payload.openId

  db.update(generatedPosts)
    .set({
      content: editedContent,
      charCount: editedContent.length,
      reviewedBy: actorName,
      updatedAt: Date.now(),
    })
    .where(eq(generatedPosts.id, latestRequest.postId))
    .run()

  const updatedPost = db.select().from(generatedPosts).where(eq(generatedPosts.id, latestRequest.postId)).get()
  if (!updatedPost) return { code: 0 }

  if (updatedPost.larkMessageId) {
    await updateGroupCardEdited(updatedPost.larkMessageId, cluster, updatedPost, actorName)
  }
  await sendSavedEditDM(payload.openId, updatedPost)

  db.insert(auditLog).values({
    id: crypto.randomUUID(),
    eventType: 'post_edited',
    entityType: 'generated_post',
    entityId: latestRequest.postId,
    actor: payload.openId,
    details: JSON.stringify({ clusterId: cluster.id, charCount: editedContent.length }),
    createdAt: Date.now(),
  }).run()

  return { code: 0 }
}
