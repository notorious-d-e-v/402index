/**
 * Tests for POST auto-detection in health checker — specifically x402 support.
 *
 * Run: node --test test/health-checker.test.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import db from '../src/db.js'
import { checkService } from '../src/health/checker.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_PREFIX = 'test-hc-' + Date.now()
let testCounter = 0

function testId() {
  return `${TEST_PREFIX}-${++testCounter}`
}

function makePaymentHeader() {
  const payload = {
    accepts: [{
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      maxAmountRequired: '1000000',
    }],
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

const longInvoice = 'lnbc1000n1p' + 'a'.repeat(200)

// Spec-compliant V2 TLV macaroon fixture for L402 POST auto-detection test
// Builds a valid binary macaroon: 0x02 version + 0x02 tag + varint(66) + 66-byte identifier + 0x00 EOS + 0x06 sig tag + varint(32) + 32-byte sig + 0x00 EOM
function buildSpecCompliantMacaroon() {
  const id = Buffer.alloc(66)
  id.writeUInt16BE(0, 0)           // L402 version 0
  id.fill(0xAB, 2, 34)            // payment hash (32 bytes)
  id.fill(0xCD, 34, 66)           // token id (32 bytes)
  const sig = Buffer.alloc(32, 0xEE)
  const parts = [
    Buffer.from([0x02]),           // V2 version marker
    Buffer.from([0x02]),           // identifier field type
    Buffer.from([66]),             // varint(66) — single byte since <128
    id,                            // 66-byte identifier
    Buffer.from([0x00]),           // EOS
    Buffer.from([0x06]),           // signature field type
    Buffer.from([32]),             // varint(32)
    sig,                           // 32-byte signature
    Buffer.from([0x00]),           // EOM
  ]
  return Buffer.concat(parts).toString('base64')
}
const specCompliantMacaroon = buildSpecCompliantMacaroon()

function mockResponse(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) { return headers[name.toLowerCase()] || null },
      entries() { return Object.entries(headers) },
    },
    text: async () => '',
  }
}

function insertTestService(overrides = {}) {
  const id = overrides.id || testId()
  const params = {
    id,
    name: 'Test Service',
    url: `https://${id}.example.com/api`,
    protocol: 'x402',
    source: 'test',
    status: 'active',
    ...overrides,
  }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, consecutive_failures, http_method)
    VALUES (@id, @name, @url, @protocol, @source, @status, 0, @http_method)
  `).run({ http_method: null, ...params })
  return params
}

function getService(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id)
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch
let dnsLookupMock

beforeEach(() => {
  // Mock DNS to return a public IP (bypass SSRF check)
  dnsLookupMock = mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34' }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dnsLookupMock.mock.restore()
  // Clean up test rows
  db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
  db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
})

// ─── x402 POST auto-detection ───────────────────────────────────────────────

describe('x402 POST auto-detection in health checker', () => {

  it('x402 + 405 on GET → POST retry → 402 with PAYMENT-REQUIRED → healthy + http_method=POST', async () => {
    const svc = insertTestService({ protocol: 'x402' })
    const validHeader = makePaymentHeader()

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') return mockResponse(402, { 'payment-required': validHeader })
      return mockResponse(405, {}) // HEAD and GET both return 405
    }

    const result = await checkService({
      ...svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    assert.equal(result.healthStatus, 'healthy', 'should be healthy after POST retry')
    const updated = getService(svc.id)
    assert.equal(updated.http_method, 'POST', 'should persist POST as http_method')
  })

  it('x402 + 405 on GET → POST retry → still not 402 → stays degraded', async () => {
    const svc = insertTestService({ protocol: 'x402' })

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') return mockResponse(500, {})
      return mockResponse(405, {})
    }

    const result = await checkService({
      ...svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    assert.equal(result.healthStatus, 'degraded', 'should remain degraded when POST also fails')
    const updated = getService(svc.id)
    assert.notEqual(updated.http_method, 'POST', 'should NOT persist POST when it did not return 402')
  })

  it('x402 + http_method=POST in DB → goes straight to POST, no HEAD/GET', async () => {
    const svc = insertTestService({ protocol: 'x402', http_method: 'POST' })
    const validHeader = makePaymentHeader()
    const methods = []

    globalThis.fetch = async (url, opts) => {
      methods.push(opts?.method || 'GET')
      if (opts?.method === 'POST') return mockResponse(402, { 'payment-required': validHeader })
      return mockResponse(500, {})
    }

    const result = await checkService({
      ...svc,
      http_method: 'POST',
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    assert.equal(result.healthStatus, 'healthy', 'POST → 402 should be healthy')
    // performHttpCheck for POST sends one fetch call (POST), no HEAD/GET
    assert.ok(!methods.includes('HEAD'), 'should not send HEAD when http_method is POST')
    assert.ok(!methods.includes('GET'), 'should not send GET when http_method is POST')
    assert.ok(methods.includes('POST'), 'should send POST')
  })

  it('x402 + POST returns 402 → x402 payment validation runs on POST response', async () => {
    const svc = insertTestService({ protocol: 'x402' })
    const validHeader = makePaymentHeader()

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') return mockResponse(402, { 'payment-required': validHeader })
      return mockResponse(405, {})
    }

    await checkService({
      ...svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    const updated = getService(svc.id)
    assert.equal(updated.x402_payment_valid, 1, 'x402 payment validation should run on POST response and find valid header')
  })
})

// ─── Regression guards: L402 and MPP POST auto-detection ────────────────────

describe('L402/MPP POST auto-detection regression guards', () => {

  it('L402 + 405 on GET → POST retry → 402 with valid L402 headers → healthy', async () => {
    const svc = insertTestService({ protocol: 'L402' })

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') {
        return mockResponse(402, {
          'www-authenticate': `L402 macaroon="${specCompliantMacaroon}", invoice="${longInvoice}"`,
        })
      }
      return mockResponse(405, {})
    }

    const result = await checkService({
      ...svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    assert.equal(result.healthStatus, 'healthy', 'L402 POST retry should produce healthy')
    const updated = getService(svc.id)
    assert.equal(updated.http_method, 'POST', 'should persist POST for L402')
  })

  it('MPP + 405 on GET → POST retry → 402 with valid MPP headers → healthy', async () => {
    const svc = insertTestService({ protocol: 'MPP' })
    const requestB64 = Buffer.from('{}').toString('base64url')

    globalThis.fetch = async (url, opts) => {
      const method = opts?.method || 'GET'
      if (method === 'POST') {
        return mockResponse(402, {
          'www-authenticate': `Payment id="test-123" realm="mpp-test" method="tempo" intent="charge" request="${requestB64}"`,
        })
      }
      return mockResponse(405, {})
    }

    const result = await checkService({
      ...svc,
      latency_p50_ms: null,
      consecutive_failures: 0,
      x402_payment_valid: null,
    })

    assert.equal(result.healthStatus, 'healthy', 'MPP POST retry should produce healthy')
    const updated = getService(svc.id)
    assert.equal(updated.http_method, 'POST', 'should persist POST for MPP')
  })
})

// ─── Raw HTTP status at the insert site (#309 / #313) ───────────────────────

describe('a health_checks write that fails names the raw HTTP status', () => {
  it('406 → not_acceptable, which the CHECK enum rejects: the log line carries http=406 and the service id', async () => {
    const svc = insertTestService({ protocol: 'L402' })
    globalThis.fetch = async () => mockResponse(406, {})
    const logged = []
    const warn = mock.method(console, 'warn', (...a) => { logged.push(a.join(' ')) })
    const errorLog = mock.method(console, 'error', (...a) => { logged.push(a.join(' ')) })
    try {
      await checkService({ ...svc, latency_p50_ms: null, consecutive_failures: 0, x402_payment_valid: null }).catch(() => {})
    } finally {
      warn.mock.restore()
      errorLog.mock.restore()
    }
    const line = logged.find(l => l.includes(svc.id) && l.includes('http=406'))
    assert.ok(line, `expected a log line naming ${svc.id} and http=406, got: ${JSON.stringify(logged)}`)
    assert.match(line, /status=not_acceptable/)
  })
})
