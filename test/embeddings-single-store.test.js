// The vec index is the only vector store (2026-10-27).
//
// service_embeddings held a float32 copy of every vector that nothing in production read:
// search queries vec_service_embeddings, and the pure-JS fallback refused to run above 5,000
// rows. At 215,687 rows the copy was 1,687 MB of a 3.9 GB file on a 4.6 GB volume and had
// tripped the health checker's 80% disk guard. These tests pin the single-store contract:
// nothing writes service_embeddings, everything that used to read it reads the vec index or
// refuses with a reason, and the health counters stay meaningful once the table is empty.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIMS = 1536
const originalFetch = globalThis.fetch

let db, SQLITE_VEC_AVAILABLE, getVecIndexStats, generateEmbedding

function vector(seed) {
  const v = new Float32Array(DIMS)
  let mag = 0
  for (let i = 0; i < DIMS; i++) { v[i] = Math.sin(seed * (i + 1)); mag += v[i] * v[i] }
  mag = Math.sqrt(mag)
  for (let i = 0; i < DIMS; i++) v[i] /= mag
  return v
}

function stubFetch(vec) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ embedding: Array.from(vec) }], model: 'text-embedding-3-small' }),
  })
}

function insertService(id) {
  db.prepare(`
    INSERT OR REPLACE INTO services (id, name, description, url, protocol, source, status, hostname)
    VALUES (?, ?, 'single store probe', ?, 'x402', 'test', 'active', 'single.example.com')
  `).run(id, `Single ${id}`, `https://${id}.single.example.com/api`)
}

const IDS = ['single-write', 'single-stats-a', 'single-stats-b']
function cleanup() {
  for (const id of IDS) {
    try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch { /* ignore */ }
  }
}

function runChild(code, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT, env: { ...process.env, DB_PATH: ':memory:', ...env },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    })
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' }
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
  }
}

before(async () => {
  process.env.OPENAI_API_KEY = 'test-key-fake'
  const dbMod = await import('../src/db.js')
  db = dbMod.default
  SQLITE_VEC_AVAILABLE = dbMod.SQLITE_VEC_AVAILABLE
  getVecIndexStats = dbMod.getVecIndexStats
  generateEmbedding = (await import('../src/services/embeddings.js')).generateEmbedding
  cleanup()
})

after(() => { cleanup(); globalThis.fetch = originalFetch })

describe('the vec index is the only vector store', () => {
  it('generateEmbedding writes the vec index and leaves service_embeddings alone', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    insertService('single-write')
    stubFetch(vector(1.5))
    await generateEmbedding('single-write')

    const vecRow = db.prepare('SELECT LENGTH(embedding) AS len FROM vec_service_embeddings WHERE service_id = ?').get('single-write')
    assert.equal(vecRow?.len, DIMS * 4, 'the vec index must hold the full float32 vector')
    const blob = db.prepare('SELECT COUNT(*) AS c FROM service_embeddings WHERE service_id = ?').get('single-write').c
    assert.equal(blob, 0, 'service_embeddings must not be written: it duplicated 1.7 GB nobody read')
  })

  it('no source file or script inserts into service_embeddings', () => {
    const files = [
      ...readdirSync(join(ROOT, 'src'), { recursive: true }).map(f => join(ROOT, 'src', f)),
      ...readdirSync(join(ROOT, 'scripts'), { recursive: true }).map(f => join(ROOT, 'scripts', f)),
    ].filter(f => /\.(m?js|cjs)$/.test(f))
    const writers = files.filter(f => /INSERT\s+(OR\s+\w+\s+)?INTO\s+service_embeddings/i.test(readFileSync(f, 'utf8')))
    assert.deepEqual(writers.map(f => f.slice(ROOT.length + 1)), [])
  })

  it('getVecIndexStats counts vectors from the vec index, so /health does not read 0 once the copy is gone', (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    const before = getVecIndexStats()
    insertService('single-stats-a')
    insertService('single-stats-b')
    const ins = db.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)')
    ins.run('single-stats-a', Buffer.from(vector(2).buffer))
    ins.run('single-stats-b', Buffer.from(vector(3).buffer))
    const after = getVecIndexStats()
    assert.equal(after.indexed - before.indexed, 2)
    assert.equal(after.embeddings, after.indexed, 'embeddings and indexed are the same store now')
  })
})

describe('former readers of service_embeddings', () => {
  it('search without sqlite-vec reports vec-unavailable instead of silently scoring nothing', () => {
    const { exitCode, stdout, stderr } = runChild(`
      import db from './src/db.js'
      import { queryServicesHybrid, API_COLUMNS } from './src/queries/services.js'
      globalThis.fetch = async () => ({ ok: true, status: 200,
        json: async () => ({ data: [{ embedding: new Array(1536).fill(0.025) }] }) })
      db.prepare("INSERT INTO services (id, name, url, protocol, source, status, hostname) VALUES ('nv1', 'Weather', 'https://nv1.test', 'x402', 'test', 'active', 'nv1.test')").run()
      const r = await queryServicesHybrid(db, { q: 'forecast', rawLimit: 10 }, API_COLUMNS)
      console.log('REASON=' + r.degradedReason)
    `, { DISABLE_SQLITE_VEC: '1', OPENAI_API_KEY: 'fake' })
    assert.equal(exitCode, 0, stderr)
    assert.match(stdout, /REASON=vec-unavailable/)
  })

  it('backfill-vec-index refuses: there is no second copy to load from any more', () => {
    const { exitCode, stderr } = runChild(`
      process.argv = ['node', 'scripts/backfill-vec-index.mjs', '--yes']
      await import('./scripts/backfill-vec-index.mjs')
    `)
    assert.equal(exitCode, 1)
    assert.match(stderr, /backfill-embeddings/, 'must point the operator at the script that can rebuild')
  })

  it('backfill-embeddings finds missing vectors in the vec index and writes only there', (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    const { exitCode, stdout, stderr } = runChild(`
      let fetches = 0
      globalThis.fetch = async () => { fetches++; return { ok: true,
        json: async () => ({ data: [{ embedding: new Array(1536).fill(0).map((_, i) => Math.sin(i) / 28) }] }) } }
      let __code = null
      const realExit = process.exit.bind(process)
      process.exit = c => { __code = c ?? 0 }
      import db from './src/db.js'
      for (const id of ['b1', 'b2', 'b3']) db.prepare("INSERT INTO services (id, name, url, protocol, source) VALUES (?, ?, ?, 'x402', 'test')").run(id, id, 'https://' + id + '.test')
      db.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)').run('b1', Buffer.from(new Float32Array(1536).fill(0.025).buffer))
      db.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)').run('ghost', Buffer.from(new Float32Array(1536).fill(0.025).buffer))
      process.argv = ['node', 'scripts/backfill-embeddings.mjs', '--yes', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')
      const vec = db.prepare('SELECT service_id FROM vec_service_embeddings ORDER BY service_id').all().map(r => r.service_id).join(',')
      const blobs = db.prepare('SELECT COUNT(*) AS c FROM service_embeddings').get().c
      console.log(JSON.stringify({ fetches, vec, blobs, code: __code }))
      realExit(0)
    `, { OPENAI_API_KEY: 'fake-key' })
    assert.equal(exitCode, 0, stderr)
    const last = JSON.parse(stdout.trim().split('\n').pop())
    assert.equal(last.fetches, 2, 'b1 is already indexed; only b2 and b3 need OpenAI')
    assert.equal(last.vec, 'b1,b2,b3', 'orphan vector for a service that no longer exists is removed')
    assert.equal(last.blobs, 0)
    assert.equal(last.code, 0)
  })
})
