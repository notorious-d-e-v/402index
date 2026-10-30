import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// We need to stub fetch BEFORE importing the embeddings module
// Store original fetch
const originalFetch = globalThis.fetch

// Helper: create a valid OpenAI embedding response
function makeEmbeddingResponse(dimensions = 1536) {
  const embedding = new Array(dimensions).fill(0).map((_, i) => Math.sin(i) * 0.1)
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
  }
}

describe('embeddings module (#138)', () => {
  let db, generateEmbedding, embedQuery, cosineSimilarity, getQueueDepth

  before(async () => {
    // Set a fake API key so the module enables itself
    process.env.OPENAI_API_KEY = 'test-key-fake'

    // Import db to ensure schema exists
    const dbMod = await import('../src/db.js')
    db = dbMod.default

    // Import the embeddings module
    const embeddings = await import('../src/services/embeddings.js')
    generateEmbedding = embeddings.generateEmbedding
    embedQuery = embeddings.embedQuery
    cosineSimilarity = embeddings.cosineSimilarity
    getQueueDepth = embeddings.getQueueDepth
  })

  after(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    // Reset fetch stub before each test
    globalThis.fetch = originalFetch
  })

  // Helper: insert a test service row and return its id
  function insertTestService(id) {
    const serviceId = id || `test-emb-${Date.now()}-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT OR IGNORE INTO services (id, name, description, url, protocol, category, source, hostname)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(serviceId, 'Test Service', 'A test service for embeddings', `https://test-${serviceId}.example.com/api`, 'x402', 'ai', 'test', 'test.example.com')
    return serviceId
  }

  // Cleanup helper
  function cleanupService(serviceId) {
    try { db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?').run(serviceId) } catch {}
    try { db.prepare('DELETE FROM service_embeddings WHERE service_id = ?').run(serviceId) } catch {}
    try { db.prepare('DELETE FROM services WHERE id = ?').run(serviceId) } catch {}
  }

  // ─── Test a: generateEmbedding happy path ───────────────────────────────────
  it('a. generateEmbedding inserts correct row on success (stubbed OpenAI)', async () => {
    const serviceId = insertTestService()
    try {
      globalThis.fetch = async () => makeEmbeddingResponse()

      await generateEmbedding(serviceId)

      const row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
      assert.ok(row, 'embedding row should exist')
      assert.equal(row.service_id, serviceId)
      // The vec index is the only store (2026-10-27): no model/embedded_at columns there.
      assert.equal(row.embedding.length, 6144, 'embedding BLOB should be 6144 bytes')
    } finally {
      cleanupService(serviceId)
    }
  })

  // ─── Test b: generateEmbedding failure paths never throw ────────────────────
  it('b. generateEmbedding never throws on 429', async () => {
    const serviceId = insertTestService()
    try {
      globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) })
      await generateEmbedding(serviceId) // should not throw
      const row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
      assert.equal(row, undefined, 'no row should be inserted on 429')
    } finally {
      cleanupService(serviceId)
    }
  })

  it('b. generateEmbedding never throws on 500', async () => {
    const serviceId = insertTestService()
    try {
      globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'server error' } }) })
      await generateEmbedding(serviceId) // should not throw
      const row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
      assert.equal(row, undefined, 'no row should be inserted on 500')
    } finally {
      cleanupService(serviceId)
    }
  })

  it('b. generateEmbedding never throws on network error', async () => {
    const serviceId = insertTestService()
    try {
      globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
      await generateEmbedding(serviceId) // should not throw
      const row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
      assert.equal(row, undefined, 'no row should be inserted on network error')
    } finally {
      cleanupService(serviceId)
    }
  })

  it('b. generateEmbedding never throws on timeout (AbortError)', async () => {
    const serviceId = insertTestService()
    try {
      globalThis.fetch = async () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }
      await generateEmbedding(serviceId) // should not throw
      const row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
      assert.equal(row, undefined, 'no row should be inserted on timeout')
    } finally {
      cleanupService(serviceId)
    }
  })

  // ─── Test c: generateEmbedding no-op when OPENAI_API_KEY unset ──────────────
  it('c. generateEmbedding is no-op when OPENAI_API_KEY unset (env-guard coupled)', async () => {
    // Spawn a child process with OPENAI_API_KEY='' and a fetch stub that throws on any call.
    // This proves: (1) the exact disabled log line is emitted at module load,
    // (2) fetch is never called (env guard short-circuits before network),
    // (3) generateEmbedding resolves to undefined without doing work.
    // Gutting the env-guard in embeddings.js will cause assertions (1) and (2) to fail.
    const { execFileSync } = await import('node:child_process')
    const script = `
      // Stub fetch BEFORE importing — any call means the guard failed
      let fetchCalled = false
      globalThis.fetch = () => { fetchCalled = true; throw new Error('fetch should not be called') }

      const m = await import('./src/services/embeddings.js')
      const result = await m.generateEmbedding('nonexistent-id')

      // generateEmbedding is async — when disabled, it should resolve to undefined
      if (result !== undefined) {
        process.stderr.write('ERROR: generateEmbedding resolved to ' + JSON.stringify(result) + ' instead of undefined')
        process.exit(1)
      }

      if (fetchCalled) {
        process.stderr.write('ERROR: fetch was called despite empty OPENAI_API_KEY')
        process.exit(1)
      }

      process.stdout.write('PASS')
    `
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, OPENAI_API_KEY: '', DB_PATH: ':memory:' },
      encoding: 'utf8',
      timeout: 10000,
    })
    // Verify the disabled log line was printed (captures module-load-time guard)
    assert.ok(result.includes('[embeddings] disabled'), 'stdout should contain the disabled log line')
    assert.ok(result.includes('OPENAI_API_KEY not set'), 'disabled log should mention OPENAI_API_KEY not set')
    assert.ok(result.includes('PASS'), 'child should complete without errors')
  })

  // ─── Test d: embedQuery returns Float32Array or null ─────────────────────────
  it('d. embedQuery returns Float32Array(1536) on success', async () => {
    globalThis.fetch = async () => makeEmbeddingResponse()
    const result = await embedQuery('test query text')
    assert.ok(result instanceof Float32Array, 'should return Float32Array')
    assert.equal(result.length, 1536, 'should have 1536 dimensions')
  })

  it('d. embedQuery returns null on failure', async () => {
    globalThis.fetch = async () => { throw new Error('network failure') }
    const result = await embedQuery('test query text')
    assert.equal(result, null, 'should return null on failure')
  })

  // ─── Test e: cosineSimilarity math ──────────────────────────────────────────
  it('e. cosineSimilarity: identical vectors → 1', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2, 3])
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6)
  })

  it('e. cosineSimilarity: orthogonal vectors → 0', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6)
  })

  it('e. cosineSimilarity: opposite vectors → -1', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([-1, -2, -3])
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1)) < 1e-6)
  })

  it('e. cosineSimilarity: zero-magnitude vector → 0 (no NaN)', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 2, 3])
    const result = cosineSimilarity(a, b)
    assert.equal(result, 0, 'zero-magnitude should return 0')
    assert.ok(!Number.isNaN(result), 'should not be NaN')
  })

  it('e. cosineSimilarity: mismatched length → throws', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([1, 2])
    assert.throws(() => cosineSimilarity(a, b), /length mismatch/i)
  })

  // ─── Test f: Semaphore cap ──────────────────────────────────────────────────
  it('f. semaphore: at most MAX_CONCURRENT (20) in flight', async () => {
    const serviceIds = []
    let maxInflight = 0
    let currentInflight = 0

    // Stub fetch with a delay to hold slots open
    globalThis.fetch = async () => {
      currentInflight++
      if (currentInflight > maxInflight) maxInflight = currentInflight
      await new Promise(r => setTimeout(r, 50))
      currentInflight--
      return makeEmbeddingResponse()
    }

    // Create 50 services and fire embeddings
    const promises = []
    for (let i = 0; i < 50; i++) {
      const id = insertTestService()
      serviceIds.push(id)
      promises.push(generateEmbedding(id))
    }

    await Promise.all(promises)

    assert.ok(maxInflight <= 20, `max inflight was ${maxInflight}, should be <= 20`)
    assert.ok(maxInflight > 1, `max inflight was ${maxInflight}, should be > 1 (parallelism working)`)

    // Cleanup
    for (const id of serviceIds) cleanupService(id)
  })

  // ─── Test g: Queue overflow at MAX_PENDING ──────────────────────────────────
  it('g. semaphore: drops when pending queue exceeds 500', async () => {
    let fetchCallCount = 0

    // Stub fetch with a long delay to fill up the semaphore
    globalThis.fetch = async () => {
      fetchCallCount++
      await new Promise(r => setTimeout(r, 200))
      return makeEmbeddingResponse()
    }

    const serviceIds = []
    // Fire 521 calls synchronously — 20 will be inflight, 500 pending, 1 dropped
    for (let i = 0; i < 521; i++) {
      const id = insertTestService()
      serviceIds.push(id)
      generateEmbedding(id) // fire-and-forget, don't await
    }

    // Give a moment for queueing to settle
    await new Promise(r => setTimeout(r, 50))

    // Queue depth should be capped at 500 (not 501)
    const depth = getQueueDepth()
    assert.ok(depth <= 500, `queue depth ${depth} should be <= 500`)

    // Wait for everything to drain
    await new Promise(r => setTimeout(r, 6000))

    // At most 520 fetches should have been made (20 inflight + 500 pending = 520, 1 dropped)
    assert.ok(fetchCallCount <= 520, `fetch called ${fetchCallCount} times, expected <= 520`)

    // Cleanup
    for (const id of serviceIds) cleanupService(id)
  })

  // ─── Test h: Writer-hook integration — registerUpsert fires embedding ───────
  it('h. writer-hook: POST /api/v1/register fires generateEmbedding on new insert', async () => {
    // This test exercises the PRODUCTION hook wiring at src/routes/api.js:797
    // by calling the real /register endpoint through test/helpers/server.js.
    // Deleting the setImmediate line in api.js should cause this test to FAIL.
    const { startServer, stopServer } = await import('./helpers/server.js')

    // Valid x402 payment header for probe to accept
    // Use realistic x402 payment requirements that pass validation (real USDC on Base)
    const x402Accepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
    const paymentHeaderB64 = Buffer.from(JSON.stringify({ accepts: x402Accepts })).toString('base64')

    const fetchCalls = []

    // Routing fetch stub: intercepts server-internal calls (probe + OpenAI).
    // Test's own HTTP calls to the local server go through http module (via fetch to 127.0.0.1).
    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url)

      // Let test's calls to the local server pass through to real fetch
      if (urlStr.includes('127.0.0.1')) {
        return originalFetch(url, opts)
      }

      fetchCalls.push({ url: urlStr, opts })

      // OpenAI embedding call
      if (urlStr.includes('api.openai.com') && urlStr.includes('embeddings')) {
        return makeEmbeddingResponse()
      }

      // Probe call — return 402 with valid x402 PAYMENT-REQUIRED header
      return {
        ok: false,
        status: 402,
        headers: new Headers({ 'PAYMENT-REQUIRED': paymentHeaderB64, 'content-type': 'application/json' }),
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }

    let BASE
    try {
      BASE = await startServer()
      const uniquePath = `/api/embed-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const registerUrl = `https://example.com${uniquePath}`

      const res = await fetch(`${BASE}/api/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: registerUrl,
          name: 'Embed Hook Test',
          protocol: 'x402',
        }),
      })

      const body = await res.json()
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(body)}`)
      const serviceId = body.service.id

      // Poll the vec index — the hook fires via setImmediate so we need to wait
      let row = null
      const delays = [50, 100, 200, 400, 800, 1600]
      for (const delay of delays) {
        await new Promise(r => setTimeout(r, delay))
        row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
        if (row) break
      }

      assert.ok(row, 'embedding row should exist in the vec index after hook fires')
      assert.equal(row.embedding.length, 6144, 'embedding BLOB should be 1536 floats × 4 bytes = 6144')

      // Verify fetch was called with OpenAI embeddings request
      const openaiCalls = fetchCalls.filter(c => c.url.includes('api.openai.com') && c.url.includes('embeddings'))
      assert.equal(openaiCalls.length, 1, 'OpenAI embeddings fetch should be called exactly once')
      const openaiBody = JSON.parse(openaiCalls[0].opts.body)
      assert.equal(openaiBody.model, 'text-embedding-3-small', 'should request text-embedding-3-small model')

      // Cleanup
      cleanupService(serviceId)
    } finally {
      globalThis.fetch = originalFetch
      await stopServer()
    }
  })

  // ─── Test i: UPSERT-update does NOT fire embedding ──────────────────────────
  it('i. writer-hook: UPSERT-update does NOT fire embedding (second POST same URL)', async () => {
    // This test exercises the PRODUCTION conditional at src/routes/api.js:795
    // (registered_at === updated_at guard). Two POSTs to /register with same URL+protocol:
    // first fires embedding (1 OpenAI call), second must NOT fire (still 1 total).
    // Deleting the setImmediate line in api.js should cause this test to FAIL (0 calls).
    const { startServer, stopServer } = await import('./helpers/server.js')

    const x402Accepts = [{ payTo: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', network: 'eip155:8453' }]
    const paymentHeaderB64 = Buffer.from(JSON.stringify({ accepts: x402Accepts })).toString('base64')

    let openaiCallCount = 0

    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url)

      // Let test's calls to the local server pass through
      if (urlStr.includes('127.0.0.1')) {
        return originalFetch(url, opts)
      }

      // OpenAI embedding call
      if (urlStr.includes('api.openai.com') && urlStr.includes('embeddings')) {
        openaiCallCount++
        return makeEmbeddingResponse()
      }

      // Probe call — return 402 with valid x402 headers
      return {
        ok: false,
        status: 402,
        headers: new Headers({ 'PAYMENT-REQUIRED': paymentHeaderB64, 'content-type': 'application/json' }),
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }

    let BASE
    try {
      BASE = await startServer()
      const uniquePath = `/api/upsert-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const registerUrl = `https://example.com${uniquePath}`

      // First POST — new registration, hook SHOULD fire
      const res1 = await fetch(`${BASE}/api/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: registerUrl, name: 'Upsert Test', protocol: 'x402' }),
      })
      const body1 = await res1.json()
      assert.equal(res1.status, 201, `first POST expected 201, got ${res1.status}: ${JSON.stringify(body1)}`)
      const serviceId = body1.service.id

      // Wait for the first hook's setImmediate + async embedding to complete
      let row = null
      const delays = [50, 100, 200, 400, 800, 1600]
      for (const delay of delays) {
        await new Promise(r => setTimeout(r, delay))
        row = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings WHERE service_id = ?').get(serviceId)
        if (row) break
      }
      assert.ok(row, 'first POST should produce an embedding row')
      assert.equal(openaiCallCount, 1, 'first POST should trigger exactly 1 OpenAI call')

      // Ensure at least 1 second passes so SQLite datetime('now') differs from registered_at
      // (datetime precision is seconds — without this, the upsert's updated_at may equal registered_at)
      const firstRegisteredAt = db.prepare('SELECT registered_at FROM services WHERE id = ?').get(serviceId).registered_at
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const now = db.prepare("SELECT datetime('now') as t").get().t
        if (now !== firstRegisteredAt) break
        await new Promise(r => setTimeout(r, 100))
      }
      if (Date.now() >= deadline) {
        assert.fail('datetime(now) did not advance within 3s — test infrastructure issue')
      }

      // Second POST — same URL + protocol, triggers UPSERT-update branch where registered_at !== updated_at
      const res2 = await fetch(`${BASE}/api/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: registerUrl, name: 'Upsert Test Updated', protocol: 'x402' }),
      })
      const body2 = await res2.json()
      assert.equal(res2.status, 201, `second POST expected 201, got ${res2.status}: ${JSON.stringify(body2)}`)

      // Drain event loop — any pending setImmediate from second POST would fire here
      await new Promise(r => setImmediate(r))
      await new Promise(r => setTimeout(r, 200))

      // Assert: still exactly 1 OpenAI call (second POST did NOT fire the hook)
      assert.equal(openaiCallCount, 1, 'second POST (upsert-update) must NOT trigger another OpenAI call')

      // Assert: still exactly 1 embedding row
      const rowCount = db.prepare('SELECT COUNT(*) as c FROM vec_service_embeddings WHERE service_id = ?').get(serviceId).c
      assert.equal(rowCount, 1, 'should have exactly 1 embedding row, not 2')

      // Cleanup
      cleanupService(serviceId)
    } finally {
      globalThis.fetch = originalFetch
      await stopServer()
    }
  })

  // ─── Test j: /api/v1/health exposes embedding_queue_depth ───────────────────
  it('j. /api/v1/health includes embedding_queue_depth as integer', async () => {
    const { startServer, stopServer } = await import('./helpers/server.js')
    let BASE
    try {
      BASE = await startServer()
      const res = await fetch(`${BASE}/api/v1/health`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok('embedding_queue_depth' in body, 'health response should include embedding_queue_depth')
      assert.equal(typeof body.embedding_queue_depth, 'number', 'embedding_queue_depth should be a number')
      assert.ok(Number.isInteger(body.embedding_queue_depth), 'embedding_queue_depth should be an integer')
    } finally {
      await stopServer()
    }
  })

  // ─── Test k: No CREATE TRIGGER in source ────────────────────────────────────
  it('k. no CREATE TRIGGER touching services or service_embeddings in src/', () => {
    // Check src/db.js
    const dbSource = readFileSync(join(__dirname, '..', 'src', 'db.js'), 'utf8')
    const triggerMatches = dbSource.match(/CREATE\s+TRIGGER/gi) || []
    // Filter for triggers on services or service_embeddings tables
    const relevantTriggers = triggerMatches.filter((_, idx) => {
      const context = dbSource.slice(
        dbSource.indexOf(triggerMatches[idx]),
        dbSource.indexOf(triggerMatches[idx]) + 200
      )
      return /service_embeddings|services/i.test(context)
    })
    assert.equal(relevantTriggers.length, 0, 'no CREATE TRIGGER on services/service_embeddings in db.js')

    // Check all aggregator files
    const aggregatorDir = join(__dirname, '..', 'src', 'aggregators')
    const aggregatorFiles = readdirSync(aggregatorDir).filter(f => f.endsWith('.js'))
    for (const file of aggregatorFiles) {
      const content = readFileSync(join(aggregatorDir, file), 'utf8')
      const triggers = content.match(/CREATE\s+TRIGGER/gi) || []
      assert.equal(triggers.length, 0, `no CREATE TRIGGER in aggregators/${file}`)
    }

    // Check embeddings module (if it exists)
    try {
      const embSource = readFileSync(join(__dirname, '..', 'src', 'services', 'embeddings.js'), 'utf8')
      const embTriggers = embSource.match(/CREATE\s+TRIGGER/gi) || []
      assert.equal(embTriggers.length, 0, 'no CREATE TRIGGER in services/embeddings.js')
    } catch {
      // File doesn't exist yet — that's fine for the failing test commit
    }
  })
})
