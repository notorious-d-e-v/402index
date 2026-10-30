// Put one host into quarantine by hand, after checking its row count.
//
//   cd /app && node scripts/ops/seed-quarantine.mjs --db /data/402index.db --host market.datapackvibe.com            # count only
//   cd /app && node scripts/ops/seed-quarantine.mjs --db /data/402index.db --host market.datapackvibe.com \
//        --expect 69737 --reason "530/1033 on GET/HEAD/POST; x402#3844" --yes
//
// --expect must be within 2% of the live active-row count or nothing is written. The seeded
// host leaves quarantine the normal way (src/health/quarantine.js: run count and elapsed time).
// --exited-at "YYYY-MM-DD HH:MM:SS" records an earlier exit (and counts one flap), so the host is
// held, not quarantined, if it re-enters within 30 days of its next release.
// Undo: DELETE FROM quarantined_hosts WHERE hostname = '<host>'.
// Never imports src/db.js (boot side effects against DB_PATH).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { ACTIVE, ensureQuarantineSchema, recordQuarantineEvent } from '../../src/services/visibility.js'

const require = createRequire(import.meta.url)
const Database = require(fs.existsSync('/app/node_modules/better-sqlite3') ? '/app/node_modules/better-sqlite3' : 'better-sqlite3')

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const DB = opt('--db'), HOST = opt('--host'), EXPECT = opt('--expect'), REASON = opt('--reason'), EXITED_AT = opt('--exited-at')
if (!DB || !HOST) { console.error('usage: seed-quarantine.mjs --db <path> --host <hostname> [--expect N --reason TEXT [--exited-at TS] --yes]'); process.exit(2) }

const write = argv.includes('--yes')
const db = new Database(DB, { fileMustExist: true, readonly: !write })
db.pragma('busy_timeout = 5000')
const count = db.prepare(`SELECT COUNT(*) AS c FROM services WHERE hostname = ? AND ${ACTIVE}`).get(HOST).c
const byHealth = db.prepare(`SELECT health_status AS h, COUNT(*) AS n FROM services WHERE hostname = ? AND ${ACTIVE} GROUP BY 1`).all(HOST)
console.log(JSON.stringify({ host: HOST, active_rows: count, by_health: byHealth }))
if (!write) process.exit(0)

const expect = Number(EXPECT)
if (!expect || !REASON) { console.error('--yes needs --expect and --reason'); process.exit(2) }
if (Math.abs(count - expect) > expect * 0.02) { console.error(`refusing: live count ${count} is not within 2% of --expect ${expect}`); process.exit(1) }
if (EXITED_AT && !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(EXITED_AT)) { console.error('--exited-at must be "YYYY-MM-DD HH:MM:SS" (UTC)'); process.exit(2) }
ensureQuarantineSchema(db)
const prior = db.prepare('SELECT state FROM quarantined_hosts WHERE hostname = ?').get(HOST)
db.prepare(`INSERT INTO quarantined_hosts (hostname, state, fail_streak, pass_streak, entered_at, reason, seeded, exited_at, flap_count)
  VALUES (@host, 'quarantined', 3, 0, datetime('now'), @reason, 1, @exited, @flaps)
  ON CONFLICT (hostname) DO UPDATE SET state = 'quarantined', entered_at = excluded.entered_at, reason = excluded.reason, seeded = 1,
    pass_streak = 0, first_pass_at = NULL, exited_at = COALESCE(excluded.exited_at, quarantined_hosts.exited_at),
    flap_count = quarantined_hosts.flap_count + excluded.flap_count`).run({ host: HOST, reason: REASON, exited: EXITED_AT ?? null, flaps: EXITED_AT ? 1 : 0 })
recordQuarantineEvent(db, { hostname: HOST, from: prior?.state ?? null, to: 'quarantined', detail: `seeded: ${REASON}` })
console.log(JSON.stringify(db.prepare('SELECT * FROM quarantined_hosts WHERE hostname = ?').get(HOST)))
