#!/usr/bin/env node
/**
 * Pause / resume SignalDesk's Lark posting from the host — the link-mode
 * replacement for the old "⏸ Pause Bot" card button (the card has no callback
 * buttons anymore). Flips `settings.lark_enabled`, which the cron scheduler
 * checks before sending each cluster, then best-effort announces in the review
 * chat.
 *
 *   node scripts/toggle-bot.mjs off    # pause  (lark_enabled = 0)
 *   node scripts/toggle-bot.mjs on     # resume (lark_enabled = 1)
 *
 * Run with the service env sourced so DB_PATH + Lark creds resolve:
 *   set -a; . /etc/signaldesk.env; set +a; node scripts/toggle-bot.mjs off
 *
 * You can also toggle this from the dashboard (/settings) — this CLI exists for
 * headless ops on the EC2 box, where the dashboard isn't publicly exposed.
 *
 * Dependency-free on purpose (only better-sqlite3, a runtime dep, + global
 * fetch) so it runs without the dev toolchain or Next's path aliases.
 */
import Database from 'better-sqlite3'
import path from 'node:path'

const arg = process.argv[2]
if (arg !== 'on' && arg !== 'off') {
  console.error('usage: toggle-bot.mjs <on|off>')
  process.exit(2)
}
const enabled = arg === 'on' ? 1 : 0
const paused = enabled === 0

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'signaldesk.db')
const db = new Database(DB_PATH)
const info = db
  .prepare("UPDATE settings SET lark_enabled = ?, updated_at = ? WHERE id = 'singleton'")
  .run(enabled, Date.now())
console.log(`[toggle-bot] lark_enabled = ${enabled} (${info.changes} row updated) @ ${DB_PATH}`)
db.close()

// Best-effort chat announcement — never fail the toggle over a Lark hiccup.
const { LARK_APP_ID, LARK_APP_SECRET, LARK_REVIEW_CHAT_ID } = process.env
if (LARK_APP_ID && LARK_APP_SECRET && LARK_REVIEW_CHAT_ID) {
  try {
    const base = 'https://open.larksuite.com/open-apis'
    const tokRes = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
    })
    const tok = await tokRes.json()
    if (tok.code !== 0) throw new Error(tok.msg)

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: paused ? '⏸ Bot Paused' : '▶️ Bot Resumed' },
        template: paused ? 'grey' : 'green',
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: paused
            ? 'SignalDesk bot is now **paused**. No new posts until resumed.'
            : 'SignalDesk bot is now **active**. New high-scoring posts will be sent here automatically.',
        }],
      },
    }
    const msgRes = await fetch(`${base}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.tenant_access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: LARK_REVIEW_CHAT_ID, msg_type: 'interactive', content: JSON.stringify(card) }),
    })
    const msg = await msgRes.json()
    if (msg.code !== 0) throw new Error(msg.msg)
    console.log('[toggle-bot] announced in review chat')
  } catch (e) {
    console.warn(`[toggle-bot] chat announce failed (flag still updated): ${e.message}`)
  }
} else {
  console.log('[toggle-bot] no Lark creds in env — skipped chat announce')
}
