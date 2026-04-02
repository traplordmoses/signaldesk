import { db } from '@/lib/db'
import { generatedPosts, eventClusters, auditLog, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { updateGroupCard, sendApprovalDM, sendEditDM, sendBotStatusToGroup } from './messages'

interface ActionValue {
  action: 'approve' | 'reject' | 'edit' | 'pause_bot' | 'resume_bot'
  postId?: string
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

    return { code: 0, toast: { type: 'info', content: 'Check your DMs for edit instructions.' } }
  }

  return { code: 0 }
}
