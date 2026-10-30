/**
 * Digest payments block — give revenue claims a source.
 *
 * The index has no payment ledger of its own. There is no macaroon table, no token table,
 * no record that an invoice was ever issued or settled; all of that lives in the partner
 * gateway. So when the 2026-08-03 digest asked "did we lose a paying buyer today?", nothing
 * in this database could answer, and the report fell back to the one number that was to
 * hand — a user-agent's position in the 7-day top-15. That agent had simply drifted below a
 * volume cutoff it shares with `curl` and `python-urllib`; it had never paid for anything,
 * and it was still crawling on an unchanged schedule while the digest recorded it as lost.
 *
 * These tests pin a payments block sourced from the gateway itself, so the next digest can
 * cite paid-macaroon and sats-earned counts instead of inferring revenue from traffic rank.
 *
 * The block must never take the digest down with it. The digest is how the outage was found;
 * an unreachable gateway has to degrade to a reported null, not a 500.
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { resetProvider } from '../src/services/l402-provider.js'

let startServer, stopServer, API
let gatewayStub, gatewayUrl, gatewayMode

const DIGEST_KEY = process.env.DIGEST_API_KEY || 'test-digest-key'

function digest() {
  return fetch(`${API}/api/v1/digest`, { headers: { Authorization: `Bearer ${DIGEST_KEY}` } })
}

function usePartnerGateway() {
  process.env.L402_GATEWAY = 'partner'
  process.env.PARTNER_GATEWAY_URL = gatewayUrl
  process.env.PARTNER_GATEWAY_API_KEY = 'test-key'
  resetProvider()
}

describe('digest payments block', () => {
  before(async () => {
    gatewayMode = 'ok'
    gatewayStub = http.createServer((_req, res) => {
      if (gatewayMode === 'down') {
        res.writeHead(503)
        res.end('gateway down')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        healthy: true,
        activeMacaroons: 77,
        paidMacaroons: 0,
        unpaidMacaroons: 77,
        satsEarnedTotal: 0,
        walletBalanceSats: 34882,
      }))
    })
    await new Promise(r => gatewayStub.listen(0, '127.0.0.1', r))
    gatewayUrl = `http://127.0.0.1:${gatewayStub.address().port}`

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
    gatewayMode = 'ok'
    resetProvider()
  })

  it('reports paid and unpaid macaroon counts from the gateway', async () => {
    usePartnerGateway()
    const res = await digest()
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.ok(body.payments, 'digest must carry a payments block')
    assert.equal(body.payments.paid_macaroons, 0)
    assert.equal(body.payments.unpaid_macaroons, 77)
    assert.equal(body.payments.active_macaroons, 77)
  })

  it('reports lifetime sats earned, the number revenue claims should cite', async () => {
    usePartnerGateway()
    const res = await digest()
    const body = await res.json()
    assert.equal(body.payments.sats_earned_total, 0)
  })

  it('marks the gateway reachable when it answers', async () => {
    usePartnerGateway()
    const res = await digest()
    const body = await res.json()
    assert.equal(body.payments.gateway_reachable, true)
    assert.equal(body.payments.error, null)
  })

  it('degrades to a reported null when the gateway is down, without failing the digest', async () => {
    usePartnerGateway()
    gatewayMode = 'down'
    const res = await digest()

    assert.equal(res.status, 200, 'an unreachable gateway must not break the digest')
    const body = await res.json()
    assert.equal(body.payments.gateway_reachable, false)
    assert.equal(body.payments.paid_macaroons, null)
    assert.equal(body.payments.sats_earned_total, null)
    assert.ok(typeof body.payments.error === 'string' && body.payments.error.length > 0,
      'the reason the gateway could not be read must be reported, not swallowed')
  })

  it('still returns every pre-existing digest section alongside payments', async () => {
    usePartnerGateway()
    const res = await digest()
    const body = await res.json()
    for (const key of ['totals', 'registrations', 'traffic', 'search_intelligence', 'health_changes']) {
      assert.ok(body[key], `digest lost its ${key} section`)
    }
  })

  it('reports gateway_reachable false when no gateway is configured at all', async () => {
    process.env.L402_GATEWAY = 'none'
    resetProvider()
    const res = await digest()
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.payments.gateway_reachable, false)
    assert.equal(body.payments.paid_macaroons, null)
  })
})
