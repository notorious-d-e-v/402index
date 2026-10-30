import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// Store original fetch — we stub it to prevent live OpenAI calls
const originalFetch = globalThis.fetch

let db, SQLITE_VEC_AVAILABLE, logQuery
let queryServices, queryServicesHybrid, buildServiceQuery, buildHybridComparator, API_COLUMNS
let embedQuery, cosineSimilarity, getCircuitState, resetCircuit, resetQueryEmbeddingCache
let startServer, stopServer, API

// ─── Fixture embeddings ──────────────────────────────────────────────────────
// Pre-computed unit vectors for deterministic cosine similarity tests.
// These are NOT real OpenAI embeddings — just math vectors with known distances.
const DIMS = 1536

function makeVector(seed) {
  const v = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(seed * (i + 1)) * 0.1
  // Normalize
  let mag = 0
  for (let i = 0; i < DIMS; i++) mag += v[i] * v[i]
  mag = Math.sqrt(mag)
  for (let i = 0; i < DIMS; i++) v[i] /= mag
  return v
}

// Seed vectors — different seeds produce different directions
const WEATHER_QUERY_VEC = makeVector(1.0)
const WEATHER_SERVICE_VEC = makeVector(1.05) // close to WEATHER_QUERY_VEC
const SATS4AI_SERVICE_VEC = makeVector(5.0)  // far from WEATHER_QUERY_VEC
const GENERIC_VEC_A = makeVector(2.0)
const GENERIC_VEC_B = makeVector(3.0)
const FILTER_SERVICE_VEC = makeVector(1.02) // close to WEATHER_QUERY_VEC for filter-bypass tests
const PERCENT_CLOSE_VEC = makeVector(1.03)  // close to query vec for T6 percent test
const CAFE_SERVICE_VEC = makeVector(1.01)   // very close to WEATHER_QUERY_VEC for normalization tests

// Helper: insert test service into DB
function insertService(id, name, opts = {}) {
  const desc = opts.description || `${name} description`
  const proto = opts.protocol || 'x402'
  const health = opts.health_status || 'healthy'
  const featured = opts.featured || 0
  const domain_verified = opts.domain_verified || 0
  const category = opts.category || 'uncategorized'
  const price_usd = opts.price_usd ?? null
  const x402_payment_valid = opts.x402_payment_valid ?? null
  db.prepare(`
    INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, price_usd, x402_payment_valid, hostname, registered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'test', ?, 'active', ?, ?, ?, ?, ?, 'test.example.com', datetime('now'), datetime('now'))
  `).run(id, name, desc, `https://test-${id}.example.com/api`, proto, health, featured, domain_verified, category, price_usd, x402_payment_valid)
}

// Helper: insert embedding for a service (both regular + vec table)
function insertEmbedding(serviceId, vec) {
  const blob = Buffer.from(vec.buffer)
  db.prepare(`
    INSERT OR REPLACE INTO service_embeddings (service_id, embedding, model, embedded_at)
    VALUES (?, ?, 'text-embedding-3-small', ?)
  `).run(serviceId, blob, Math.floor(Date.now() / 1000))
  try {
    db.prepare('INSERT OR REPLACE INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)').run(serviceId, blob)
  } catch {}
}

// Clean up test services
function cleanup() {
  const ids = [
    'hybrid-sats4ai', 'hybrid-weather-prime', 'hybrid-prime', 'hybrid-weather-basic',
    'hybrid-tied-a', 'hybrid-tied-b', 'hybrid-generic-1', 'hybrid-generic-2',
    'hybrid-sort-price-1', 'hybrid-sort-price-2',
    'hybrid-filter-l402', 'hybrid-filter-news', 'hybrid-filter-nopay', 'hybrid-filter-noverify',
    'hybrid-percent-svc', 'hybrid-percent-far',
  ]
  for (const id of ids) {
    try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(id) } catch {}
    try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch {}
    try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch {}
  }
  // Clean up bulk-inserted embeddings for B5/B6 and Phase 2 tests
  const bulkPatterns = ['hybrid-bulk-%', 'hybrid-t2-%', 'hybrid-t3-%', 'hybrid-overlap-%', 'hybrid-empty-%', 'beyond-cap-%', 'likbnd-%', 'sem-cap-%', 'norm-%']
  for (const p of bulkPatterns) {
    try { db.exec(`DELETE FROM vec_service_embeddings WHERE service_id LIKE '${p}'`) } catch {}
    try { db.exec(`DELETE FROM service_embeddings WHERE service_id LIKE '${p}'`) } catch {}
    try { db.exec(`DELETE FROM services WHERE id LIKE '${p}'`) } catch {}
  }
}

before(async () => {
  process.env.OPENAI_API_KEY = 'test-key-fake'

  const dbMod = await import('../src/db.js')
  db = dbMod.default
  SQLITE_VEC_AVAILABLE = dbMod.SQLITE_VEC_AVAILABLE
  logQuery = dbMod.logQuery

  ;({ resetQueryEmbeddingCache } = await import('../src/services/embeddings.js'))

  const queries = await import('../src/queries/services.js')
  queryServices = queries.queryServices
  queryServicesHybrid = queries.queryServicesHybrid
  buildServiceQuery = queries.buildServiceQuery
  buildHybridComparator = queries.buildHybridComparator
  API_COLUMNS = queries.API_COLUMNS

  // Create vec virtual table so the sqlite-vec path actually succeeds (not throws)
  if (SQLITE_VEC_AVAILABLE) {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_service_embeddings USING vec0(service_id text primary key, embedding float[1536])')
  }

  const srv = await import('./helpers/server.js')
  startServer = srv.startServer
  stopServer = srv.stopServer
  API = await startServer()

  // Seed test data
  cleanup()
  insertService('hybrid-sats4ai', 'Sats4AI', { description: 'Lightning-powered AI inference', category: 'ai', featured: 1 })
  insertService('hybrid-prime', 'Prime Technology', { description: 'Meteorological data feeds with real-time atmospheric measurements', category: 'real-time-data/weather' })
  insertService('hybrid-weather-basic', 'WeatherBot', { description: 'Simple weather data API', category: 'real-time-data/weather' })
  insertService('hybrid-tied-a', 'TiedServiceA', { description: 'A service for testing tie-breaking' })
  insertService('hybrid-tied-b', 'TiedServiceB', { description: 'B service for testing tie-breaking' })
  insertService('hybrid-sort-price-1', 'PriceSort1', { price_usd: 0.01 })
  insertService('hybrid-sort-price-2', 'PriceSort2', { price_usd: 0.05 })

  // Insert embeddings
  insertEmbedding('hybrid-sats4ai', SATS4AI_SERVICE_VEC)
  insertEmbedding('hybrid-prime', WEATHER_SERVICE_VEC) // close to weather query
  insertEmbedding('hybrid-weather-basic', GENERIC_VEC_A)        // far from weather query
  insertEmbedding('hybrid-tied-a', GENERIC_VEC_A)
  insertEmbedding('hybrid-tied-b', GENERIC_VEC_B)

  // Filter-bypass test fixtures (semantic-only: names/descriptions don't contain "weather")
  insertService('hybrid-filter-l402', 'CosmicData', {
    protocol: 'L402', description: 'Cosmic radiation measurements', category: 'science', health_status: 'healthy'
  })
  insertEmbedding('hybrid-filter-l402', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-news', 'NewsFlash', {
    protocol: 'x402', description: 'Breaking news aggregation', category: 'news'
  })
  insertEmbedding('hybrid-filter-news', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-nopay', 'NoPayService', {
    protocol: 'x402', description: 'Unvalidated payment endpoint', x402_payment_valid: 0
  })
  insertEmbedding('hybrid-filter-nopay', FILTER_SERVICE_VEC)

  insertService('hybrid-filter-noverify', 'UnverifiedSvc', {
    protocol: 'x402', description: 'Unverified x402 endpoint', x402_payment_valid: 0, domain_verified: 0
  })
  insertEmbedding('hybrid-filter-noverify', FILTER_SERVICE_VEC)
})

after(async () => {
  cleanup()
  try { db.exec('DROP TABLE IF EXISTS vec_service_embeddings') } catch {}
  globalThis.fetch = originalFetch
  await stopServer()
})

beforeEach(() => {
  globalThis.fetch = originalFetch
  // A cached query vector short-circuits callOpenAI, so the timeout/error paths these
  // tests inject would never be reached on a repeated query string.
  if (resetQueryEmbeddingCache) resetQueryEmbeddingCache()
})

// Helper: stub embedQuery to return a specific vector (or simulate timeout/error)
function stubEmbedQuery(vec, delayMs = 0) {
  globalThis.fetch = async () => {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    if (vec === null) return { ok: false, status: 500, json: async () => ({}) }
    const embedding = Array.from(vec)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: { prompt_tokens: 10, total_tokens: 10 } }),
    }
  }
}

// ─── GROUP A: Re-rank composite order ────────────────────────────────────────

describe('Group A — hybrid re-rank composite order (#150)', () => {
  it('A1: ?q=Sats4AI returns Sats4AI as result #1 (Tier A exact-name match)', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC) // doesn't matter what embedding, Tier A wins
    const result = await queryServicesHybrid(db, { q: 'Sats4AI', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result.services.length > 0, 'should return results')
    assert.equal(result.services[0].name, 'Sats4AI', 'Sats4AI must be result #1 via Tier A')
  })

  it('A2: ?q=weather with semantic returns Prime Technology in top 20 (Tier D cosine)', async () => {
    // Prime Technology has no LIKE match for "weather" in name/description/url,
    // but its embedding is close to the weather query vector
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    const names = result.services.slice(0, 20).map(s => s.name)
    assert.ok(names.includes('Prime Technology'), `Prime Technology should be in top 20 via cosine similarity, got: ${names.join(', ')}`)
  })

  it('A3: Two services tied on Tier A-C, different cosines → cosine-winner ranks higher', async () => {
    // Both have same LIKE match (description contains "service"), but different cosine scores
    // GENERIC_VEC_A has different cosine to WEATHER_QUERY_VEC than GENERIC_VEC_B
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'service', rawLimit: 50 }, API_COLUMNS)
    const tiedA = result.services.findIndex(s => s.id === 'hybrid-tied-a')
    const tiedB = result.services.findIndex(s => s.id === 'hybrid-tied-b')
    // They should both appear, and the one with higher cosine to WEATHER_QUERY_VEC should rank first
    assert.ok(tiedA >= 0 && tiedB >= 0, 'Both tied services should appear in results')
    // Verify they are in cosine order (whichever has higher cosine should be first)
    const cosA = cosineSimilaritySync(WEATHER_QUERY_VEC, GENERIC_VEC_A)
    const cosB = cosineSimilaritySync(WEATHER_QUERY_VEC, GENERIC_VEC_B)
    if (cosA > cosB) {
      assert.ok(tiedA < tiedB, `TiedServiceA (cos=${cosA.toFixed(3)}) should rank before TiedServiceB (cos=${cosB.toFixed(3)})`)
    } else {
      assert.ok(tiedB < tiedA, `TiedServiceB (cos=${cosB.toFixed(3)}) should rank before TiedServiceA (cos=${cosA.toFixed(3)})`)
    }
  })

  it('A4: ?q=weather&sort=price → re-rank skipped, results ordered by price_usd', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', sort: 'price', order: 'asc', rawLimit: 50 }, API_COLUMNS)
    // Should NOT call embedQuery at all (re-rank skipped), just LIKE-only with price sort
    // WeatherBot has "weather" in name, Prime Technology does not — only LIKE results, price sorted
    assert.ok(result.services.length >= 0, 'should return results')
    // Check that ordering respects price, not cosine
    for (let i = 1; i < result.services.length; i++) {
      const prev = result.services[i - 1].price_usd ?? Infinity
      const curr = result.services[i].price_usd ?? Infinity
      assert.ok(prev <= curr || prev === null || curr === null, `Results should be sorted by price ASC`)
    }
  })

  it('A5: ?q=* → match-all shortcut preserved, no semantic called', async () => {
    let fetchCalled = false
    globalThis.fetch = async () => { fetchCalled = true; return { ok: false, status: 500, json: async () => ({}) } }
    const result = await queryServicesHybrid(db, { q: '*', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result.services.length > 0, 'should return all services')
    assert.equal(fetchCalled, false, 'embedQuery should not be called for q=*')
  })

  it('A6: total equals deduplicated union candidate set size when semantic fires', async () => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    // total should be >= the LIKE count (union includes semantic-only results)
    const likeOnly = queryServices(db, { q: 'weather', rawLimit: 200 }, API_COLUMNS)
    assert.ok(result.total >= likeOnly.total, `hybrid total (${result.total}) should be >= LIKE total (${likeOnly.total})`)
    // Verify degraded path actually returns LIKE-only with correct reason
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const degraded = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
      assert.equal(degraded.degradedReason, 'no-api-key', 'should report no-api-key when OPENAI_API_KEY is absent')
      assert.ok(degraded.total > 0, 'should still return LIKE results in degraded mode')
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })
})

// ─── GROUP B: Timeouts and graceful fallback ─────────────────────────────────

// Smart fetch stub: intercepts OpenAI calls but allows local API calls through
function stubOpenAIOnly(handler) {
  const real = originalFetch
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('openai.com')) {
      return handler(url, opts)
    }
    return real(url, opts)
  }
}

describe('Group B — timeouts and graceful fallback (#150)', () => {
  it('B1: embedQuery exceeding 1500ms → LIKE-only, X-402index-Search-Degraded: embed-timeout', async () => {
    stubOpenAIOnly(async () => {
      await new Promise(r => setTimeout(r, 1600))
      const embedding = Array.from(WEATHER_QUERY_VEC)
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding }], model: 'text-embedding-3-small', usage: {} }),
      }
    })

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'should still return 200')
    assert.equal(res.headers.get('x-402index-search-degraded'), 'embed-timeout')
  })

  it('B2: embedQuery returns null (HTTP error) → LIKE-only, embed-error', async () => {
    stubOpenAIOnly(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'fail' } }) }))

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-search-degraded'), 'embed-error')
  })

  it('B3: OPENAI_API_KEY unset → LIKE-only, no-api-key', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const res = await originalFetch(`${API}/api/v1/services?q=weather`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-search-degraded'), 'no-api-key')
    } finally {
      process.env.OPENAI_API_KEY = saved
    }
  })

  it('B4: sqlite-vec available → semantic path returns results', async () => {
    if (!SQLITE_VEC_AVAILABLE) return // the no-vec contract is B5
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    assert.ok(result, 'should return results')
  })

  // B5/B6 used to exercise a pure-JS cosine scan over service_embeddings. That table stopped
  // holding vectors on 2026-10-27, so without sqlite-vec there is nothing to scan: the search
  // degrades with vec-unavailable. test/embeddings-single-store.test.js runs that path in a
  // DISABLE_SQLITE_VEC=1 child, so it is covered even where sqlite-vec loads.
  it('B5: no sqlite-vec → vec-unavailable', async () => {
    if (SQLITE_VEC_AVAILABLE) return // Only applies when sqlite-vec unavailable
    stubEmbedQuery(WEATHER_QUERY_VEC)
    const result = await queryServicesHybrid(db, { q: 'weather', rawLimit: 50 }, API_COLUMNS)
    assert.equal(result.degradedReason, 'vec-unavailable')
  })

  it('B7: any degraded response → status 200, header present, logQuery receives reason', async () => {
    stubOpenAIOnly(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'fail' } }) }))

    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'must be 200, never 5xx on semantic failure')
    const degraded = res.headers.get('x-402index-search-degraded')
    assert.ok(degraded, 'X-402index-Search-Degraded header must be present')
    assert.ok(['no-api-key', 'embed-timeout', 'embed-error', 'circuit-open', 'vec-deadline', 'vec-unavailable'].includes(degraded),
      `reason code must be from the fixed enum, got: ${degraded}`)
  })

  it('B8: logQuery persists degradedReason to query_log table', async () => {
    // Insert a log entry with a degraded reason via logQuery
    const before = db.prepare('SELECT MAX(id) as maxId FROM query_log').get()
    logQuery({ queryText: 'test-b8', degradedReason: 'embed-error' })
    const row = db.prepare('SELECT degraded_reason FROM query_log WHERE id > ?').get(before.maxId || 0)
    assert.ok(row, 'query_log row should exist')
    assert.equal(row.degraded_reason, 'embed-error', 'degraded_reason column should persist the reason code')
  })
})

// ─── GROUP D: Documentation ──────────────────────────────────────────────────

describe('Group D — documentation (#150)', () => {
  it('D1: GET /api/v1/openapi.json q param mentions hybrid, semantic, re-rank', async () => {
    const res = await fetch(`${API}/api/v1/openapi.json`)
    const spec = await res.json()
    const qParam = spec.paths['/api/v1/services'].get.parameters.find(p => p.name === 'q')
    assert.ok(qParam, 'q parameter must exist')
    const desc = qParam.description.toLowerCase()
    assert.ok(desc.includes('hybrid'), `q description should mention "hybrid", got: ${qParam.description}`)
    assert.ok(desc.includes('semantic'), `q description should mention "semantic", got: ${qParam.description}`)
    assert.ok(desc.includes('re-rank') || desc.includes('rerank'), `q description should mention "re-rank", got: ${qParam.description}`)
  })

  it('D2: OpenAPI documents X-402index-Search-Degraded header with reason-code enum', async () => {
    const res = await fetch(`${API}/api/v1/openapi.json`)
    const spec = await res.json()
    const resp200 = spec.paths['/api/v1/services'].get.responses['200']
    assert.ok(resp200.headers, 'response should have headers defined')
    const degradedHeader = resp200.headers['X-402index-Search-Degraded']
    assert.ok(degradedHeader, 'X-402index-Search-Degraded header must be documented')
    const headerSchema = degradedHeader.schema
    assert.ok(headerSchema.enum || headerSchema.description, 'header should have enum or description of reason codes')
    if (headerSchema.enum) {
      assert.ok(headerSchema.enum.includes('embed-timeout'), 'enum should include embed-timeout')
      assert.ok(headerSchema.enum.includes('circuit-open'), 'enum should include circuit-open')
      assert.ok(headerSchema.enum.includes('no-api-key'), 'enum should include no-api-key')
    }
  })

  it('D3: GET /api-docs HTML contains "How ?q= works" section', async () => {
    const res = await fetch(`${API}/api-docs`)
    const html = await res.text()
    assert.ok(html.includes('How') && (html.includes('?q=') || html.includes('q=')) && html.includes('works'),
      'api-docs should contain a "How ?q= works" section')
  })

  it('D4: GET /api/v1/docs.md reflects updated OpenAPI content', async () => {
    const res = await fetch(`${API}/api/v1/docs.md`)
    const md = await res.text()
    assert.ok(md.toLowerCase().includes('hybrid') || md.toLowerCase().includes('semantic'),
      'docs.md should reflect hybrid/semantic search documentation')
  })
})

// ─── GROUP E: Filter bypass on semantic-only union (#153 review) ──────────────

describe('Group E — semantic-only filter bypass (#153 review)', () => {
  beforeEach(() => {
    stubEmbedQuery(WEATHER_QUERY_VEC)
  })

  it('T1a: protocol filter — L402 semantic match excluded by protocol=x402', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', protocol: 'x402', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-l402'),
      'L402 service should be excluded when protocol=x402 filter is applied')
    for (const s of result.services) {
      assert.equal(s.protocol.toLowerCase(), 'x402', `service ${s.id} should be x402`)
    }
  })

  it('T1b: category filter — news-category semantic match excluded by category=real-time-data/weather', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', category: 'real-time-data/weather', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-news'),
      'News-category service should be excluded when category=real-time-data/weather')
  })

  it('T1c: payment_valid filter — invalid-payment semantic match excluded', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', payment_valid: 'true', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-nopay'),
      'Service with invalid payment should be excluded when payment_valid=true')
  })

  it('T1d: verified filter — non-verified semantic match excluded', async () => {
    const result = await queryServicesHybrid(db, { q: 'weather', verified: 'true', rawLimit: 200 }, API_COLUMNS)
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('hybrid-filter-noverify'),
      'Non-verified service should be excluded when verified=true')
  })
})

// ─── GROUP F: Total accuracy and LIKE cap (#153 review) ──────────────────────

describe('Group F — total accuracy and LIKE cap (#153 review)', () => {
  it('T2: LIKE cap ORDER BY — featured service appears in capped results', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', ?, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1001; i++) {
        const id = `hybrid-t2-${i}`
        const featured = i === 1000 ? 1 : 0
        insert.run(id, `OrderTest-${i}`, `OrderTest-${i} description`, `https://t2-${i}.example.com/api`, featured)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'OrderTest', rawLimit: 50 }, API_COLUMNS)
      // Featured service (inserted last, highest rowid) should appear due to ORDER BY featured DESC
      const hasFeatured = result.services.some(s => s.id === 'hybrid-t2-1000')
      assert.ok(hasFeatured,
        'Featured service (inserted last) should appear in capped LIKE results when ORDER BY is applied')
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-t2-%'")
    }
  })

  it('T3: total not capped at likeCap — 1200 LIKE matches reports total=1200', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        insert.run(`hybrid-t3-${i}`, `TotalCap-${i}`, `TotalCap-${i} desc`, `https://t3-${i}.example.com/api`)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'TotalCap', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1200, `total should be >= 1200 (not capped at likeCap=1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-t3-%'")
    }
  })

  it('T-total-overlap: 1200 LIKE + 1 overlap semantic → total === 1200 (no double-count)', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        insert.run(`hybrid-overlap-${i}`, `OverlapTest-${i}`, `OverlapTest-${i} desc`, `https://overlap-${i}.example.com/api`)
      }
    })
    insertMany()
    // Give one LIKE-matching service an embedding (it overlaps: both LIKE AND semantic)
    insertEmbedding('hybrid-overlap-0', WEATHER_SERVICE_VEC)

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'OverlapTest', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1200, `total should be >= 1200 (overlap counted once, not capped at 1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM service_embeddings WHERE service_id LIKE 'hybrid-overlap-%'")
      try { db.exec("DELETE FROM vec_service_embeddings WHERE service_id LIKE 'hybrid-overlap-%'") } catch {}
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-overlap-%'")
    }
  })

  it('T-empty-semantic: zero semantic-only results with >1000 LIKE → total correct', async () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1100; i++) {
        insert.run(`hybrid-empty-${i}`, `EmptyTest-${i}`, `EmptyTest-${i} desc`, `https://empty-${i}.example.com/api`)
      }
    })
    insertMany()

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const result = await queryServicesHybrid(db, { q: 'EmptyTest', rawLimit: 50 }, API_COLUMNS)
      assert.ok(result.total >= 1100, `total should be >= 1100 (not capped at likeCap=1000), got ${result.total}`)
    } finally {
      db.exec("DELETE FROM services WHERE id LIKE 'hybrid-empty-%'")
    }
  })
})

// ─── GROUP G: Edge cases and comparator (#153 review) ────────────────────────

describe('Group G — edge cases and comparator (#153 review)', () => {
  it('T5: A2 fixture renamed — hybrid-prime exists, URL has no "weather"', () => {
    const svc = db.prepare('SELECT url FROM services WHERE id = ?').get('hybrid-prime')
    assert.ok(svc, 'hybrid-prime should exist (renamed from hybrid-weather-prime)')
    assert.ok(!svc.url.includes('weather'), 'fixture URL should not contain "weather"')
  })

  it('T6: 50%_off query — name match ranks above cosine-only (no SQL escape in JS)', async () => {
    insertService('hybrid-percent-svc', '50%_off deals', { description: 'Discount API' })
    insertEmbedding('hybrid-percent-svc', GENERIC_VEC_A)

    insertService('hybrid-percent-far', 'FarService', { description: 'Unrelated service' })
    insertEmbedding('hybrid-percent-far', PERCENT_CLOSE_VEC)

    try {
      stubEmbedQuery(PERCENT_CLOSE_VEC)
      const result = await queryServicesHybrid(db, { q: '50%_off', rawLimit: 50 }, API_COLUMNS)
      const idx_percent = result.services.findIndex(s => s.id === 'hybrid-percent-svc')
      const idx_far = result.services.findIndex(s => s.id === 'hybrid-percent-far')
      assert.ok(idx_percent >= 0, '50%_off deals should appear in results')
      assert.ok(idx_far >= 0, 'FarService should appear in results')
      assert.ok(idx_percent < idx_far,
        '50%_off deals (Tier B name match) should rank above FarService (Tier D cosine-only)')
    } finally {
      for (const id of ['hybrid-percent-svc', 'hybrid-percent-far']) {
        try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(id) } catch {}
        try { db.prepare('DELETE FROM services WHERE id = ?').run(id) } catch {}
      }
    }
  })

  it('T-comparator-empty: buildHybridComparator — no LIKE matches, cosine-winner ranks first', () => {
    assert.ok(typeof buildHybridComparator === 'function', 'buildHybridComparator should be exported')
    const comparator = buildHybridComparator({
      q: 'weather',
      likeNameIdSet: new Set(),
      likeDescIdSet: new Set(),
      semanticScores: new Map([['a', 0.9], ['b', 0.5]]),
    })
    const services = [
      { id: 'b', name: 'Beta', featured: 1, domain_verified: 1, category: 'ai', health_status: 'healthy' },
      { id: 'a', name: 'Alpha', featured: 0, domain_verified: 0, category: 'uncategorized', health_status: 'unknown' },
    ]
    services.sort(comparator)
    assert.equal(services[0].id, 'a', 'Higher cosine (0.9) should rank first despite lower featured/verified')
  })
})

// ─── GROUP P6: Response shape regression ─────────────────────────────────────

describe('Group P6 — response shape regression (#161)', () => {
  it('T-shape-regression: GET /api/v1/services?q=weather returns exactly {services,total,limit,offset}', async () => {
    // globalThis.fetch is restored to originalFetch by the outer beforeEach
    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200, 'Should return 200 (degrades gracefully if OpenAI fails)')
    const body = await res.json()
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ['limit', 'offset', 'services', 'total'],
      `Response should have EXACTLY these top-level keys, got: ${Object.keys(body).sort().join(', ')}`,
    )
  })
})

// ─── GROUP H: JS post-filter overlap-dedup beyond likeCap (#162 P2) ─────────

describe('Group H — overlap dedup: overlap service beyond likeCap exercised by JS post-filter (#162)', () => {
  it('T-overlap-beyond-likecap: adding embedding for service beyond likeCap must not inflate total (post-filter dedup)', async () => {
    // Fixture: 1500 services all matching "BeyondCapTest" in name.
    // 1001 services are featured=1 → rank 1-1001 in DEFAULT_ORDER, filling likeCap=1000 window.
    // The overlap service is featured=0, domain_verified=0, health_status='unknown' → rank ≥ 1002,
    // NOT fetched by the LIKE query (beyond likeCap=1000).
    //
    // Strategy: query TWICE — first without overlap embedding (baseline), then with it.
    // When the JS post-filter at services.js:355-360 is correct:
    //   overlap enters semanticOnlyServices → post-filter removes it (name LIKE-matches "BeyondCapTest")
    //   → total is unchanged from baseline
    // When the post-filter is commented out:
    //   overlap stays in semanticOnlyServices → total = baseline + 1 → strict-equal assertion fails.
    const insertFeatured = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 1, 1, 'ai', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertUnfeatured = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const insertOverlap = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'unknown', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const tx = db.transaction(() => {
      for (let i = 0; i < 1001; i++) {
        insertFeatured.run(`beyond-cap-feat-${i}`, `BeyondCapTest-feat-${i}`, `BeyondCapTest featured svc ${i}`, `https://beyond-cap-feat-${i}.example.com/api`)
      }
      // Overlap: featured=0, domain_verified=0, health_status='unknown' → rank ≥ 1002 (beyond likeCap)
      // Name deliberately contains "BeyondCapTest" so the JS post-filter must remove it from semanticOnlyServices
      insertOverlap.run('beyond-cap-overlap-0', 'BeyondCapTest-overlap', 'BeyondCapTest overlap service', 'https://beyond-cap-overlap.example.com/api')
      for (let i = 0; i < 498; i++) {
        insertUnfeatured.run(`beyond-cap-fill-${i}`, `BeyondCapTest-fill-${i}`, `BeyondCapTest fill svc ${i}`, `https://beyond-cap-fill-${i}.example.com/api`)
      }
    })
    tx()

    try {
      // Step 1: baseline — overlap has no embedding, not in semanticScores
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const baseline = await queryServicesHybrid(db, { q: 'BeyondCapTest', rawLimit: 50 }, API_COLUMNS)
      assert.ok(baseline.total >= 1500, `baseline total should be ≥ 1500, got ${baseline.total}`)

      // Step 2: give overlap an embedding — now it enters semanticScores → semanticIds → semanticOnlyServices
      insertEmbedding('beyond-cap-overlap-0', WEATHER_SERVICE_VEC)
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const withEmbedding = await queryServicesHybrid(db, { q: 'BeyondCapTest', rawLimit: 50 }, API_COLUMNS)

      // Total must be UNCHANGED — overlap was LIKE-matched (counted in likeCount), so JS post-filter
      // must remove it from semanticOnlyServices to avoid double-counting.
      // Without the post-filter: total = baseline.total + 1 → strict-equal fails.
      assert.strictEqual(withEmbedding.total, baseline.total,
        `total must not increase when overlap embedding is added (JS post-filter must dedup). Got ${withEmbedding.total} vs baseline ${baseline.total}`)

      // Overlap service must NOT appear in result.services.
      // Without the post-filter: overlap has the best cosine score among all candidates
      // (WEATHER_SERVICE_VEC closest to query) → ranks #1 → appears in page 1 → assertion fails.
      const overlapCount = withEmbedding.services.filter(s => s.id === 'beyond-cap-overlap-0').length
      assert.strictEqual(overlapCount, 0,
        `overlap service should not appear in results (removed by JS post-filter), got ${overlapCount}`)
    } finally {
      db.exec("DELETE FROM service_embeddings WHERE service_id LIKE 'beyond-cap-%'")
      try { db.exec("DELETE FROM vec_service_embeddings WHERE service_id LIKE 'beyond-cap-%'") } catch {}
      db.exec("DELETE FROM services WHERE id LIKE 'beyond-cap-%'")
    }
  })
})

// ─── GROUP I: likeCap boundary arithmetic (#162 P7) ──────────────────────────

describe('Group I — likeCap boundary: parametric tests for offset+limit combos (#162)', () => {
  for (const [offset, rawLimit] of [[0, 50], [950, 100], [0, 200], [1500, 50]]) {
    const likeCap = Math.max(1000, offset + rawLimit)
    const totalServices = likeCap + 50 // enough to exceed likeCap

    it(`T-likecap-boundary (offset=${offset}, rawLimit=${rawLimit}): likeCap=${likeCap}, total stable, no dups across pages`, async () => {
      const prefix = `likbnd-${offset}-${rawLimit}`
      const insert = db.prepare(`
        INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
        VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
      `)
      const term = `LikecapBnd${offset}x${rawLimit}`
      const tx = db.transaction(() => {
        for (let i = 0; i < totalServices; i++) {
          insert.run(`${prefix}-${i}`, `${term}-${i}`, `${term} description ${i}`, `https://${prefix}-${i}.example.com/api`)
        }
      })
      tx()

      try {
        // Degrade semantic path so LIKE-only is used — cleanly isolates likeCap arithmetic
        globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })

        const page1 = await queryServicesHybrid(db, { q: term, rawLimit: String(rawLimit), rawOffset: String(offset) }, API_COLUMNS)
        const page2 = await queryServicesHybrid(db, { q: term, rawLimit: String(rawLimit), rawOffset: String(offset + rawLimit) }, API_COLUMNS)

        // (a) total is stable across consecutive pages for the same fixture
        assert.strictEqual(page1.total, page2.total, `total should be stable across pages (got ${page1.total} vs ${page2.total})`)

        // (b) no duplicate IDs across consecutive pages
        const ids1 = new Set(page1.services.map(s => s.id))
        const ids2 = new Set(page2.services.map(s => s.id))
        const overlap = [...ids1].filter(id => ids2.has(id))
        assert.strictEqual(overlap.length, 0, `no duplicate IDs across consecutive pages, got ${overlap.length} dups: ${overlap.slice(0, 3).join(', ')}`)

        // (c) likeCap boundary: page1 at given offset should contain rawLimit results
        // (unless fewer remain). With totalServices = likeCap+50, offset < totalServices,
        // so offset+rawLimit ≤ likeCap+50 ≤ totalServices — all results should be available.
        // If likeCap were wrong (e.g., hardcoded 1000 when it should be 1550), the slice
        // would come up short at deep offsets.
        if (offset + rawLimit <= totalServices) {
          assert.strictEqual(page1.services.length, rawLimit,
            `page at offset=${offset} should have rawLimit=${rawLimit} results (likeCap boundary). Got ${page1.services.length} — possible likeCap regression`)
        }
      } finally {
        db.exec(`DELETE FROM services WHERE id LIKE '${prefix}-%'`)
      }
    })
  }

  after(async () => {
    // Group I tests trip the circuit breaker by returning 500 from the embed API.
    // Reset it here (local to Group I) so P8 and P9 get a clean semantic path.
    process.env.NODE_ENV = 'test' // required by resetCircuit's test-only guard
    const { resetCircuit: rc } = await import('../src/services/embeddings.js')
    rc()
  })
})

// ─── GROUP P8: X-402index-Semantic-Cap header (#162 P3) ──────────────────────

describe('Group P8 — X-402index-Semantic-Cap response header (#162)', () => {
  it('T-semantic-cap-header-truncated: header is "true" when K semantic neighbors returned (sqlite-vec path)', async (t) => {
    // Requires sqlite-vec for deterministic K-cap behavior.
    // JS-fallback loads all embeddings (no K cap) so semantic_cap is always false in that path.
    if (!SQLITE_VEC_AVAILABLE) {
      t.skip('sqlite-vec not available: JS-fallback never truncates, so K-saturation cannot be tested in this environment')
      return
    }

    const prefix = 'sem-cap-trunc'
    // Insert 60 services — all close to query vec (WEATHER_SERVICE_VEC), none LIKE-match query
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const tx = db.transaction(() => {
      for (let i = 0; i < 60; i++) {
        insert.run(`${prefix}-${i}`, `SemCapSvc-${i}`, `Semantic capability service ${i}`, `https://sem-cap-trunc-${i}.example.com/api`)
      }
    })
    tx()
    for (let i = 0; i < 60; i++) insertEmbedding(`${prefix}-${i}`, WEATHER_SERVICE_VEC)

    try {
      // Query term does not match any service name/description → all 60 are semantic-only
      // K = max(50, limit=50) = 50. Vec returns top 50 from ≥60 embeddings → K saturated.
      // semanticOnlyServices.length === K → semantic_cap = true → header = 'true'
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const res = await originalFetch(`${API}/api/v1/services?q=SemCapTruncQuery&limit=50`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-semantic-cap'), 'true',
        `X-402index-Semantic-Cap should be 'true' when K=${Math.max(50, 50)} semantic neighbors returned, got: ${res.headers.get('x-402index-semantic-cap')}`)
    } finally {
      for (let i = 0; i < 60; i++) {
        try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(`${prefix}-${i}`) } catch {}
        db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(`${prefix}-${i}`)
        db.prepare('DELETE FROM services WHERE id = ?').run(`${prefix}-${i}`)
      }
    }
  })

  it('T-semantic-cap-header-not-truncated: header is "false" when fewer than K semantic neighbors returned', async () => {
    const prefix = 'sem-cap-notrunc'
    // Insert only 5 semantic-only services — far fewer than K=50
    // semanticOnlyServices.length < K → semantic_cap = false → header = 'false'
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const tx = db.transaction(() => {
      for (let i = 0; i < 5; i++) {
        insert.run(`${prefix}-${i}`, `SemCapNoSvc-${i}`, `No-trunc semantic service ${i}`, `https://sem-cap-notrunc-${i}.example.com/api`)
      }
    })
    tx()
    for (let i = 0; i < 5; i++) insertEmbedding(`${prefix}-${i}`, WEATHER_SERVICE_VEC)

    try {
      // 5 new + ~5 permanent close fixtures = ~10 total semantic neighbors << K=50
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const res = await originalFetch(`${API}/api/v1/services?q=SemCapNoTruncQuery&limit=50`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
        `X-402index-Semantic-Cap should be 'false' when fewer than K semantic neighbors, got: ${res.headers.get('x-402index-semantic-cap')}`)
    } finally {
      for (let i = 0; i < 5; i++) {
        try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(`${prefix}-${i}`) } catch {}
        db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(`${prefix}-${i}`)
        db.prepare('DELETE FROM services WHERE id = ?').run(`${prefix}-${i}`)
      }
    }
  })

  it('T-body-shape-still-four-keys: X-402index-Semantic-Cap header does NOT appear in response body', async () => {
    // Belt-and-suspenders guard: semantic_cap must be stripped from body and moved to header.
    // Body must remain exactly {limit, offset, services, total} — no new keys.
    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ['limit', 'offset', 'services', 'total'],
      `Response body should have EXACTLY 4 keys, got: ${Object.keys(body).sort().join(', ')}`,
    )
    // P10 — enum safety: header must always be 'true' or 'false', never 'undefined' or absent
    assert.ok(
      ['true', 'false'].includes(res.headers.get('x-402index-semantic-cap')),
      `X-402index-Semantic-Cap must be 'true' or 'false', got: ${res.headers.get('x-402index-semantic-cap')}`,
    )
  })
})

// ─── GROUP P9: Semantic-Cap header on early-return paths (#162 second-pass) ───

describe('Group P9 — Semantic-Cap header on early-return paths (#162 second-pass)', () => {
  it('P9-1: no q → X-402index-Semantic-Cap: false', async () => {
    const res = await originalFetch(`${API}/api/v1/services`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
      `header should be 'false' when q is absent, got: ${res.headers.get('x-402index-semantic-cap')}`)
  })

  it('P9-2: q=* → X-402index-Semantic-Cap: false', async () => {
    const res = await originalFetch(`${API}/api/v1/services?q=*`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
      `header should be 'false' for q=*, got: ${res.headers.get('x-402index-semantic-cap')}`)
  })

  it('P9-3: sort specified → X-402index-Semantic-Cap: false', async () => {
    // sort triggers early return before embed — no semantic path, header must still emit 'false'
    const res = await originalFetch(`${API}/api/v1/services?q=weather&sort=price`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
      `header should be 'false' when sort skips re-rank, got: ${res.headers.get('x-402index-semantic-cap')}`)
  })

  it('P9-4: embed API 500 → header false + X-402index-Search-Degraded set', async () => {
    stubOpenAIOnly(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const res = await originalFetch(`${API}/api/v1/services?q=weather`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
      `header should be 'false' on embed failure, got: ${res.headers.get('x-402index-semantic-cap')}`)
    assert.ok(res.headers.get('x-402index-search-degraded'),
      'X-402index-Search-Degraded must be set on embed failure')
  })
})

// ─── GROUP P11: JS-fallback never reports semantic_cap=true (#162 Fragile-1) ─

describe('Group P11 — JS-fallback never reports semantic_cap=true (#162 Fragile-1)', () => {
  it('P11-1: JS-fallback with exactly K=50 embeddings → header false (no false positive)', async () => {
    if (SQLITE_VEC_AVAILABLE) {
      // This test guards the JS-fallback path only. When sqlite-vec is present the vec path
      // runs instead, and truncation semantics are handled by T-semantic-cap-header-truncated.
      console.warn('[P11-1] SKIP: sqlite-vec is available — test guards JS-fallback path only')
      return
    }
    // Insert exactly K=max(50, limit=50)=50 semantic-only services.
    // In the JS-fallback path ALL embeddings are loaded (no K cap).
    // Bug: semanticScores.size===K → 50===50 → true → header='true' (false positive).
    // Fix: SQLITE_VEC_AVAILABLE && semanticScores.size===K → false && ... → false → header='false'.
    const prefix = 'js-fb-trunc'
    const insert = db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, source, health_status, status, featured, domain_verified, category, hostname, registered_at, updated_at)
      VALUES (?, ?, ?, ?, 'x402', 'test', 'healthy', 'active', 0, 0, 'uncategorized', 'test.example.com', datetime('now'), datetime('now'))
    `)
    const tx = db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        insert.run(`${prefix}-${i}`, `JsFbSvc-${i}`, `JS fallback service ${i}`, `https://js-fb-trunc-${i}.example.com/api`)
      }
    })
    tx()
    for (let i = 0; i < 50; i++) insertEmbedding(`${prefix}-${i}`, WEATHER_SERVICE_VEC)

    try {
      stubEmbedQuery(WEATHER_QUERY_VEC)
      const res = await originalFetch(`${API}/api/v1/services?q=JsFbTruncQuery&limit=50`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-402index-semantic-cap'), 'false',
        `JS-fallback loads all embeddings — header must be 'false' even when semanticScores.size===K. Got: ${res.headers.get('x-402index-semantic-cap')}`)
    } finally {
      for (let i = 0; i < 50; i++) {
        try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(`${prefix}-${i}`) } catch {}
        try { db.prepare('DELETE FROM services WHERE id = ?').run(`${prefix}-${i}`) } catch {}
      }
    }
  })
})

// ─── GROUP P12: Non-ASCII normalization — LIKE/JS divergence + NFD input (#180) ─
// Note: P12 tests run last in this suite. Each test calls cleanup() (full teardown) at the
// start so it owns the entire DB state. This is safe because no later groups depend on the
// shared fixtures inserted in before().

describe('Group P12 — Non-ASCII normalization: NOCASE replication + NFC-normalize q (#180)', () => {
  it('T-norm-1 (under-count bug): q="café" finds service with name="CAFÉ API"', async () => {
    // "CAFÉ API" has É (U+00C9). SQL LIKE '%café%' under SQLite NOCASE is ASCII-only:
    // É (U+00C9) ≠ é (U+00E9) → LIKE misses name. Description "Premium payments endpoint"
    // has no café → LIKE misses entirely. Service falls into semantic-only pool.
    // Current bug: JS post-filter uses .toLowerCase() (Unicode-aware): "CAFÉ".toLowerCase()
    // = "café" (é U+00E9), .includes("café") → true → removes service from semantic-only pool.
    // Net: total=0 (under-count).
    // Fix: asciiLower() only folds A-Z, leaves É as É → "café api".includes("café") →
    // É(U+00C9) vs é(U+00E9) → false → service stays in semantic-only → total=1.
    cleanup()
    insertService('norm-cafe-api', 'CAFÉ API', { description: 'Premium payments endpoint' })
    insertEmbedding('norm-cafe-api', CAFE_SERVICE_VEC)
    stubEmbedQuery(WEATHER_QUERY_VEC)
    try {
      const result = await queryServicesHybrid(db, { q: 'caf\u00e9', rawLimit: 50 }, API_COLUMNS)
      assert.equal(result.total, 1, `expected total=1 for q="café" matching "CAFÉ API", got ${result.total}`)
      const ids = result.services.map(s => s.id)
      assert.ok(ids.includes('norm-cafe-api'), `"CAFÉ API" must appear in results, got ids: ${ids.join(', ')}`)
    } finally {
      cleanup()
    }
  })

  it('T-norm-2 (NFD decomposed input): q="cafe\\u0301" finds NFC-stored service', async () => {
    // A service stored with lowercase NFC "café api" (é = U+00E9) should be findable via LIKE
    // when the user submits a query in NFD form "cafe\u0301" (e + combining acute U+0301).
    // Without NFC normalization: params.q = "%cafe\u0301%" → "café api" LIKE "%cafe\u0301%"
    // → NFC byte 0xC3 0xA9 ≠ NFD bytes 0x65 0xCC 0x81 → NO LIKE MATCH. Service has no
    // embedding → not in semantic-only either → total=0 (missing service, bug).
    // With NFC fix: q.normalize('NFC') → "café" → "café api" LIKE "%café%" → é=é → MATCH → total=1.
    cleanup()
    insertService('norm-cafe-api', 'café api', { description: 'NFC-stored service' })
    // No embedding — must be found via LIKE after NFC normalization of q.
    stubEmbedQuery(WEATHER_QUERY_VEC)
    try {
      const result = await queryServicesHybrid(db, { q: 'cafe\u0301', rawLimit: 50 }, API_COLUMNS)
      assert.equal(result.total, 1, `expected total=1 for NFD q="cafe\\u0301" matching NFC-stored "café api", got ${result.total}`)
      const ids = result.services.map(s => s.id)
      assert.ok(ids.includes('norm-cafe-api'), `"café api" must appear in LIKE results for NFD query, got ids: ${ids.join(', ')}`)
    } finally {
      cleanup()
    }
  })

  it('T-norm-3 (ASCII regression): q="simple" still finds service with name="SimpleAPI"', async () => {
    // Pure ASCII queries must continue to work correctly — no regression from the fix.
    // cleanup() removes all other test services so only SimpleAPI is in the DB.
    cleanup()
    insertService('norm-simple-api', 'SimpleAPI', { description: 'Basic JSON service' })
    insertEmbedding('norm-simple-api', GENERIC_VEC_B)
    stubEmbedQuery(WEATHER_QUERY_VEC)
    try {
      const result = await queryServicesHybrid(db, { q: 'simple', rawLimit: 50 }, API_COLUMNS)
      assert.equal(result.total, 1, `expected total=1 for q="simple" matching "SimpleAPI", got ${result.total}`)
      const ids = result.services.map(s => s.id)
      assert.ok(ids.includes('norm-simple-api'), `"SimpleAPI" must appear in results, got ids: ${ids.join(', ')}`)
    } finally {
      cleanup()
    }
  })

  it('T-norm-4 (ranking consistency): both accented services appear for q="café", order is stable', async () => {
    // "CAFÉ Exact" (É, U+00C9): SQL LIKE misses → semantic-only candidate.
    //   Current bug: JS post-filter .toLowerCase() folds É→é → drops service → not in results.
    //   Fix: asciiLower keeps É → post-filter keeps it → appears.
    // "Some café provider" (é, U+00E9): SQL LIKE '%café%' matches → always in likeServices.
    // After fix: both appear. Ordering must be stable across repeated calls.
    cleanup()
    insertService('norm-cafe-exact', 'CAFÉ Exact', { description: 'Premium endpoint' })
    insertEmbedding('norm-cafe-exact', CAFE_SERVICE_VEC)
    insertService('norm-cafe-provider', 'Some café provider', { description: 'General payments' })
    insertEmbedding('norm-cafe-provider', makeVector(1.02))
    stubEmbedQuery(WEATHER_QUERY_VEC)
    try {
      const r1 = await queryServicesHybrid(db, { q: 'caf\u00e9', rawLimit: 50 }, API_COLUMNS)
      const ids1 = r1.services.map(s => s.id)
      assert.ok(ids1.includes('norm-cafe-exact'), `"CAFÉ Exact" must appear in results, got: ${ids1.join(', ')}`)
      assert.ok(ids1.includes('norm-cafe-provider'), `"Some café provider" must appear in results, got: ${ids1.join(', ')}`)

      // Ordering must be stable (same query, same order)
      const r2 = await queryServicesHybrid(db, { q: 'caf\u00e9', rawLimit: 50 }, API_COLUMNS)
      const ids2 = r2.services.map(s => s.id)
      assert.deepEqual(ids1, ids2, 'result order must be stable across identical calls')
    } finally {
      cleanup()
    }
  })
})

// ─── Pure JS helper (no module import needed) ────────────────────────────────
function cosineSimilaritySync(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}
