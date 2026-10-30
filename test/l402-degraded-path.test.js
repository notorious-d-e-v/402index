/**
 * L402 degraded path — what a buyer sees when the payment gateway cannot issue an invoice.
 *
 * Written after the 2026-08-03 Boltz outage. Boltz disabled swap creation at 08:52:56Z;
 * every `/l402/challenge` failed for the rest of the day. The index handled that badly in
 * two different ways, and a well-behaved agent walked straight through both of them:
 *
 *   1. `GET /api/v1/export.csv` returned a bare 402 whose body said "Add ?l402=require to
 *      any API endpoint" — an instruction that cannot be satisfied while the gateway is down.
 *   2. `402explorer/0.1` followed that instruction, and `?l402=require` (which sets the free
 *      limit to 0 precisely so a challenge gets minted) fell through to
 *      `429 Too Many Requests · Retry-After: 60 · "Rate limit exceeded. Try again later."`
 *
 * So an agent asking to pay was told it had been rate-limited and should retry in a minute,
 * for a condition that no amount of retrying would ever clear. That is the part of the
 * outage we own. These tests pin the honest behaviour: 503, a body that names the cause,
 * and a Retry-After that does not promise the problem is about to go away.
 *
 * The paid path is asserted here too. A degradation fix that quietly breaks invoice issuance
 * would be worse than the bug it replaces.
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { resetProvider } from '../src/services/l402-provider.js'

let startServer, stopServer, API
let gatewayStub, gatewayUrl

/**
 * Stand-in for the partner gateway. Returns exactly what the gateway returned all through
 * the outage: a 500, because it catches the upstream swap provider's
 * `400 {"error":"swap creation is disabled"}` and reports it as a server error of its own.
 */
function startGatewayStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })
    })
  })
}

/** Point the provider at the dead gateway and force a fresh construction. */
function useBrokenGateway() {
  process.env.L402_ENABLED = 'true'
  process.env.L402_GATEWAY = 'partner'
  process.env.PARTNER_GATEWAY_URL = gatewayUrl
  process.env.PARTNER_GATEWAY_API_KEY = 'test-key'
  resetProvider()
}

/** Point the provider at the in-process mock, which always mints a valid challenge. */
function useWorkingGateway() {
  process.env.L402_ENABLED = 'true'
  process.env.L402_GATEWAY = 'mock'
  delete process.env.NODE_ENV
  resetProvider()
}

describe('L402 degraded path (2026-08-03 Boltz outage)', () => {
  before(async () => {
    const stub = await startGatewayStub((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to create challenge' }))
    })
    gatewayStub = stub.srv
    gatewayUrl = stub.url

    const srv = await import('./helpers/server.js')
    startServer = srv.startServer
    stopServer = srv.stopServer
    API = await startServer()
  })

  after(async () => {
    await stopServer()
    await new Promise(r => gatewayStub.close(r))
    resetProvider()
  })

  beforeEach(() => {
    resetProvider()
  })

  describe('export.csv when the gateway cannot issue an invoice', () => {
    it('returns 503, not a 402 the buyer cannot act on', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      assert.equal(res.status, 503, 'a paywall that cannot take payment is unavailable, not payment-required')
    })

    it('does not tell the buyer to add ?l402=require', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      const body = await res.json()
      assert.ok(
        !JSON.stringify(body).includes('l402=require'),
        `body must not point at a dead end, got: ${JSON.stringify(body)}`,
      )
    })

    it('names the cause as an upstream outage rather than a rate limit', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      const body = await res.json()
      assert.equal(body.reason, 'l402_gateway_unavailable')
      assert.notEqual(body.error, 'Too Many Requests')
      // The message may mention rate limits, but only to rule one out — "not a rate limit"
      // is the point. What it must never do is assert the caller exceeded one.
      assert.ok(
        !/rate limit exceeded/i.test(body.message),
        `message must not claim a rate limit was exceeded, got: ${body.message}`,
      )
      assert.ok(
        /upstream/i.test(body.message),
        `message should name the real cause, got: ${body.message}`,
      )
    })

    /**
     * Raised from 300s on 2026-08-05. Boltz announced the shutdown is indefinite — "do not
     * expect swap services to resume shortly", no ETA, and the company is unsure it will
     * resume at all. A five-minute Retry-After against that is a smaller version of the same
     * lie the 429 told: it implies the problem is nearly over. An hour is the floor now, and
     * operators can raise it without a deploy.
     */
    it('sends a Retry-After sized to an outage with no estimated end', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      const retryAfter = Number(res.headers.get('retry-after'))
      assert.ok(Number.isFinite(retryAfter), 'Retry-After must be present')
      assert.ok(retryAfter >= 3600, `Retry-After should not imply near-term recovery, got ${retryAfter}`)
    })

    it('lets an operator set Retry-After without a deploy', async () => {
      useBrokenGateway()
      process.env.L402_UNAVAILABLE_RETRY_AFTER_SECONDS = '7200'
      try {
        const res = await fetch(`${API}/api/v1/export.csv`)
        assert.equal(res.headers.get('retry-after'), '7200')
        const body = await res.json()
        assert.equal(body.retry_after, 7200)
      } finally {
        delete process.env.L402_UNAVAILABLE_RETRY_AFTER_SECONDS
      }
    })

    it('does not describe an indefinite shutdown as a passing outage', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      const body = await res.json()
      assert.ok(
        !/temporar|shortly|soon|brief/i.test(body.message),
        `message must not imply near-term recovery, got: ${body.message}`,
      )
    })

    it('offers no WWW-Authenticate header, because there is no challenge to answer', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      assert.equal(res.headers.get('www-authenticate'), null)
    })
  })

  describe('?l402=require when the gateway cannot issue an invoice', () => {
    it('returns 503 rather than a false 429', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/categories?l402=require`)
      assert.equal(res.status, 503, 'the client asked to pay; it was not rate limited')
    })

    it('does not claim the rate limit was exceeded', async () => {
      useBrokenGateway()
      const res = await fetch(`${API}/api/v1/categories?l402=require`)
      const body = await res.json()
      assert.notEqual(body.error, 'Too Many Requests')
      assert.equal(body.reason, 'l402_gateway_unavailable')
    })
  })

  describe('the paid path is unchanged when the gateway works', () => {
    it('export.csv still returns 402 with an invoice and WWW-Authenticate', async () => {
      useWorkingGateway()
      const res = await fetch(`${API}/api/v1/export.csv`)
      assert.equal(res.status, 402)
      const wwwAuth = res.headers.get('www-authenticate')
      assert.ok(wwwAuth && wwwAuth.startsWith('L402 '), `expected an L402 challenge, got: ${wwwAuth}`)
      const body = await res.json()
      assert.ok(body.invoice, 'a working gateway must still return an invoice')
      assert.ok(body.macaroon)
      assert.equal(body.error, 'Payment Required')
    })

    it('?l402=require still returns 402 with an invoice', async () => {
      useWorkingGateway()
      const res = await fetch(`${API}/api/v1/categories?l402=require`)
      assert.equal(res.status, 402)
      const body = await res.json()
      assert.ok(body.invoice, 'a working gateway must still mint a challenge on ?l402=require')
    })
  })
})
