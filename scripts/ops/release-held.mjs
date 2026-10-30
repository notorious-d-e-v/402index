// Release a held host (one that re-entered quarantine within 30 days of leaving it) back into
// every count and list. Held hosts never leave on their own (src/health/quarantine.js).
//
//   cd /app && node scripts/ops/release-held.mjs --db /data/402index.db --host <hostname>                      # show only
//   cd /app && node scripts/ops/release-held.mjs --db /data/402index.db --host <hostname> --reason "<why>" --yes
//
// The host becomes 'released' with exited_at = now, so a further re-entry within 30 days is held
// again. Undo: scripts/ops/seed-quarantine.mjs for the same host.
// Never imports src/db.js (boot side effects against DB_PATH).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { ACTIVE, ensureQuarantineSchema, recordQuarantineEvent } from '../../src/services/visibility.js'

const require = createRequire(import.meta.url)
const Database = require(fs.existsSync('/app/node_modules/better-sqlite3') ? '/app/node_modules/better-sqlite3' : 'better-sqlite3')

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const DB = opt('--db'), HOST = opt('--host'), REASON = opt('--reason')
if (!DB || !HOST) { console.error('usage: release-held.mjs --db <path> --host <hostname> [--reason TEXT --yes]'); process.exit(2) }

const write = argv.includes('--yes')
const db = new Database(DB, { fileMustExist: true, readonly: !write })
db.pragma('busy_timeout = 5000')
const row = db.prepare('SELECT * FROM quarantined_hosts WHERE hostname = ?').get(HOST)
const rows = db.prepare(`SELECT COUNT(*) AS c FROM services WHERE hostname = ? AND ${ACTIVE}`).get(HOST).c
console.log(JSON.stringify({ ...row, active_rows: rows }))
if (!write) process.exit(0)

if (!REASON) { console.error('--yes needs --reason'); process.exit(2) }
if (row?.state !== 'held') { console.error(`refusing: ${HOST} is ${row ? row.state : 'not tracked'}, not held`); process.exit(1) }
ensureQuarantineSchema(db)
recordQuarantineEvent(db, { hostname: HOST, from: 'held', to: 'released', detail: `manual release: ${REASON}` })
db.prepare(`UPDATE quarantined_hosts SET state = 'released', exited_at = datetime('now'), fail_streak = 0, pass_streak = 0,
  first_pass_at = NULL WHERE hostname = ?`).run(HOST)
console.log(JSON.stringify(db.prepare('SELECT * FROM quarantined_hosts WHERE hostname = ?').get(HOST)))
