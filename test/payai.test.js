/**
 * Tests for the PayAI discovery poller (src/aggregators/payai.js).
 *
 * PayAI serves a Bazaar-compatible catalog at facilitator.payai.network/discovery/resources.
 * Many resources are listed on both PayAI and the CDP Bazaar, so the poller must not
 * overwrite rows another source already owns: it only tags them with ',payai'.
 *
 * Run: DB_PATH=:memory: node --test test/payai.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import db from '../src/db.js'

const originalFetch = globalThis.fetch

const V1_URL = 'https://alpha.payai-test.example.com/api/v1/weather'
const V2_URL = 'https://beta.payai-test.example.com/api/v1/search'

function v1Item(url, maxAmountRequired = '10000') {
  return {
    resource: url,
    type: 'http',
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network: 'base',
      resource: url,
      maxAmountRequired,
      description: 'Weather forecast for a city',
      payTo: '0x0000000000000000000000000000000000000001',
    }],
  }
}

function v2Item(url) {
  return {
    resource: url,
    type: 'http',
    x402Version: 2,
    description: 'Web search',
    accepts: [{
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '5000',
      payTo: 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx',
    }],
  }
}

function page(items, total = items.length) {
  return { x402Version: 1, items, pagination: { limit: 100, offset: 0, total } }
}

function mockFetch(pages) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const offset = parseInt(new URL(url).searchParams.get('offset')) || 0
    const body = pages[Math.floor(offset / 100)] || page([], 0)
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

function seedRow({ url, source, name = 'Seeded name', price_usd = 0.42 }) {
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, price_usd, source, source_id, hostname)
    VALUES (?, ?, ?, 'x402', ?, ?, ?, ?)
  `).run(randomUUID(), name, url, price_usd, source, `seed:${url}`, new URL(url).hostname)
}

function cleanup() {
  db.prepare("DELETE FROM services WHERE url LIKE '%payai-test.example.com%'").run()
  db.prepare("DELETE FROM sync_state WHERE key IN ('payai_offset', 'payai_last_full_pass')").run()
}

describe('pollPayai', () => {
  beforeEach(cleanup)

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanup()
  })

  it('ingests new resources as x402 with source payai', async () => {
    mockFetch([page([v1Item(V1_URL), v2Item(V2_URL)])])

    const { pollPayai } = await import('../src/aggregators/payai.js')
    const result = await pollPayai()

    assert.equal(result.new, 2)
    assert.equal(result.errors, 0)
    const rows = db.prepare("SELECT protocol, source FROM services WHERE url LIKE '%payai-test.example.com%'").all()
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.protocol, 'x402')
      assert.equal(row.source, 'payai')
    }
  })

  it('requests the PayAI catalog with limit=100 and walks every page', async () => {
    const first = Array.from({ length: 100 }, (_, i) => v1Item(`https://p${i}.payai-test.example.com/api`))
    const calls = mockFetch([page(first, 101), page([v2Item(V2_URL)], 101)])

    const { pollPayai } = await import('../src/aggregators/payai.js')
    const result = await pollPayai()

    assert.equal(calls.length, 2)
    assert.ok(calls[0].startsWith('https://facilitator.payai.network/discovery/resources?'))
    assert.match(calls[0], /limit=100&offset=0/)
    assert.match(calls[1], /limit=100&offset=100/)
    assert.equal(result.new, 101)
  })

  it('does not overwrite a row the Bazaar already indexed, only tags it', async () => {
    seedRow({ url: V1_URL, source: 'bazaar', name: 'Bazaar name', price_usd: 0.42 })
    mockFetch([page([v1Item(V1_URL, '990000')])])

    const { pollPayai } = await import('../src/aggregators/payai.js')
    const result = await pollPayai()

    assert.equal(result.new, 0)
    assert.equal(result.shared, 1)
    const row = db.prepare("SELECT name, price_usd, source FROM services WHERE url = ? AND protocol = 'x402'").get(V1_URL)
    assert.equal(row.name, 'Bazaar name')
    assert.equal(row.price_usd, 0.42)
    assert.equal(row.source, 'bazaar,payai')
  })

  it('appends the payai token only once across polls', async () => {
    seedRow({ url: V1_URL, source: 'bazaar' })
    mockFetch([page([v1Item(V1_URL)])])

    const { pollPayai } = await import('../src/aggregators/payai.js')
    await pollPayai()
    await pollPayai()

    const row = db.prepare("SELECT source FROM services WHERE url = ? AND protocol = 'x402'").get(V1_URL)
    assert.equal(row.source, 'bazaar,payai')
  })

  it('updates rows it owns on the next poll', async () => {
    mockFetch([page([v1Item(V1_URL, '10000')])])
    const { pollPayai } = await import('../src/aggregators/payai.js')
    await pollPayai()

    mockFetch([page([v1Item(V1_URL, '20000')])])
    const result = await pollPayai()

    assert.equal(result.updated, 1)
    const row = db.prepare("SELECT price_usd, source FROM services WHERE url = ? AND protocol = 'x402'").get(V1_URL)
    assert.equal(row.price_usd, 0.02)
    assert.equal(row.source, 'payai')
  })

  it('handles HTTP error without throwing', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 })

    const { pollPayai } = await import('../src/aggregators/payai.js')
    const result = await pollPayai()

    assert.equal(result.new, 0)
    assert.equal(result.updated, 0)
    assert.equal(result.errors, 0)
  })
})
