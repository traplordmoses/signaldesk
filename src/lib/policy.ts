/**
 * Editorial policy switches.
 *
 * ALLOW_SENSITIVE_STORIES (default ON, set to "0" to revert)
 *
 * Decided by the team 2026-09-18. The bot used to drop "high-risk" stories —
 * shootings, terror, killings, hostages — before they reached review, and floored
 * their score so they never competed. That also dropped the stories the team
 * most wants: the foiled-plot and bizarre-detail headlines Polymarket posts (a
 * man accused of plotting an ISIS-inspired attack turning out to moderate the
 * r/DoorDash subreddit). Every post goes to a human in Lark and then to legal
 * before it is published, so the bot no longer pre-censors: these stories reach
 * the queue flagged SENSITIVE with the words that tripped the classifier, and
 * legal decides.
 *
 * Read at call time, not import time, so it can be flipped in /etc/signaldesk.env
 * with a restart — no deploy — and so tests can exercise both modes.
 */
export function sensitiveStoriesAllowed(): boolean {
  return process.env.ALLOW_SENSITIVE_STORIES !== '0'
}
