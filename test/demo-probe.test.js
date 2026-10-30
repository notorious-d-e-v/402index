import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatProbeSteps, validateProbeUrl, buildProbeConfig } from '../src/services/probe-live.js'
import Database from 'better-sqlite3'
import { withQuarantineSchema } from './helpers/test-db.js'
import { SWEEP_SQL } from '../src/health/checker.js'

// ─── URL Validation ────────────────────────────────────────────────────────────

describe('validateProbeUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    const result = validateProbeUrl('https://api.example.com/weather')
    assert.equal(result, null, 'should return null for valid URL')
  })

  it('accepts HTTP URLs (both HTTP and HTTPS supported)', () => {
    const result = validateProbeUrl('http://api.example.com/weather')
    assert.equal(result, null, 'should return null for valid HTTP URL')
  })

  it('rejects malformed URLs', () => {
    const result = validateProbeUrl('not-a-url')
    assert.ok(result, 'should return error for malformed URL')
  })

  it('rejects empty input', () => {
    const result = validateProbeUrl('')
    assert.ok(result, 'should return error for empty URL')
  })

  it('rejects private IPs', () => {
    const result = validateProbeUrl('https://192.168.1.1/api')
    assert.ok(result, 'should return error for private IP')
  })

  it('rejects localhost', () => {
    const result = validateProbeUrl('https://localhost/api')
    assert.ok(result, 'should return error for localhost')
  })

  it('rejects 127.0.0.1', () => {
    const result = validateProbeUrl('https://127.0.0.1/api')
    assert.ok(result, 'should return error for loopback IP')
  })

  it('rejects file:// scheme', () => {
    const result = validateProbeUrl('file:///etc/passwd')
    assert.ok(result, 'should return error for file scheme')
  })
})

// ─── Probe Step Formatting ─────────────────────────────────────────────────────

describe('formatProbeSteps', () => {
  it('formats connect step', () => {
    const step = formatProbeSteps.connect('https://api.example.com/weather')
    assert.equal(step.step, 'connect')
    assert.ok(step.message.includes('api.example.com'), 'should include hostname')
  })

  it('formats request step with method', () => {
    const step = formatProbeSteps.request('GET', 'https://api.example.com/weather')
    assert.equal(step.step, 'request')
    assert.ok(step.message.includes('GET'), 'should include method')
    assert.ok(step.message.includes('api.example.com'), 'should include URL')
  })

  it('formats response step with status and timing', () => {
    const step = formatProbeSteps.response(402, 145)
    assert.equal(step.step, 'response')
    assert.equal(step.status, 402)
    assert.equal(step.time_ms, 145)
    assert.ok(step.message.includes('402'), 'should include status code')
    assert.ok(step.message.includes('145'), 'should include timing')
  })

  it('formats L402 headers step', () => {
    const step = formatProbeSteps.headers('L402', {
      'WWW-Authenticate': 'L402 macaroon="abc", invoice="lnbc..."'
    })
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, 'L402')
    assert.ok(step.message.includes('L402'), 'should identify L402 protocol')
  })

  it('formats x402 headers step', () => {
    const step = formatProbeSteps.headers('x402', {
      'PAYMENT-REQUIRED': '{"accepts": [{"asset": "USDC"}]}'
    })
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, 'x402')
    assert.ok(step.message.includes('x402'), 'should identify x402 protocol')
  })

  it('formats MPP headers step', () => {
    const step = formatProbeSteps.headers('MPP', {
      'WWW-Authenticate': 'Payment id="x", realm="r", method="tempo", intent="charge", request="dGVzdA"'
    })
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, 'MPP')
    assert.ok(step.message.includes('MPP'), 'should identify MPP protocol')
  })

  it('formats no-protocol headers step when neither detected', () => {
    const step = formatProbeSteps.headers(null, {})
    assert.equal(step.step, 'headers')
    assert.equal(step.protocol, null)
    assert.ok(step.message.includes('No'), 'should indicate no protocol detected')
  })

  it('formats analysis step with health classification', () => {
    const step = formatProbeSteps.analysis('healthy', 'L402')
    assert.equal(step.step, 'analysis')
    assert.ok(step.message.includes('healthy'), 'should include health status')
  })

  it('formats done step', () => {
    const step = formatProbeSteps.done('healthy', 'L402', 145)
    assert.equal(step.step, 'done')
    assert.ok(step.health_status, 'should include health status')
  })

  it('formats error step', () => {
    const step = formatProbeSteps.error('Connection timed out')
    assert.equal(step.step, 'error')
    assert.ok(step.message.includes('timed out'), 'should include error message')
  })
})

// ─── DB-backed probe config ───────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      http_method TEXT DEFAULT 'GET',
      probe_body TEXT,
      health_status TEXT DEFAULT 'unknown',
      consecutive_failures INTEGER DEFAULT 0,
      latency_p50_ms INTEGER,
      status TEXT DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'self-registered',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  withQuarantineSchema(db)
  return db
}

describe('buildProbeConfig', () => {
  it('returns DB service config for known URL', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, http_method, probe_body) VALUES ('s1', 'Sats4AI Image', 'https://sats4ai.com/api/l402/image', 'L402', 'POST', '{"input":{"prompt":"test"},"model":"Standard"}')`).run()

    const config = buildProbeConfig(db, 'https://sats4ai.com/api/l402/image')
    assert.equal(config.protocol, 'L402')
    assert.equal(config.httpMethod, 'POST')
    assert.equal(config.probeBody, '{"input":{"prompt":"test"},"model":"Standard"}')
  })

  it('returns GET defaults for unknown URL', () => {
    const db = createTestDb()
    const config = buildProbeConfig(db, 'https://unknown.example.com/api')
    assert.equal(config.protocol, null)
    assert.equal(config.httpMethod, 'GET')
    assert.equal(config.probeBody, '{}')
  })

  it('uses POST method when DB says POST', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, http_method) VALUES ('s1', 'Post API', 'https://post.example.com/api', 'L402', 'POST')`).run()

    const config = buildProbeConfig(db, 'https://post.example.com/api')
    assert.equal(config.httpMethod, 'POST')
  })

  it('defaults to GET when http_method is NULL', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol) VALUES ('s1', 'Get API', 'https://get.example.com/api', 'L402')`).run()

    const config = buildProbeConfig(db, 'https://get.example.com/api')
    assert.equal(config.httpMethod, 'GET')
  })

  it('returns consecutive_failures for classification context', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, consecutive_failures) VALUES ('s1', 'Failing API', 'https://failing.example.com/api', 'L402', 5)`).run()

    const config = buildProbeConfig(db, 'https://failing.example.com/api')
    assert.equal(config.consecutiveFailures, 5)
  })

  it('returns latency_p50_ms for degradation detection', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, latency_p50_ms) VALUES ('s1', 'Slow API', 'https://slow.example.com/api', 'x402', 500)`).run()

    const config = buildProbeConfig(db, 'https://slow.example.com/api')
    assert.equal(config.historicalP50, 500)
  })

  it('returns stored config for pending services', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, status, http_method, probe_body) VALUES ('s1', 'Pending API', 'https://pending.example.com/api', 'L402', 'pending', 'POST', '{"text":"hello"}')`).run()

    const config = buildProbeConfig(db, 'https://pending.example.com/api')
    assert.equal(config.protocol, 'L402', 'should match pending service')
    assert.equal(config.httpMethod, 'POST')
    assert.equal(config.probeBody, '{"text":"hello"}')
  })

  it('returns stored config for rejected services', () => {
    const db = createTestDb()
    db.prepare(`INSERT INTO services (id, name, url, protocol, status, http_method) VALUES ('s1', 'Rejected API', 'https://rejected.example.com/api', 'L402', 'rejected', 'POST')`).run()

    const config = buildProbeConfig(db, 'https://rejected.example.com/api')
    assert.equal(config.protocol, 'L402', 'should match rejected service')
    assert.equal(config.httpMethod, 'POST')
  })
})

// ─── Regression guard: health checker filter (behavioral) ─────────────────────
//
// Tests the actual getServices SQL query against a real SQLite DB rather than
// string-matching source code. Resilient to whitespace, parameterization, or
// query builder changes — only the behavior matters.

describe('health checker service filter (regression guard)', () => {
  // Extract the getServices SQL from checker.js source (one-time, cached)
  let getServicesSql
  // The sweep SQL is exported (it interpolates LISTED, so it can no longer be regex-extracted).
  function loadGetServicesSql() {
    return SWEEP_SQL
  }

  function createCheckerTestDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'L402',
        http_method TEXT DEFAULT 'GET',
        probe_body TEXT,
        latency_p50_ms INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        consecutive_latency_spikes INTEGER DEFAULT 0,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        x402_payment_valid INTEGER,
        status TEXT DEFAULT 'active',
        provider_deleted INTEGER DEFAULT 0,
        probe_status TEXT DEFAULT 'probeable',
        source TEXT DEFAULT 'test',
        domain_verified INTEGER DEFAULT 0,
        last_checked TEXT
      )
    `)
    withQuarantineSchema(db)
    return db
  }

  function insertService(db, id, status) {
    db.prepare(
      `INSERT INTO services (id, url, protocol, status) VALUES (?, ?, 'L402', ?)`
    ).run(id, `https://${id}.example.com/api`, status)
  }

  it('returns active services', () => {
    const db = createCheckerTestDb()
    insertService(db, 'active1', 'active')
    const rows = db.prepare(loadGetServicesSql()).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'active1')
  })

  it('returns NULL-status services', () => {
    const db = createCheckerTestDb()
    insertService(db, 'null1', null)
    const rows = db.prepare(loadGetServicesSql()).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'null1')
  })

  it('excludes pending services', () => {
    const db = createCheckerTestDb()
    insertService(db, 'pending1', 'pending')
    const rows = db.prepare(loadGetServicesSql()).all()
    assert.equal(rows.length, 0)
  })

  it('excludes rejected services', () => {
    const db = createCheckerTestDb()
    insertService(db, 'rejected1', 'rejected')
    const rows = db.prepare(loadGetServicesSql()).all()
    assert.equal(rows.length, 0)
  })

  it('returns only active/null when mixed statuses exist', () => {
    const db = createCheckerTestDb()
    insertService(db, 'a1', 'active')
    insertService(db, 'a2', 'active')
    insertService(db, 'n1', null)
    insertService(db, 'p1', 'pending')
    insertService(db, 'r1', 'rejected')
    const rows = db.prepare(loadGetServicesSql()).all()
    assert.equal(rows.length, 3, 'should return exactly 3 services (2 active + 1 null)')
    const ids = rows.map(r => r.id).sort()
    assert.deepEqual(ids, ['a1', 'a2', 'n1'])
    // status column is not in SELECT — verify by confirming excluded IDs are absent
    assert.ok(!ids.includes('p1'), 'pending service must not be returned')
    assert.ok(!ids.includes('r1'), 'rejected service must not be returned')
  })
})

// ─── Step generation: POST endpoints ──────────────────────────────────────────

describe('formatProbeSteps — POST method display', () => {
  it('formats request step with POST method', () => {
    const step = formatProbeSteps.request('POST', 'https://sats4ai.com/api/l402/image')
    assert.equal(step.step, 'request')
    assert.ok(step.message.includes('POST'), 'should show POST method')
  })

  it('formats L402 compliance validation step', () => {
    const step = formatProbeSteps.l402Validation(true, { scheme: 'L402', macaroon: 'valid', invoice: 'valid' })
    assert.equal(step.step, 'l402_validation')
    assert.ok(step.valid, 'should be valid')
  })

  it('formats L402 compliance failure step', () => {
    const step = formatProbeSteps.l402Validation(false, { scheme: null, macaroon: null, invoice: null })
    assert.equal(step.step, 'l402_validation')
    assert.equal(step.valid, false)
    assert.ok(step.message.includes('fail'), 'should indicate failure')
  })

  it('formats POST auto-detection step', () => {
    const step = formatProbeSteps.postRetry('POST', 402)
    assert.equal(step.step, 'post_retry')
    assert.ok(step.message.includes('POST'), 'should mention POST retry')
    assert.ok(step.message.includes('402'), 'should mention 402 result')
  })

  it('formats x402 payment validation step', () => {
    const step = formatProbeSteps.x402Validation(true, { assetKnown: true, facilitatorReachable: true })
    assert.equal(step.step, 'x402_validation')
    assert.ok(step.valid, 'should be valid')
  })

  it('formats x402 payment validation failure step', () => {
    const step = formatProbeSteps.x402Validation(false, { assetKnown: false, facilitatorReachable: false })
    assert.equal(step.step, 'x402_validation')
    assert.equal(step.valid, false)
  })

  it('formats MPP challenge validation step (valid)', () => {
    const step = formatProbeSteps.mppValidation(true, { method: 'tempo', intent: 'charge' }, null)
    assert.equal(step.step, 'mpp_validation')
    assert.equal(step.valid, true)
    assert.ok(step.message.includes('tempo/charge'), 'should include method/intent')
  })

  it('formats MPP challenge validation step (invalid) with specific degradeReason', () => {
    const step = formatProbeSteps.mppValidation(false, {}, 'missing required MPP field: intent')
    assert.equal(step.step, 'mpp_validation')
    assert.equal(step.valid, false)
    assert.ok(step.message.includes('missing required MPP field: intent'), 'should show specific degradeReason')
  })

  it('formats MPP challenge validation step (invalid) with fallback message', () => {
    const step = formatProbeSteps.mppValidation(false, {}, null)
    assert.equal(step.valid, false)
    assert.ok(step.message.includes('missing fields'), 'should fall back to generic message')
  })

  it('formats MPP validation with decoded price', () => {
    // base64url-encode a request with amount
    const payload = { amount: '200000', methodDetails: { decimals: 6 } }
    const request = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const step = formatProbeSteps.mppValidation(true, { method: 'tempo', intent: 'charge', request })
    assert.ok(step.message.includes('$0.2000'), 'should decode and format price')
  })
})
