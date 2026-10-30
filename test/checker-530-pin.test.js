// Regression pin, not a RED test (2026-10-27).
//
// The cleanup prompt reported that a Cloudflare 530 (body "error code: 1033", tunnel origin
// unreachable) had been recorded as 402/healthy for market.datapackvibe.com. Investigation:
// three days of stored checks for that host hold zero 530s, every 5xx was classified down, and
// the host itself had come back by 2026-10-25 (x402-foundation/x402#3844), so the 402s were real.
// This test passes on the code as it stood; it exists so that a 530 on GET, HEAD and POST keeps
// meaning down.

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'dns'
import { classifyHealthStatus } from '../src/health/checker.js'

const originalFetch = globalThis.fetch
let dnsMock, probeEndpoint, calls

beforeEach(async () => {
  dnsMock = mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34', family: 4 }))
  probeEndpoint = (await import('../src/services/probe-endpoint.js')).probeEndpoint
  calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push(opts?.method || 'GET')
    return new Response(opts?.method === 'HEAD' ? null : 'error code: 1033', { status: 530, headers: { 'content-type': 'text/plain', server: 'cloudflare' } })
  }
})
afterEach(() => { globalThis.fetch = originalFetch; dnsMock.mock.restore() })

describe('Cloudflare 530 / 1033 is down, on every method', () => {
  it('GET listing: HEAD then GET both 530, no POST promotion, classified down', async () => {
    const r = await probeEndpoint('https://market.datapackvibe.example/x402/a', { method: 'GET', postFallback: true })
    assert.deepEqual(calls, ['HEAD', 'GET'])
    assert.equal(r.httpStatus, 530)
    const c = classifyHealthStatus(r.httpStatus, r.errorMessage, 0, 60, r.responseTimeMs)
    assert.equal(c.checkStatus, 'down')
    assert.equal(c.healthStatus, 'degraded', 'first failure degrades; the third makes it down')
    assert.equal(classifyHealthStatus(530, null, 2, 60, 50).healthStatus, 'down')
  })

  it('POST listing (probe_body path): 530 stays 530', async () => {
    const r = await probeEndpoint('https://market.datapackvibe.example/x402/b', { method: 'POST', body: '{}' })
    assert.deepEqual(calls, ['POST'])
    assert.equal(r.httpStatus, 530)
    assert.equal(classifyHealthStatus(r.httpStatus, null, 0, 60, 50).checkStatus, 'down')
  })
})
