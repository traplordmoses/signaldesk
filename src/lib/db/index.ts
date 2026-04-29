import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import path from 'path'
import fs from 'fs'

// DB_PATH should be set in production to a location OUTSIDE the project tree
// (e.g. /var/lib/signaldesk/signaldesk.db). Reasons:
//
//   1. `next build` with `output: 'standalone'` traces the cwd-relative
//      `data/signaldesk.db` path as a runtime asset and copies the project-
//      root copy over the live standalone copy on every build — destroying
//      production state. Putting the DB outside the project tree breaks the
//      tracing chain and makes builds data-safe.
//
//   2. It also lets you move/back-up/snapshot the DB without touching the
//      app directory.
//
// Falls back to the cwd-relative path for local development, where having
// the DB inside the repo is convenient.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'signaldesk.db')

// better-sqlite3 creates the DB file on first open but NOT the parent dir.
// Materialize it now so a fresh `DB_PATH=/var/lib/signaldesk/signaldesk.db`
// works without an extra `mkdir -p` step in the deploy.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH)
sqlite.pragma('journal_mode = WAL')

export const db = drizzle(sqlite, { schema })
export { sqlite }
