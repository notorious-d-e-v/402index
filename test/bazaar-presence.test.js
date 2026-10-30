// Bazaar churn (2026-10-27): the index held ~189k source=bazaar rows while the live Bazaar
// listing had ~85k. Each full pass now stamps the rows it lists; rows the listing has dropped
// are marked upstream-missing, and retired after 7 complete passes without them. Retirement is
// status='retired' (not provider_deleted, which purgeSoftDeleted hard-deletes after 30 days)
// and a relisted row comes back on its own.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'

const P = 'https://bazaar-presence-test'
const item = (n) => ({ resource: `${P}-${n}.example.com/api`, accepts: [{ resource: `${P}-${n}.example.com/api`, maxAmountRequired: '10000', network: 'base', description: `Presence ${n}` }] })

let originalFetch
function serve(items, total = items.length) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ pagination: { total }, items }) })
}
async function poll() {
  const { pollBazaar } = await import('../src/aggregators/bazaar.js')
  await pollBazaar()
}
const row = (n) => db.prepare('SELECT status, bazaar_seen_pass, upstream_missing_since, retired_batch FROM services WHERE url = ?').get(`${P}-${n}.example.com/api`)
const cleanup = () => {
  db.prepare("DELETE FROM services WHERE url LIKE 'https://bazaar-presence-test%'").run()
  db.prepare("DELETE FROM sync_state WHERE key IN ('bazaar_offset', 'bazaar_last_full_pass', 'bazaar_pass_id')").run()
  db.prepare('DELETE FROM bazaar_passes').run()
}

beforeEach(() => { originalFetch = globalThis.fetch; cleanup() })
afterEach(() => { globalThis.fetch = originalFetch; cleanup() })

describe('Bazaar presence tracking', () => {
  it('a full pass stamps listed rows, records the upstream total, and flags rows the listing dropped', async () => {
    serve([item(1), item(2), item(3)])
    await poll()
    const first = row(1).bazaar_seen_pass
    assert.ok(first, 'listed rows carry the pass id')
    const pass = db.prepare('SELECT * FROM bazaar_passes WHERE pass_id = ?').get(first)
    assert.equal(pass.upstream_total, 3)
    assert.equal(pass.seen, 3)
    assert.equal(pass.complete, 1)

    serve([item(1), item(2)])
    await poll()
    assert.equal(row(1).upstream_missing_since, null)
    assert.ok(row(3).upstream_missing_since, 'row 3 is no longer listed')
    assert.equal(row(3).status, 'active', 'missing is a bucket, not yet retirement')
  })

  it('retires a row after 7 complete passes without it, and a relisted row comes back', async () => {
    serve([item(1), item(2)])
    await poll()
    for (let i = 0; i < 6; i++) { serve([item(1)]); await poll() }
    assert.equal(row(2).status, 'active', 'six passes are not enough')
    serve([item(1)]); await poll()
    assert.equal(row(2).status, 'retired')
    assert.match(row(2).retired_batch, /^auto-pass-\d+$/)

    serve([item(1), item(2)]); await poll()
    assert.equal(row(2).status, 'active', 'relisting restores the row')
    assert.equal(row(2).retired_batch, null)
    assert.equal(row(2).upstream_missing_since, null)
  })

  it('a pass that saw under 90% of the upstream total does not count toward retirement', async () => {
    serve([item(1), item(2)])
    await poll()
    for (let i = 0; i < 8; i++) { serve([item(1)], 50); await poll() }
    assert.equal(row(2).status, 'active')
    const counted = db.prepare('SELECT COUNT(*) c FROM bazaar_passes WHERE complete = 1').get().c
    assert.equal(counted, 1)
  })
})

describe('/api/v1/health reports the drift', () => {
  it('exposes the last upstream total, the missing bucket and the retired count', async () => {
    const { startServer, stopServer } = await import('./helpers/server.js')
    const base = await startServer()
    try {
      serve([item(1), item(2)]); await poll()
      serve([item(1)]); await poll()
      db.prepare("UPDATE services SET status = 'retired', retired_batch = 'test' WHERE url = ?").run(`${P}-1.example.com/api`)
      const h = await (await originalFetch(`${base}/api/v1/health`)).json()
      assert.equal(h.bazaar.upstream_total, 1)
      assert.ok(h.bazaar.upstream_missing >= 1)
      assert.ok(h.excluded_retired >= 1)
    } finally {
      await stopServer()
    }
  })
})
