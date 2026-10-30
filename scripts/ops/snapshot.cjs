// In-container failsafe snapshot of the live DB onto the container's ephemeral disk.
//
//   cd /app && node scripts/ops/snapshot.cjs <name>        -> /tmp/<name>.db
//
// Why a raw copy and not VACUUM INTO: the DB runs journal_mode=delete. Any reader holds a
// SHARED lock for as long as it reads, and once an app writer reaches PENDING every new app
// reader is refused too. VACUUM INTO on a ~4 GB file reads for far longer than the app's
// busy_timeout (5 s), so app writes fail and requests stall behind it. A sequential copy of
// the same file takes ~2 s on this volume. Holding a read transaction across the copy keeps
// the copy consistent (no writer can commit while the SHARED lock is held), and the copy keeps
// the exact page layout, which makes it a faithful rehearsal target for incremental_vacuum.
//
// Never write a snapshot onto /data. /tmp is wiped by every deploy.
const { execFileSync } = require('child_process')
const fs = require('fs')
const Database = require('/app/node_modules/better-sqlite3')
const vec = require('/app/node_modules/sqlite-vec')

const name = process.argv[2]
if (!name || !/^[a-z0-9-]+$/.test(name)) { console.error('usage: snapshot.cjs <name>'); process.exit(2) }
const SRC = process.env.DB_PATH || '/data/402index.db'
const DST = `/tmp/${name}.db`
if (DST.startsWith('/data')) throw new Error('refusing to snapshot onto /data')

// Warm the page cache first. On a fresh container the locked copy ran at ~300 MB/s and held
// SHARED for 12.7 s (two app logQuery writes failed "database is locked"); warm, it is ~2 GB/s.
execFileSync('sh', ['-c', `cat "${SRC}" > /dev/null`])
const src = new Database(SRC, { readonly: true, fileMustExist: true })
src.pragma('busy_timeout = 5000')
const t0 = Date.now()
src.exec('BEGIN')
src.prepare('SELECT COUNT(*) FROM sqlite_master').get() // acquires SHARED until COMMIT
const tLock = Date.now()
execFileSync('cp', [SRC, DST])
src.exec('COMMIT')
const lockMs = Date.now() - tLock
src.close()

const snap = new Database(DST, { readonly: true, fileMustExist: true })
vec.load(snap)
const one = s => snap.prepare(s).pluck().get()
const integrity = snap.pragma('integrity_check').map(r => r.integrity_check)
const counts = {}
for (const t of ['services', 'query_log', 'health_checks', 'service_embeddings', 'vec_service_embeddings']) {
  try { counts[t] = one(`SELECT COUNT(*) FROM ${t}`) } catch (e) { counts[t] = `ERR ${e.message}` }
}
const sha = execFileSync('sha256sum', [DST]).toString().split(' ')[0]
console.log(JSON.stringify({
  name, path: DST, bytes: fs.statSync(DST).size, lock_held_ms: lockMs, total_ms: Date.now() - t0,
  integrity: integrity.length === 1 ? integrity[0] : integrity.slice(0, 5),
  page_count: one('PRAGMA page_count'), freelist: one('PRAGMA freelist_count'), sha256: sha, counts,
  at: new Date().toISOString(),
}))
