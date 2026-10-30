// Regression tests for the permanent search degradation found 2026-07-25.
//
// Root cause: `vec_service_embeddings` was queried by src/queries/services.js but
// created nowhere in src/ — only inside test/queries-hybrid.test.js. In production
// the KNN query threw `no such table` on every search, the bare `catch {}` relabelled
// it `vec-deadline`, and 100% of q= searches silently fell back to LIKE-only.
//
// These tests fail against the pre-fix tree. Each one asserts a distinct part of the
// contract: the index exists, the write path keeps it current, thrown errors are not
// disguised as timeouts, and a production-scale index answers well inside the budget.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'

const require = createRequire(import.meta.url)

const DIMS = 1536
const originalFetch = globalThis.fetch

let db, SQLITE_VEC_AVAILABLE, ensureVecIndex, syncVecEmbedding, deleteVecEmbedding, hasVecIndexOn
let queryServicesHybrid, API_COLUMNS
let generateEmbedding, resetQueryEmbeddingCache, getQueryEmbeddingCacheStats

function makeVector(seed) {
  const v = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(seed * (i + 1)) * 0.1
  let mag = 0
  for (let i = 0; i < DIMS; i++) mag += v[i] * v[i]
  mag = Math.sqrt(mag) || 1
  for (let i = 0; i < DIMS; i++) v[i] /= mag
  return v
}

const QUERY_VEC = makeVector(1.0)
const NEAR_VEC = makeVector(1.02)
const FAR_VEC = makeVector(7.0)

function stubEmbedFetch(vec, { delayMs = 0, fail = false } = {}) {
  globalThis.fetch = async () => {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    if (fail) return { ok: false, status: 500, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: Array.from(vec) }], model: 'text-embedding-3-small' }),
    }
  }
}

function insertService(id, name, opts = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
    VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, ?, 'test.example.com', datetime('now'), datetime('now'))
  `).run(id, name, opts.description ?? `${name} description`, `https://vecidx-${id}.example.com/api`, opts.category ?? 'uncategorized')
}

const TEST_IDS = ['vecidx-near', 'vecidx-far', 'vecidx-sync', 'vecidx-writepath']

function cleanup() {
  for (const id of TEST_IDS) {
    try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(id) } catch { /* table may not exist pre-fix */ }
    try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch { /* ignore */ }
  }
}

before(async () => {
  process.env.OPENAI_API_KEY = 'test-key-fake'

  const dbMod = await import('../src/db.js')
  db = dbMod.default
  SQLITE_VEC_AVAILABLE = dbMod.SQLITE_VEC_AVAILABLE
  ensureVecIndex = dbMod.ensureVecIndex
  syncVecEmbedding = dbMod.syncVecEmbedding
  deleteVecEmbedding = dbMod.deleteVecEmbedding
  hasVecIndexOn = dbMod.hasVecIndex

  const queries = await import('../src/queries/services.js')
  queryServicesHybrid = queries.queryServicesHybrid
  API_COLUMNS = queries.API_COLUMNS

  const emb = await import('../src/services/embeddings.js')
  generateEmbedding = emb.generateEmbedding
  resetQueryEmbeddingCache = emb.resetQueryEmbeddingCache
  getQueryEmbeddingCacheStats = emb.getQueryEmbeddingCacheStats

  cleanup()
})

after(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('vec index is created by src/db.js, not only by tests', () => {
  it('db.js creates vec_service_embeddings at boot when sqlite-vec is available', () => {
    if (!SQLITE_VEC_AVAILABLE) {
      assert.ok(true, 'sqlite-vec unavailable — vec index not expected')
      return
    }
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'vec_service_embeddings'"
    ).get()
    assert.equal(row.c, 1, 'src/db.js must create vec_service_embeddings — production had no such table')
  })

  it('exports ensureVecIndex as an idempotent, injectable helper', () => {
    assert.equal(typeof ensureVecIndex, 'function', 'db.js must export ensureVecIndex')
    // Idempotent: calling it twice must not throw.
    ensureVecIndex(db)
    ensureVecIndex(db)
  })

  it('ensureVecIndex creates the index on a fresh database handle', (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    const fresh = new Database(':memory:')
    require('sqlite-vec').load(fresh)
    const before = fresh.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'vec_service_embeddings'").get().c
    assert.equal(before, 0)
    ensureVecIndex(fresh)
    const after = fresh.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'vec_service_embeddings'").get().c
    assert.equal(after, 1, 'ensureVecIndex must create the vec0 table')
    fresh.close()
  })
})

describe('embedding write path keeps the vec index in sync', () => {
  it('syncVecEmbedding upserts a vector that KNN can then retrieve', (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    insertService('vecidx-sync', 'VecSyncProbe')
    const blob = Buffer.from(NEAR_VEC.buffer)
    syncVecEmbedding('vecidx-sync', blob, db)

    const hit = db.prepare(
      'SELECT service_id FROM vec_service_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
    ).all(Buffer.from(QUERY_VEC.buffer), 5)
    assert.ok(hit.some(r => r.service_id === 'vecidx-sync'), 'synced vector must be retrievable by KNN')

    // Idempotent: a second sync must not duplicate the row.
    syncVecEmbedding('vecidx-sync', blob, db)
    const count = db.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings WHERE service_id = ?').get('vecidx-sync').c
    assert.equal(count, 1, 'syncVecEmbedding must upsert, not duplicate')
  })

  it('deleteVecEmbedding removes the vector', (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    deleteVecEmbedding('vecidx-sync', db)
    const count = db.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings WHERE service_id = ?').get('vecidx-sync').c
    assert.equal(count, 0, 'deleteVecEmbedding must remove the row')
  })

  it('generateEmbedding writes the vec index (and only the vec index)', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    insertService('vecidx-writepath', 'VecWritePathProbe')
    stubEmbedFetch(NEAR_VEC)
    await generateEmbedding('vecidx-writepath')

    const blobRow = db.prepare('SELECT COUNT(*) AS c FROM service_embeddings WHERE service_id = ?').get('vecidx-writepath').c
    assert.equal(blobRow, 0, 'service_embeddings is no longer a vector store (2026-10-27)')
    const vecRow = db.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings WHERE service_id = ?').get('vecidx-writepath').c
    assert.equal(vecRow, 1, 'vec index must be written by the same code path — otherwise it drifts permanently')
  })
})

describe('purge keeps the vec index consistent without breaking bare handles', () => {
  // Regression: guarding the purge's vec DELETE on SQLITE_VEC_AVAILABLE (the extension
  // flag) rather than on the table actually existing threw inside purgeSoftDeleted's
  // transaction on any injected handle that had no index, rolling the whole purge back.
  function bareDb() {
    const d = new Database(':memory:')
    if (SQLITE_VEC_AVAILABLE) { try { require('sqlite-vec').load(d) } catch { /* optional */ } }
    d.pragma('foreign_keys = ON')
    d.exec(`
      CREATE TABLE services (id TEXT PRIMARY KEY, provider_deleted INTEGER DEFAULT 0, deleted_at TEXT);
      CREATE TABLE health_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL REFERENCES services(id));
      CREATE TABLE service_embeddings (service_id TEXT PRIMARY KEY REFERENCES services(id), embedding BLOB NOT NULL, model TEXT NOT NULL, embedded_at INTEGER NOT NULL);
    `)
    d.prepare("INSERT INTO services (id, provider_deleted, deleted_at) VALUES ('old', 1, datetime('now', '-45 days'))").run()
    d.prepare("INSERT INTO health_checks (service_id) VALUES ('old')").run()
    d.prepare("INSERT INTO service_embeddings VALUES ('old', ?, 'text-embedding-3-small', 0)").run(Buffer.from(NEAR_VEC.buffer))
    return d
  }

  it('purges normally on a handle that has no vec index', async () => {
    const { purgeSoftDeleted } = await import('../src/db.js')
    const d = bareDb()
    assert.equal(hasVecIndexOn(d), false, 'this handle must have no vec index')
    assert.equal(purgeSoftDeleted(d), 1, 'a missing vec index must not roll back the purge')
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM services').get().c, 0)
    d.close()
  })

  it('also clears vec rows on a handle that has the index', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    const { purgeSoftDeleted } = await import('../src/db.js')
    const d = bareDb()
    ensureVecIndex(d)
    syncVecEmbedding('old', Buffer.from(NEAR_VEC.buffer), d)
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings').get().c, 1)

    assert.equal(purgeSoftDeleted(d), 1)
    assert.equal(
      d.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings').get().c, 0,
      'purged services must not leave vectors behind to keep scoring in KNN'
    )
    d.close()
  })
})

describe('search is not degraded when the vec index exists', () => {
  it('returns degradedReason === null for a normal query', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    insertService('vecidx-near', 'Meteorological Feed', { description: 'atmospheric readings' })
    insertService('vecidx-far', 'Unrelated Widget', { description: 'nothing alike' })
    syncVecEmbedding('vecidx-near', Buffer.from(NEAR_VEC.buffer), db)
    syncVecEmbedding('vecidx-far', Buffer.from(FAR_VEC.buffer), db)

    stubEmbedFetch(QUERY_VEC)
    const res = await queryServicesHybrid(db, { q: 'weather forecast' }, API_COLUMNS)
    assert.equal(res.degradedReason, null, `search must not degrade; got ${res.degradedReason}`)
  })

  it('surfaces the semantic-only match that LIKE alone would miss', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    stubEmbedFetch(QUERY_VEC)
    const res = await queryServicesHybrid(db, { q: 'weather forecast' }, API_COLUMNS)
    const ids = res.services.map(s => s.id)
    assert.ok(ids.includes('vecidx-near'), 'semantic neighbour must appear — this is the whole point of the vec path')
  })
})

describe('failure reasons are reported honestly', () => {
  it('does not report a thrown vec error as vec-deadline', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    // Force the KNN query to throw by pointing the code at a dropped index.
    db.exec('ALTER TABLE vec_service_embeddings RENAME TO vec_service_embeddings_stashed')
    try {
      stubEmbedFetch(QUERY_VEC)
      const res = await queryServicesHybrid(db, { q: 'weather forecast' }, API_COLUMNS)
      assert.ok(res.degradedReason, 'a broken vec index must still degrade')
      assert.notEqual(
        res.degradedReason, 'vec-deadline',
        'a thrown error must NOT be labelled vec-deadline — that mislabel hid this bug for months'
      )
      assert.equal(res.degradedReason, 'vec-error')
    } finally {
      db.exec('ALTER TABLE vec_service_embeddings_stashed RENAME TO vec_service_embeddings')
    }
  })

  it('still returns LIKE results when the vec path fails', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    db.exec('ALTER TABLE vec_service_embeddings RENAME TO vec_service_embeddings_stashed')
    try {
      stubEmbedFetch(QUERY_VEC)
      const res = await queryServicesHybrid(db, { q: 'Meteorological' }, API_COLUMNS)
      assert.ok(res.services.length > 0, 'degraded search must still serve LIKE results')
    } finally {
      db.exec('ALTER TABLE vec_service_embeddings_stashed RENAME TO vec_service_embeddings')
    }
  })
})

describe('query embedding cache keeps repeat searches off the OpenAI path', () => {
  it('serves a repeated query from cache without a second fetch', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    assert.equal(typeof resetQueryEmbeddingCache, 'function', 'embeddings.js must export resetQueryEmbeddingCache')
    resetQueryEmbeddingCache()

    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount++
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: Array.from(QUERY_VEC) }] }) }
    }

    await queryServicesHybrid(db, { q: 'cached weather query' }, API_COLUMNS)
    assert.equal(fetchCount, 1, 'first search must call OpenAI once')

    await queryServicesHybrid(db, { q: 'cached weather query' }, API_COLUMNS)
    assert.equal(fetchCount, 1, 'repeat search must be served from cache — OpenAI round-trip dominates p95')

    const stats = getQueryEmbeddingCacheStats()
    assert.ok(stats.hits >= 1, 'cache must record a hit')
  })

  it('does not cache failed embedding attempts', async (t) => {
    if (!SQLITE_VEC_AVAILABLE) return t.skip('sqlite-vec unavailable')
    resetQueryEmbeddingCache()
    let fetchCount = 0
    globalThis.fetch = async () => { fetchCount++; return { ok: false, status: 500, json: async () => ({}) } }

    await queryServicesHybrid(db, { q: 'never cached failure' }, API_COLUMNS)
    await queryServicesHybrid(db, { q: 'never cached failure' }, API_COLUMNS)
    assert.equal(fetchCount, 2, 'a failed embed must not be cached — otherwise one blip degrades that query forever')
  })
})

// ─── Production-scale latency ────────────────────────────────────────────────
// Runs against an isolated file-backed DB so the 80k fixture never lands in the
// shared :memory: test database. Set SKIP_VEC_SCALE_TEST=1 to skip on small runners.
describe('production-scale vec index answers inside the deadline', () => {
  let scaleDir, scaleDb
  const N = Number(process.env.VEC_SCALE_ROWS || 80000)
  const DEADLINE_MS = 500

  before(() => {
    if (!SQLITE_VEC_AVAILABLE || process.env.SKIP_VEC_SCALE_TEST === '1') return
    scaleDir = mkdtempSync(join(tmpdir(), '402index-vecscale-'))
    scaleDb = new Database(join(scaleDir, 'scale.db'))
    require('sqlite-vec').load(scaleDb)
    ensureVecIndex(scaleDb)

    const ins = scaleDb.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)')
    const tx = scaleDb.transaction(() => {
      for (let i = 0; i < N; i++) {
        const v = new Float32Array(DIMS)
        for (let j = 0; j < DIMS; j++) v[j] = Math.sin(i * 0.0007 + j * 0.013)
        let m = 0
        for (let j = 0; j < DIMS; j++) m += v[j] * v[j]
        m = Math.sqrt(m) || 1
        for (let j = 0; j < DIMS; j++) v[j] /= m
        ins.run(`scale-${i}`, Buffer.from(v.buffer))
      }
    })
    tx()
  })

  after(() => {
    try { scaleDb?.close() } catch { /* ignore */ }
    if (scaleDir) rmSync(scaleDir, { recursive: true, force: true })
  })

  it(`answers a top-50 KNN over ${N} rows well inside the ${DEADLINE_MS}ms budget`, (t) => {
    if (!SQLITE_VEC_AVAILABLE || process.env.SKIP_VEC_SCALE_TEST === '1') return t.skip('scale test skipped')

    const rows = scaleDb.prepare('SELECT COUNT(*) AS c FROM vec_service_embeddings').get().c
    assert.equal(rows, N, 'fixture must be fully seeded')

    const stmt = scaleDb.prepare(
      'SELECT service_id, distance FROM vec_service_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
    )
    const qblob = Buffer.from(QUERY_VEC.buffer)

    const timings = []
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint()
      const out = stmt.all(qblob, 50)
      timings.push(Number(process.hrtime.bigint() - t0) / 1e6)
      assert.equal(out.length, 50, 'KNN must return the full top-K')
    }
    timings.sort((a, b) => a - b)
    const median = timings[2]
    const worst = timings[4]

    assert.ok(
      worst < DEADLINE_MS,
      `slowest KNN over ${N} rows was ${worst.toFixed(1)}ms, must be under ${DEADLINE_MS}ms (median ${median.toFixed(1)}ms)`
    )
  })
})
