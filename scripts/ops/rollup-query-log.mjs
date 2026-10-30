// Drain the query_log backlog into query_log_daily, one 20k-row chunk per transaction, while
// the app keeps running. The app's hourly prune does the same work 10 chunks at a time; this
// is for the one-off backlog (3.2M rows on 2026-10-27).
//
//   cd /app && node scripts/ops/rollup-query-log.mjs --db /tmp/rehearsal.db --yes [--prove]
//   cd /app && node scripts/ops/rollup-query-log.mjs --db /data/402index.db --yes
//
// --prove: before and after the rollup, compute the digest's search-intelligence numbers and
// the all-time 402index-mcp summary, two ways (raw rows, and raw + rollup), and fail unless
// they match. Use it on a copy: the "before" pass reads every row.
//
// Aborts if the file grows between chunks, or free space falls by more than --slack-mb or
// below --floor-mb. Never imports src/db.js (boot side effects against DB_PATH).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { ensureQueryLogDaily, rollupQueryLog, mcpAllTime } from '../../src/services/query-log-rollup.js'

const require = createRequire(import.meta.url)
const Database = require(fs.existsSync('/app/node_modules/better-sqlite3') ? '/app/node_modules/better-sqlite3' : 'better-sqlite3')

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const DB = opt('--db')
const CHUNK = parseInt(opt('--chunk', '20000'), 10)
const VAC = parseInt(opt('--vacuum-pages', '1000'), 10)
const PAUSE = parseInt(opt('--pause-ms', '100'), 10)
const SLACK = parseInt(opt('--slack-mb', '16'), 10) * 1048576
const FLOOR = parseInt(opt('--floor-mb', '300'), 10) * 1048576
const PROVE = argv.includes('--prove')
if (!DB || !argv.includes('--yes')) { console.error('usage: rollup-query-log.mjs --db <path> --yes [--prove]'); process.exit(2) }

const db = new Database(DB, { fileMustExist: true })
db.pragma('busy_timeout = 5000')
const one = s => db.prepare(s).pluck().get()
if (one('PRAGMA auto_vacuum') !== 2) { console.error('auto_vacuum is not INCREMENTAL'); process.exit(1) }
ensureQueryLogDaily(db)

const freeBytes = () => { const s = fs.statfsSync(DB); return s.bavail * s.bsize }
const fileBytes = () => fs.statSync(DB).size
const log = o => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The digest's 7-day queries, aligned to whole UTC days so raw and rollup are comparable.
function digestNumbers() {
  const from = "date('now', '-7 days')", to = "date('now')"
  const raw = {
    top_searches: db.prepare(`SELECT query_text AS term, COUNT(*) AS n FROM query_log WHERE query_text IS NOT NULL AND query_text != '' AND timestamp >= ${from} AND timestamp < ${to} GROUP BY 1 ORDER BY n DESC, term LIMIT 20`).all(),
    zero_results: db.prepare(`SELECT query_text AS term, COUNT(*) AS n FROM query_log WHERE result_count = 0 AND query_text IS NOT NULL AND query_text != '' AND timestamp >= ${from} AND timestamp < ${to} GROUP BY 1 ORDER BY n DESC, term LIMIT 10`).all(),
    top_agents: db.prepare(`SELECT IFNULL(user_agent, '') AS ua, COUNT(*) AS n FROM query_log WHERE timestamp >= ${from} AND timestamp < ${to} GROUP BY 1 ORDER BY n DESC, ua LIMIT 15`).all(),
  }
  const rolled = {
    top_searches: db.prepare(`SELECT term, SUM(count) AS n FROM query_log_daily WHERE term != '' AND day >= ${from} AND day < ${to} GROUP BY 1 ORDER BY n DESC, term LIMIT 20`).all(),
    zero_results: db.prepare(`SELECT term, SUM(zero_result_count) AS n FROM query_log_daily WHERE term != '' AND zero_result_count > 0 AND day >= ${from} AND day < ${to} GROUP BY 1 ORDER BY n DESC, term LIMIT 10`).all(),
    top_agents: db.prepare(`SELECT user_agent AS ua, SUM(count) AS n FROM query_log_daily WHERE day >= ${from} AND day < ${to} GROUP BY 1 ORDER BY n DESC, ua LIMIT 15`).all(),
  }
  return { raw, rolled, mcp: mcpAllTime(db) }
}

let before
if (PROVE) {
  before = digestNumbers()
  // Prove the rollup itself reproduces the 7-day numbers: fold the 7-day window into a scratch
  // copy of the daily table and compare against raw. Done inside a transaction that is rolled back.
  db.exec('BEGIN')
  db.exec("INSERT INTO query_log_daily (day, term, filters, user_agent, count, zero_result_count, first_seen, last_seen) SELECT date(timestamp), IFNULL(query_text, ''), IFNULL(filters, ''), IFNULL(user_agent, ''), COUNT(*), SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END), MIN(timestamp), MAX(timestamp) FROM query_log WHERE timestamp >= date('now', '-7 days') AND timestamp < date('now') GROUP BY 1, 2, 3, 4 ON CONFLICT DO NOTHING")
  const folded = digestNumbers()
  db.exec('ROLLBACK')
  const same = JSON.stringify(folded.raw) === JSON.stringify(folded.rolled)
  log({ phase: 'prove-7d', same, top_search: folded.raw.top_searches[0], top_agent: folded.raw.top_agents[0] })
  if (!same) { log({ phase: 'abort', reason: '7-day numbers differ between raw and rollup', raw: folded.raw, rolled: folded.rolled }); process.exit(4) }
  log({ phase: 'prove-mcp-before', ...before.mcp })
}

const start = { rows: one('SELECT COUNT(*) FROM query_log'), daily: one('SELECT COUNT(*) FROM query_log_daily'), file: fileBytes(), free: freeBytes() }
log({ phase: 'start', db: DB, ...start, chunk: CHUNK })
let prevFile = start.file, prevFree = start.free, chunks = 0, rolled = 0
for (;;) {
  const r = rollupQueryLog(db, { chunkRows: CHUNK, maxChunks: 1 })
  if (r.rolled === 0) break
  rolled += r.rolled; chunks++
  while (one('PRAGMA freelist_count') > 0) db.pragma(`incremental_vacuum(${VAC})`)
  const file = fileBytes(), free = freeBytes()
  if (chunks % 20 === 0) log({ phase: 'chunk', chunks, rolled, file, free })
  if (file > prevFile) { log({ phase: 'abort', reason: 'file grew', prevFile, file }); process.exit(3) }
  if (free < prevFree - SLACK || free < FLOOR) { log({ phase: 'abort', reason: 'free space fell', prevFree, free }); process.exit(3) }
  prevFile = file; prevFree = free
  await sleep(PAUSE)
}
log({ phase: 'done', chunks, rolled, rows_left: one('SELECT COUNT(*) FROM query_log'), daily: one('SELECT COUNT(*) FROM query_log_daily'),
  oldest_raw: one('SELECT MIN(timestamp) FROM query_log'), file: fileBytes(), free: freeBytes(), freed_mb: Math.round((start.file - fileBytes()) / 1048576) })

if (PROVE) {
  const after = digestNumbers()
  const same = JSON.stringify(after.raw) === JSON.stringify(before.raw) && JSON.stringify(after.mcp) === JSON.stringify(before.mcp)
  log({ phase: 'prove-after', same, mcp: after.mcp })
  if (!same) process.exit(4)
}
