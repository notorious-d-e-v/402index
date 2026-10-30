// One-off: retire Bazaar rows the live listing no longer carries and that nobody has seen
// answer in 7 days. Ongoing churn is handled by the 7-pass rule in src/aggregators/bazaar-presence.js;
// this clears the backlog that built up before presence was tracked.
//
//   node scripts/ops/retire-bazaar-churn.mjs --db /data/402index.db                     # readonly counts
//   node scripts/ops/retire-bazaar-churn.mjs --db /data/402index.db --batch p3-2026-10-27 --expect N --yes
//   node scripts/ops/retire-bazaar-churn.mjs --db /data/402index.db --restore-id <service id>
//   node scripts/ops/retire-bazaar-churn.mjs --db /data/402index.db --restore-batch p3-2026-10-27
//
// Candidate = source='bazaar', active, not listed in the last complete Bazaar pass, and no
// healthy check in 7 days (last_seen_healthy NULL or older). Rows that are missing upstream but
// were healthy recently stay active in the upstream_missing bucket.
// Retire = status='retired' + retired_batch, 20k rows per transaction; then the batch's vectors
// leave vec_service_embeddings 2,000 per transaction, with file size measured before and after.
// Restore = status back to 'active'; --restore-id also re-embeds the row (OPENAI_API_KEY) so
// semantic search finds it again. Never imports src/db.js.
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = n => (fs.existsSync(`/app/node_modules/${n}`) ? `/app/node_modules/${n}` : n)
const Database = require(mod('better-sqlite3'))
const sqliteVec = require(mod('sqlite-vec'))

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const DB = opt('--db')
if (!DB) { console.error('usage: see header'); process.exit(2) }
const writing = argv.includes('--yes') || opt('--restore-id') || opt('--restore-batch')
const db = new Database(DB, { fileMustExist: true, readonly: !writing })
db.pragma('busy_timeout = 5000')
sqliteVec.load(db)
const one = s => db.prepare(s).pluck().get()
const log = o => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))
const fileBytes = () => fs.statSync(DB).size
const freeBytes = () => { const s = fs.statfsSync(DB); return s.bavail * s.bsize }
const drain = () => { while (one('PRAGMA freelist_count') > 0) db.pragma('incremental_vacuum(1000)') }

async function embed(id) {
  const s = db.prepare('SELECT name, description, category FROM services WHERE id = ?').get(id)
  const res = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: `${s.name}\n${s.description ?? ''}\n${s.category ?? ''}` }) })
  const v = (await res.json()).data?.[0]?.embedding
  if (!v) throw new Error(`embedding failed for ${id}: HTTP ${res.status}`)
  const blob = Buffer.from(new Float32Array(v).buffer)
  db.transaction(() => {
    db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(id)
    db.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)').run(id, blob)
  })()
}

if (opt('--restore-id')) {
  const id = opt('--restore-id')
  const n = db.prepare("UPDATE services SET status = 'active', retired_batch = NULL, retired_at = NULL WHERE id = ? AND status = 'retired'").run(id).changes
  if (n && process.env.OPENAI_API_KEY) await embed(id)
  log({ phase: 'restore-id', id, restored: n, row: db.prepare('SELECT id, status, retired_batch, upstream_missing_since FROM services WHERE id = ?').get(id),
    vector: one(`SELECT COUNT(*) FROM vec_service_embeddings WHERE service_id = '${id.replace(/'/g, "''")}'`) })
  process.exit(0)
}
if (opt('--restore-batch')) {
  const b = opt('--restore-batch'); let total = 0
  const st = db.prepare(`UPDATE services SET status = 'active', retired_batch = NULL, retired_at = NULL WHERE rowid IN (SELECT rowid FROM services WHERE retired_batch = ? LIMIT 20000)`)
  for (let n; (n = db.transaction(() => st.run(b).changes).immediate()) > 0;) total += n
  log({ phase: 'restore-batch', batch: b, restored: total, note: 'vectors were removed at retirement: run backfill-embeddings to re-embed' })
  process.exit(0)
}

const lastPass = db.prepare('SELECT pass_id, completed_at, upstream_total, seen FROM bazaar_passes WHERE complete = 1 ORDER BY pass_id DESC LIMIT 1').get()
if (!lastPass) { console.error('no complete Bazaar pass recorded yet — presence is unknown; wait for one'); process.exit(1) }
const ABSENT = `source = 'bazaar' AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)
  AND (bazaar_seen_pass IS NULL OR bazaar_seen_pass < ${lastPass.pass_id})`
const STALE = `(last_seen_healthy IS NULL OR last_seen_healthy < datetime('now', '-7 days'))`
const counts = {
  last_complete_pass: lastPass,
  bazaar_active: one("SELECT COUNT(*) FROM services WHERE source = 'bazaar' AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"),
  listed_in_last_pass: one(`SELECT COUNT(*) FROM services WHERE source = 'bazaar' AND bazaar_seen_pass >= ${lastPass.pass_id}`),
  absent: one(`SELECT COUNT(*) FROM services WHERE ${ABSENT}`),
  retire_candidates: one(`SELECT COUNT(*) FROM services WHERE ${ABSENT} AND ${STALE}`),
  absent_but_recently_healthy: one(`SELECT COUNT(*) FROM services WHERE ${ABSENT} AND NOT ${STALE}`),
  retire_candidates_by_host_top5: db.prepare(`SELECT hostname, COUNT(*) n FROM services WHERE ${ABSENT} AND ${STALE} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`).all(),
}
log({ phase: 'count', ...counts })
if (!argv.includes('--yes')) process.exit(0)

const BATCH = opt('--batch'), EXPECT = Number(opt('--expect'))
if (!BATCH || !EXPECT) { console.error('--yes needs --batch and --expect'); process.exit(2) }
if (Math.abs(counts.retire_candidates - EXPECT) > EXPECT * 0.02) { console.error(`refusing: ${counts.retire_candidates} candidates is not within 2% of --expect ${EXPECT}`); process.exit(1) }

const t0 = { file: fileBytes(), free: freeBytes() }
const retire = db.prepare(`UPDATE services SET status = 'retired', retired_batch = @b, retired_at = datetime('now')
  WHERE rowid IN (SELECT rowid FROM services WHERE ${ABSENT} AND ${STALE} LIMIT 20000)`)
let retired = 0
for (let n; (n = db.transaction(() => retire.run({ b: BATCH }).changes).immediate()) > 0;) { retired += n; drain() }
const t1 = { file: fileBytes(), free: freeBytes() }
log({ phase: 'retired', batch: BATCH, retired, file_before: t0.file, file_after: t1.file })

const ids = db.prepare('SELECT id FROM services WHERE retired_batch = ?').pluck().all(BATCH)
const del = db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?')
let vecDeleted = 0
for (let i = 0; i < ids.length; i += 2000) {
  vecDeleted += db.transaction(chunk => chunk.reduce((a, id) => a + del.run(id).changes, 0)).immediate(ids.slice(i, i + 2000))
  drain()
  if (fileBytes() > t1.file + 16 * 1048576) { log({ phase: 'abort', reason: 'file grew during vector delete', file: fileBytes() }); process.exit(3) }
}
const t2 = { file: fileBytes(), free: freeBytes() }
log({ phase: 'vectors', deleted: vecDeleted, vec_rows_left: one('SELECT COUNT(*) FROM vec_service_embeddings'),
  file_before_vec_delete: t1.file, file_after_vec_delete: t2.file, vec_freed_mb: Math.round((t1.file - t2.file) / 1048576), free: t2.free })
