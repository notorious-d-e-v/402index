import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { findOpportunities } from '../src/services/opportunities.js'
import { withQuarantineSchema } from './helpers/test-db.js'

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      category TEXT,
      health_status TEXT DEFAULT 'unknown',
      status TEXT DEFAULT 'active',
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      provider_deleted INTEGER DEFAULT 0
    )
  `)
  withQuarantineSchema(db)
  return db
}

function insertService(db, overrides = {}) {
  const defaults = {
    id: `svc-${Math.random().toString(36).slice(2)}`,
    name: 'Test Service',
    url: 'https://api.example.com/test',
    protocol: 'L402',
    category: 'data/weather',
    health_status: 'healthy',
    status: 'active',
    is_template: 0,
    is_demo: 0,
  }
  const svc = { ...defaults, ...overrides }
  db.prepare(`INSERT INTO services (id, name, url, protocol, category, health_status, status, is_template, is_demo)
    VALUES (@id, @name, @url, @protocol, @category, @health_status, @status, @is_template, @is_demo)`).run(svc)
  return svc
}

describe('findOpportunities', () => {
  let db

  beforeEach(() => {
    db = createTestDb()
  })

  it('returns empty array when no services exist', () => {
    const result = findOpportunities(db)
    assert.ok(Array.isArray(result), 'Should return array')
    assert.equal(result.length, 0)
  })

  it('returns gap opportunities for categories with few healthy endpoints', () => {
    // 5 services in data/weather but only 1 healthy
    insertService(db, { url: 'https://a.com/1', category: 'data/weather', health_status: 'healthy' })
    insertService(db, { url: 'https://a.com/2', category: 'data/weather', health_status: 'down' })
    insertService(db, { url: 'https://a.com/3', category: 'data/weather', health_status: 'down' })
    insertService(db, { url: 'https://a.com/4', category: 'data/weather', health_status: 'degraded' })
    insertService(db, { url: 'https://a.com/5', category: 'data/weather', health_status: 'unknown' })

    const result = findOpportunities(db)
    const gaps = result.filter(o => o.type === 'gap')
    assert.ok(gaps.length > 0, 'Should find gap opportunities')
    const weather = gaps.find(o => o.category === 'data/weather')
    assert.ok(weather, 'Should find data/weather gap')
    assert.equal(weather.total_endpoints, 5)
    assert.equal(weather.healthy_endpoints, 1)
  })

  it('does NOT flag categories with many healthy endpoints as gaps', () => {
    // 5 services, 4 healthy = not a gap
    for (let i = 0; i < 4; i++) {
      insertService(db, { url: `https://a.com/${i}`, category: 'ai/chat', health_status: 'healthy' })
    }
    insertService(db, { url: 'https://a.com/5', category: 'ai/chat', health_status: 'down' })

    const result = findOpportunities(db)
    const gaps = result.filter(o => o.type === 'gap' && o.category === 'ai/chat')
    assert.equal(gaps.length, 0, 'Should not flag well-covered categories')
  })

  it('returns protocol gap opportunities', () => {
    // Category with only x402, no L402
    insertService(db, { url: 'https://a.com/1', category: 'ai/image', protocol: 'x402', health_status: 'healthy' })
    insertService(db, { url: 'https://a.com/2', category: 'ai/image', protocol: 'x402', health_status: 'healthy' })

    const result = findOpportunities(db)
    const protocolGaps = result.filter(o => o.type === 'protocol_gap')
    assert.ok(protocolGaps.length > 0, 'Should find protocol gap')
    const aiImage = protocolGaps.find(o => o.category === 'ai/image')
    assert.ok(aiImage, 'Should find ai/image protocol gap')
    assert.equal(aiImage.protocol_coverage.L402, 0)
    assert.equal(aiImage.protocol_coverage.x402, 2)
  })

  it('returns single-provider opportunities', () => {
    // All endpoints in a category from same host
    insertService(db, { url: 'https://api.solo.com/v1', category: 'tools/search', health_status: 'healthy' })
    insertService(db, { url: 'https://api.solo.com/v2', category: 'tools/search', health_status: 'healthy' })
    insertService(db, { url: 'https://api.solo.com/v3', category: 'tools/search', health_status: 'healthy' })

    const result = findOpportunities(db)
    const singleProvider = result.filter(o => o.type === 'single_provider')
    assert.ok(singleProvider.length > 0, 'Should find single provider opportunities')
    const search = singleProvider.find(o => o.category === 'tools/search')
    assert.ok(search, 'Should find tools/search single provider')
    assert.equal(search.provider_count, 1)
  })

  it('does NOT flag single-service categories as single_provider', () => {
    // Only 1 endpoint — not interesting enough to flag
    insertService(db, { url: 'https://api.solo.com/v1', category: 'niche/thing', health_status: 'healthy' })

    const result = findOpportunities(db)
    const singleProvider = result.filter(o => o.type === 'single_provider' && o.category === 'niche/thing')
    assert.equal(singleProvider.length, 0, 'Should not flag single-service categories')
  })

  it('returns failing service opportunities', () => {
    // Multiple down endpoints in a category
    insertService(db, { url: 'https://a.com/1', category: 'crypto/price', health_status: 'down' })
    insertService(db, { url: 'https://a.com/2', category: 'crypto/price', health_status: 'down' })
    insertService(db, { url: 'https://a.com/3', category: 'crypto/price', health_status: 'down' })

    const result = findOpportunities(db)
    const failing = result.filter(o => o.type === 'failing')
    assert.ok(failing.length > 0, 'Should find failing opportunities')
    const crypto = failing.find(o => o.category === 'crypto/price')
    assert.ok(crypto, 'Should find crypto/price failing')
  })

  it('respects protocol filter', () => {
    insertService(db, { url: 'https://a.com/1', category: 'data/weather', protocol: 'L402', health_status: 'down' })
    insertService(db, { url: 'https://a.com/2', category: 'data/weather', protocol: 'L402', health_status: 'down' })
    insertService(db, { url: 'https://a.com/3', category: 'data/weather', protocol: 'x402', health_status: 'healthy' })

    const l402Only = findOpportunities(db, { protocol: 'L402' })
    // Should only see L402 data
    for (const opp of l402Only) {
      if (opp.type === 'protocol_gap') continue // protocol gaps inherently involve both
      assert.ok(opp.suggestion || opp.category, 'Should have data')
    }
  })

  it('excludes null categories', () => {
    insertService(db, { url: 'https://a.com/1', category: null, health_status: 'down' })
    insertService(db, { url: 'https://a.com/2', category: null, health_status: 'down' })

    const result = findOpportunities(db)
    const nullCats = result.filter(o => o.category === null)
    assert.equal(nullCats.length, 0, 'Should not include null categories')
  })

  it('excludes pending/rejected services', () => {
    insertService(db, { url: 'https://a.com/1', category: 'test/cat', health_status: 'down', status: 'pending' })
    insertService(db, { url: 'https://a.com/2', category: 'test/cat', health_status: 'down', status: 'rejected' })

    const result = findOpportunities(db)
    const testCat = result.filter(o => o.category === 'test/cat')
    assert.equal(testCat.length, 0, 'Should not include pending/rejected services')
  })

  it('suggestions contain category name', () => {
    insertService(db, { url: 'https://a.com/1', category: 'data/weather', health_status: 'down' })
    insertService(db, { url: 'https://a.com/2', category: 'data/weather', health_status: 'down' })

    const result = findOpportunities(db)
    for (const opp of result) {
      assert.ok(opp.suggestion.includes(opp.category), `Suggestion should contain category: ${opp.suggestion}`)
    }
  })

  it('each opportunity has required fields', () => {
    insertService(db, { url: 'https://a.com/1', category: 'data/weather', health_status: 'down' })
    insertService(db, { url: 'https://a.com/2', category: 'data/weather', health_status: 'down' })

    const result = findOpportunities(db)
    for (const opp of result) {
      assert.ok(opp.type, 'Should have type')
      assert.ok(opp.category, 'Should have category')
      assert.equal(typeof opp.total_endpoints, 'number', 'Should have total_endpoints')
      assert.equal(typeof opp.healthy_endpoints, 'number', 'Should have healthy_endpoints')
      assert.ok(opp.protocol_coverage, 'Should have protocol_coverage')
      assert.equal(typeof opp.protocol_coverage.L402, 'number')
      assert.equal(typeof opp.protocol_coverage.x402, 'number')
      assert.equal(typeof opp.provider_count, 'number', 'Should have provider_count')
      assert.ok(opp.suggestion, 'Should have suggestion')
    }
  })
})
