/**
 * Bazaar poll stores the HTTP method a v2 item declares (#353).
 *
 * The upsert had no http_method column, so every Bazaar-sourced row took the
 * column default, GET, even when the item's Bazaar declaration said POST.
 *
 * Run: DB_PATH=:memory: node --test test/bazaar-v2-fields.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'

function v2Item(url, method) {
  return {
    resource: url,
    type: 'http',
    x402Version: 2,
    description: 'Test service',
    serviceName: 'Example Data',
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '5000', extra: { name: 'USD Coin' } }],
    extensions: method === undefined
      ? undefined
      : { bazaar: { info: { input: { type: 'http', method }, output: { type: 'json' } } } },
  }
}

function stubBazaar(items) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ pagination: { total: items.length }, items }),
  })
}

const methodOf = (url) =>
  db.prepare('SELECT http_method FROM services WHERE url = ? AND protocol = ?').get(url, 'x402')?.http_method

describe('Bazaar poll: http_method from the v2 declaration (#353)', () => {
  let originalFetch
  const url = `https://bazaar-v2-method-${Date.now()}.example.com/api`

  beforeEach(() => { originalFetch = globalThis.fetch })

  afterEach(() => {
    globalThis.fetch = originalFetch
    db.prepare('DELETE FROM services WHERE url = ? AND protocol = ?').run(url, 'x402')
    db.prepare("DELETE FROM sync_state WHERE key IN ('bazaar_offset', 'bazaar_last_full_pass')").run()
  })

  it('stores POST for a new row that declares POST', async () => {
    stubBazaar([v2Item(url, 'POST')])
    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now()}`)
    await pollBazaar()
    assert.equal(methodOf(url), 'POST')
  })

  it('keeps the GET default for a new row that declares nothing', async () => {
    stubBazaar([v2Item(url, undefined)])
    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 1}`)
    await pollBazaar()
    assert.equal(methodOf(url), 'GET')
  })

  it('updates an existing GET row when the declaration says POST', async () => {
    db.prepare(`INSERT INTO services (id, name, url, protocol, source, http_method)
      VALUES (?, 'Test', ?, 'x402', 'bazaar', 'GET')`).run(randomUUID(), url)
    stubBazaar([v2Item(url, 'POST')])
    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 2}`)
    await pollBazaar()
    assert.equal(methodOf(url), 'POST')
  })

  it('does not reset a stored method when the item declares none', async () => {
    db.prepare(`INSERT INTO services (id, name, url, protocol, source, http_method)
      VALUES (?, 'Test', ?, 'x402', 'bazaar', 'POST')`).run(randomUUID(), url)
    stubBazaar([v2Item(url, undefined)])
    const { pollBazaar } = await import(`../src/aggregators/bazaar.js?t=${Date.now() + 3}`)
    await pollBazaar()
    assert.equal(methodOf(url), 'POST')
  })
})
