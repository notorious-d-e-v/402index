// Delete the retired float32 copies in service_embeddings and hand the pages back to the
// filesystem, in small transactions, while the app keeps running.
//
//   cd /app && node scripts/ops/purge-duplicate-vectors.cjs --db /tmp/rehearsal.db --yes
//   cd /app && node scripts/ops/purge-duplicate-vectors.cjs --db /data/402index.db --yes
//
// Why chunked: the DB runs journal_mode=delete, so a transaction's rollback journal grows
// with the pages it touches. One DELETE over 215k rows of 6 KB blobs is how a nearly full
// volume hits SQLITE_FULL (2026-07-22). Each batch deletes --batch rows by rowid, then
// PRAGMA incremental_vacuum(--vacuum-pages) runs as its own transaction until the freelist
// is empty, so no transaction moves more than ~4 MB. auto_vacuum must already be
// INCREMENTAL (it is in production); otherwise deleted pages never leave the file.
//
// Aborts if the file ever grows between batches, or if free space on the DB's filesystem
// falls by more than --slack-mb (the app writes too) or below --floor-mb.
// Never imports src/db.js: that runs boot side effects against whatever DB_PATH points at.
const fs = require('fs')
const Database = require(fs.existsSync('/app/node_modules/better-sqlite3') ? '/app/node_modules/better-sqlite3' : 'better-sqlite3')

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const DB = opt('--db')
const BATCH = parseInt(opt('--batch', '2000'), 10)
const VAC = parseInt(opt('--vacuum-pages', '1000'), 10)
const PAUSE = parseInt(opt('--pause-ms', '100'), 10)
const SLACK = parseInt(opt('--slack-mb', '16'), 10) * 1048576
const FLOOR = parseInt(opt('--floor-mb', '300'), 10) * 1048576
if (!DB || !argv.includes('--yes')) { console.error('usage: purge-duplicate-vectors.cjs --db <path> --yes [--batch N] [--vacuum-pages N]'); process.exit(2) }

const db = new Database(DB, { fileMustExist: true })
db.pragma('busy_timeout = 5000')
const one = s => db.prepare(s).pluck().get()
if (one('PRAGMA auto_vacuum') !== 2) { console.error('auto_vacuum is not INCREMENTAL — deleting would not shrink the file'); process.exit(1) }
if (String(one('PRAGMA journal_mode')).toLowerCase() !== 'delete') { console.error('expected journal_mode=delete'); process.exit(1) }

const freeBytes = () => { const s = fs.statfsSync(DB); return s.bavail * s.bsize }
const fileBytes = () => fs.statSync(DB).size
const log = o => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const del = db.prepare('DELETE FROM service_embeddings WHERE rowid IN (SELECT rowid FROM service_embeddings ORDER BY rowid LIMIT ?)')
const startRows = one('SELECT COUNT(*) FROM service_embeddings')
const start = { rows: startRows, file: fileBytes(), free: freeBytes(), freelist: one('PRAGMA freelist_count') }
log({ phase: 'start', db: DB, ...start, batch: BATCH, vacuum_pages: VAC })

let prevFile = start.file, prevFree = start.free, batches = 0, deleted = 0
for (;;) {
  const n = db.transaction(() => del.run(BATCH).changes).immediate()
  if (n === 0) break
  deleted += n; batches++
  let calls = 0
  while (one('PRAGMA freelist_count') > 0) { db.pragma(`incremental_vacuum(${VAC})`); calls++ }
  const file = fileBytes(), free = freeBytes()
  if (batches % 10 === 0 || n < BATCH) log({ phase: 'batch', batches, deleted, file, free, freelist: one('PRAGMA freelist_count'), vacuum_calls: calls })
  if (file > prevFile) { log({ phase: 'abort', reason: 'file grew', prevFile, file }); process.exit(3) }
  if (free < prevFree - SLACK || free < FLOOR) { log({ phase: 'abort', reason: 'free space fell', prevFree, free }); process.exit(3) }
  prevFile = file; prevFree = free
  sleep(PAUSE)
}
log({ phase: 'done', batches, deleted, rows_left: one('SELECT COUNT(*) FROM service_embeddings'),
  file: fileBytes(), free: freeBytes(), freelist: one('PRAGMA freelist_count'),
  freed_mb: Math.round((start.file - fileBytes()) / 1048576) })
