import os from 'node:os'
import path from 'node:path'

// Every test file gets its own throwaway database.
//
// This has to live in a setupFile. src/lib/db opens the database at IMPORT time,
// and ES module imports are hoisted above any statement in a test file, so a
// `process.env.DB_PATH = …` written at the top of a test runs too late. That is
// how the test suite was silently reading and writing data/signaldesk.db — which
// became a real problem once the scorer started consulting the Probly market
// table, because test results then depended on whatever that local DB held.
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `signaldesk-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
)
