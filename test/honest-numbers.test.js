// Honest numbers (2026-10-27): every surface reports the same total, "payment verified" says
// what it measures, and the weekly registration count is registrations.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

const DIGEST = { Authorization: `Bearer ${process.env.DIGEST_API_KEY || 'test-digest-key'}` }
let BASE, db, stopServer

before(async () => {
  const srv = await import('./helpers/server.js')
  stopServer = srv.stopServer
  BASE = await srv.startServer()
  db = (await import('../src/db.js')).default
})
after(async () => {
  db.prepare("DELETE FROM services WHERE id LIKE 'honest-%'").run()
  await stopServer()
})

const add = (id, source, status = 'active') => db.prepare(
  "INSERT OR REPLACE INTO services (id, name, url, protocol, source, status, hostname, registered_at) VALUES (?, ?, ?, 'x402', ?, ?, ?, datetime('now'))"
).run(id, id, `https://${id}.example.test/x`, source, status, `${id}.example.test`)

describe('one total everywhere', () => {
  it('homepage, /api/v1/health, llms.txt and the digest agree to the row', async () => {
    add('honest-a', 'bazaar'); add('honest-b', 'self-registered'); add('honest-c', 'bazaar', 'retired')
    const health = await (await fetch(`${BASE}/api/v1/health`)).json()
    const digest = await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()
    const llms = await (await fetch(`${BASE}/llms.txt`)).text()
    const home = await (await fetch(`${BASE}/`)).text()
    const n = health.total_endpoints
    assert.equal(digest.totals.endpoints, n)
    assert.match(llms, new RegExp(`Currently indexing: ${n} endpoints`))
    assert.ok(home.includes(n.toLocaleString('en-US')), `homepage should show ${n.toLocaleString('en-US')}`)
  })
})

describe('"payment verified" says what it measures', () => {
  it('the digest names the meaning next to the count', async () => {
    const d = await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()
    assert.equal(d.totals.payment_verified_means, '402 header parsed')
  })

  it('directory filter, badges and about page say "402 header parsed", not "payment verified"', async () => {
    const dir = await (await fetch(`${BASE}/directory`)).text()
    assert.match(dir, /402 header parsed/)
    assert.doesNotMatch(dir, /Payment verified/i)
    const about = await (await fetch(`${BASE}/about`)).text()
    assert.doesNotMatch(about, /payment-verified/i)
    const { serviceBadges } = await import('../src/views/helpers.js').catch(() => ({}))
    const helpersSrc = (await import('node:fs')).readFileSync(new URL('../src/views/helpers.js', import.meta.url), 'utf8')
    const demoSrc = (await import('node:fs')).readFileSync(new URL('../src/views/demo.js', import.meta.url), 'utf8')
    assert.doesNotMatch(helpersSrc + demoSrc, /title="Payment Verified"/, serviceBadges ? '' : 'badge title')
  })
})

describe('registrations.last_7d_count counts registrations', () => {
  it('counts POST /register rows (pending included), not poller imports', async () => {
    const before = (await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()).registrations.last_7d_count
    add('honest-import', 'bazaar')
    add('honest-reg-pending', 'self-registered', 'pending')
    add('honest-reg-pending-2', 'self-registered', 'pending')
    const after = (await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()).registrations.last_7d_count
    assert.equal(after - before, 2)
  })
})

describe('the digest shows what it excludes', () => {
  it('totals carries excluded_quarantined, excluded_retired and bazaar_upstream_missing, matching /api/v1/health', async () => {
    add('honest-ret', 'bazaar', 'retired')
    const health = await (await fetch(`${BASE}/api/v1/health`)).json()
    const d = await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()
    assert.equal(d.totals.excluded_quarantined, health.excluded_quarantined)
    assert.equal(d.totals.excluded_retired, health.excluded_retired)
    assert.ok(d.totals.excluded_retired >= 1)
    assert.equal(d.totals.bazaar_upstream_missing, health.bazaar.upstream_missing)
    assert.equal(d.totals.bazaar_upstream_total, health.bazaar.upstream_total)
  })
})
