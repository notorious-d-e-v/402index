// Recall harness for the deferred vector-index rebuild (int8 + distance_metric=cosine).
// Read-only against a DB copy; builds candidate indexes in memory and compares their top-k
// against today's float32/1536 L2 index for real search queries.
//
//   cd /app && node scripts/ops/snapshot.cjs recall           # take a copy first; never run on /data
//   cd /app && OPENAI_API_KEY=… node scripts/ops/recall-harness.cjs /tmp/recall.db
//
// 2026-10-27 result (30k sampled vectors, 200 most frequent 7-day queries, ~900 tokens):
//   f512 0.790 · f256 0.623 · int8/1536 unit 0.926 · int8/1536 scaled ÷0.1681 0.987 · int8/512 0.787 · bit 0.675
// (recall@10 vs float32/1536). Scaling before 'unit' quantisation matters: components only reach ±0.17.
// NOTE: since 2026-10-27 service_embeddings holds no vectors; this reads vec_service_embeddings.

const D = require('/app/node_modules/better-sqlite3')
const vec = require('/app/node_modules/sqlite-vec')
const SRC = process.argv[2]
if (!SRC || SRC.startsWith('/data')) { console.error('usage: recall-harness.cjs <copy of the DB, not /data>'); process.exit(2) }
const src = new D(SRC, { readonly: true, fileMustExist: true })
vec.load(src)
const mem = new D(':memory:'); vec.load(mem)
const N = 30000, Q = 200, K = [10, 50]

const maxRow = src.prepare('SELECT MAX(rowid) FROM vec_service_embeddings_rowids').pluck().get()
// vec0 with a text primary key has no rowid column; its _rowids shadow table maps rowid → id.
const idAt = src.prepare('SELECT id FROM vec_service_embeddings_rowids WHERE rowid = ?').pluck()
const byId = src.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?')
const get = { get: r => { const id = idAt.get(r); return id ? byId.get(id) : undefined } }
const seen = new Set(), docs = []
while (docs.length < N) {
  const r = 1 + Math.floor(Math.random() * maxRow); if (seen.has(r)) continue; seen.add(r)
  const row = get.get(r); if (row) docs.push([row.service_id, new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + 6144))])
}
const queries = src.prepare(`SELECT query_text t, COUNT(*) c FROM query_log WHERE query_text IS NOT NULL AND length(query_text) > 2
  AND timestamp > datetime('now','-7 days') GROUP BY 1 ORDER BY 2 DESC LIMIT ${Q}`).all().map(r => r.t)

const trunc = (v, d) => { const c = v.slice(0, d); let n = 0; for (const x of c) n += x * x; n = Math.sqrt(n) || 1; return c.map(x => x / n) }
let maxAbs = 0; for (const [, v] of docs.slice(0, 2000)) for (const x of v) maxAbs = Math.max(maxAbs, Math.abs(x))
const variants = {
  f1536: { ddl: 'float[1536]', enc: v => v, q: 'vec_f32(?)' },
  f512: { ddl: 'float[512]', enc: v => trunc(v, 512), q: 'vec_f32(?)' },
  f256: { ddl: 'float[256]', enc: v => trunc(v, 256), q: 'vec_f32(?)' },
  i8_1536_unit: { ddl: 'int8[1536]', enc: v => v, q: "vec_quantize_int8(?, 'unit')" },
  i8_1536_scaled: { ddl: 'int8[1536]', enc: v => v.map(x => Math.max(-1, Math.min(1, x / maxAbs))), q: "vec_quantize_int8(?, 'unit')" },
  i8_512_scaled: { ddl: 'int8[512]', enc: v => { const t = trunc(v, 512); return t.map(x => Math.max(-1, Math.min(1, x / (maxAbs * 1.7)))) }, q: "vec_quantize_int8(?, 'unit')" },
  bit1536: { ddl: 'bit[1536]', enc: v => v, q: 'vec_quantize_binary(?)' },
}
const buf = a => Buffer.from(new Float32Array(a).buffer)
for (const [name, x] of Object.entries(variants)) {
  mem.exec(`CREATE VIRTUAL TABLE ${name} USING vec0(id text primary key, e ${x.ddl})`)
  const ins = mem.prepare(`INSERT INTO ${name}(id, e) VALUES (?, ${x.q})`)
  mem.transaction(() => { for (const [id, v] of docs) ins.run(id, buf(x.enc(v))) })()
}

;(async () => {
  const res = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: queries }) })
  const j = await res.json(); if (!j.data) { console.log('openai err', JSON.stringify(j).slice(0, 300)); return }
  const qv = j.data.map(d => Float32Array.from(d.embedding))
  const topk = (name, q, k) => mem.prepare(`SELECT id FROM ${name} WHERE e MATCH ${variants[name].q} AND k = ?`).all(buf(variants[name].enc(q)), k).map(r => r.id)
  const base = {}; for (const k of K) base[k] = qv.map(q => topk('f1536', q, k))
  console.log(`docs=${N} queries=${qv.length} maxAbs=${maxAbs.toFixed(4)} tokens=${j.usage?.total_tokens}`)
  for (const name of Object.keys(variants)) {
    const out = [name.padEnd(16)]
    for (const k of K) {
      let hit = 0, t = Date.now()
      qv.forEach((q, i) => { const s = new Set(base[k][i]); for (const id of topk(name, q, k)) if (s.has(id)) hit++ })
      out.push(`recall@${k}=${(hit / (k * qv.length)).toFixed(3)} ${((Date.now() - t) / qv.length).toFixed(1)}ms/q`)
    }
    console.log(out.join('  '))
  }
})()
