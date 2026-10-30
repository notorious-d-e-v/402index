import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buildServiceQuery, queryServices, API_COLUMNS, PAGE_COLUMNS } from '../src/queries/services.js'
import { withQuarantineSchema } from './helpers/test-db.js'

// Minimal schema matching production services table (domain_verified included)
const CREATE_TABLE = `CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  description TEXT,
  url TEXT,
  protocol TEXT,
  status TEXT DEFAULT 'active',
  provider_deleted INTEGER DEFAULT 0,
  price_sats REAL,
  price_usd REAL,
  payment_asset TEXT,
  payment_network TEXT,
  category TEXT DEFAULT 'uncategorized',
  provider TEXT,
  source TEXT DEFAULT 'bazaar',
  featured INTEGER DEFAULT 0,
  health_status TEXT DEFAULT 'unknown',
  uptime_30d REAL,
  latency_p50_ms INTEGER,
  last_checked TEXT,
  registered_at TEXT,
  http_method TEXT,
  reliability_score REAL,
  x402_payment_valid INTEGER DEFAULT 0,
  x402_facilitator_reachable INTEGER,
  x402_asset_known INTEGER,
  l402_compliant INTEGER,
  l402_degrade_reason TEXT,
  l402_format TEXT,
  lnget_compatible INTEGER,
  domain_verified INTEGER DEFAULT 0,
  probe_status TEXT DEFAULT 'probeable'
)`

function makeDb() {
  const db = Database(':memory:')
  db.exec(CREATE_TABLE)
  withQuarantineSchema(db)
  return db
}

function insert(db, fields) {
  const defaults = {
    name: 'Test Service',
    url: 'https://example.com',
    protocol: 'x402',
    status: 'active',
    provider_deleted: 0,
    health_status: 'unknown',
    domain_verified: 0,
    x402_payment_valid: 0,
    category: 'uncategorized',
    featured: 0,
  }
  const row = { ...defaults, ...fields }
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO services (${keys.join(', ')}) VALUES (${keys.map(k => '@' + k).join(', ')})`
  ).run(row)
}

describe('domain_verified column exposure', () => {
  it('API_COLUMNS includes domain_verified', () => {
    assert.ok(
      API_COLUMNS.includes('domain_verified'),
      'API_COLUMNS should include domain_verified'
    )
  })

  it('PAGE_COLUMNS includes domain_verified', () => {
    assert.ok(
      PAGE_COLUMNS.includes('domain_verified'),
      'PAGE_COLUMNS should include domain_verified'
    )
  })

  it('queryServices with API_COLUMNS returns domain_verified field on each row', () => {
    const db = makeDb()
    insert(db, { name: 'Verified', domain_verified: 1, url: 'https://a.com', protocol: 'x402' })
    const { services } = queryServices(db, {}, API_COLUMNS)
    assert.equal(services.length, 1)
    assert.ok('domain_verified' in services[0], 'row should have domain_verified field')
  })

  it('queryServices with PAGE_COLUMNS returns domain_verified field on each row', () => {
    const db = makeDb()
    insert(db, { name: 'Verified', domain_verified: 1, url: 'https://b.com', protocol: 'x402' })
    const { services } = queryServices(db, {}, PAGE_COLUMNS)
    assert.equal(services.length, 1)
    assert.ok('domain_verified' in services[0], 'row should have domain_verified field')
  })
})

describe('verified filter', () => {
  it('buildServiceQuery({ verified: "true" }) includes x402_payment_valid condition', () => {
    const result = buildServiceQuery({ verified: 'true' })
    assert.ok(
      result.where.includes('x402_payment_valid'),
      'WHERE clause should include x402_payment_valid for verified filter'
    )
  })

  it('buildServiceQuery({ verified: "true" }) includes health_status condition for L402', () => {
    const result = buildServiceQuery({ verified: 'true' })
    assert.ok(
      result.where.includes("protocol = 'L402'"),
      'WHERE clause should include L402 health_status condition'
    )
  })

  it('buildServiceQuery({ verified: "true" }) includes health_status condition for MPP', () => {
    const result = buildServiceQuery({ verified: 'true' })
    assert.ok(
      result.where.includes("protocol = 'MPP'"),
      'WHERE clause should include MPP health_status condition'
    )
  })

  it('verified=true returns x402 service with x402_payment_valid=1', () => {
    const db = makeDb()
    insert(db, { name: 'Valid x402', url: 'https://valid.com', protocol: 'x402', x402_payment_valid: 1 })
    insert(db, { name: 'Invalid x402', url: 'https://invalid.com', protocol: 'x402', x402_payment_valid: 0 })
    const { services } = queryServices(db, { verified: 'true' })
    const names = services.map(s => s.name)
    assert.ok(names.includes('Valid x402'), 'should include x402 with payment_valid=1')
    assert.ok(!names.includes('Invalid x402'), 'should exclude x402 with payment_valid=0')
  })

  it('verified=true returns L402 service with health_status=healthy', () => {
    const db = makeDb()
    insert(db, { name: 'Healthy L402', url: 'https://healthy.com', protocol: 'L402', health_status: 'healthy' })
    insert(db, { name: 'Degraded L402', url: 'https://degraded.com', protocol: 'L402', health_status: 'degraded' })
    const { services } = queryServices(db, { verified: 'true' })
    const names = services.map(s => s.name)
    assert.ok(names.includes('Healthy L402'), 'should include L402 with health_status=healthy')
    assert.ok(!names.includes('Degraded L402'), 'should exclude L402 with health_status=degraded')
  })

  it('verified=true returns MPP service with health_status=healthy', () => {
    const db = makeDb()
    insert(db, { name: 'Healthy MPP', url: 'https://hmpp.com', protocol: 'MPP', health_status: 'healthy' })
    insert(db, { name: 'Down MPP', url: 'https://dmpp.com', protocol: 'MPP', health_status: 'down' })
    const { services } = queryServices(db, { verified: 'true' })
    const names = services.map(s => s.name)
    assert.ok(names.includes('Healthy MPP'), 'should include MPP with health_status=healthy')
    assert.ok(!names.includes('Down MPP'), 'should exclude MPP with health_status=down')
  })

  it('query without verified param returns all active services (backward compat)', () => {
    const db = makeDb()
    insert(db, { name: 'A', url: 'https://a.com', protocol: 'x402', x402_payment_valid: 0 })
    insert(db, { name: 'B', url: 'https://b.com', protocol: 'L402', health_status: 'down' })
    insert(db, { name: 'C', url: 'https://c.com', protocol: 'MPP', health_status: 'unknown' })
    const { services } = queryServices(db, {})
    assert.equal(services.length, 3, 'no verified filter should return all 3 active services')
  })
})

describe('DEFAULT_ORDER with domain_verified', () => {
  it('domain_verified=1 services sort before domain_verified=0 when both non-featured and same health', () => {
    const db = makeDb()
    // Use names where alphabetical order would put unverified first ("A..." < "Z...")
    // so that only domain_verified boost can put the verified one first
    insert(db, { name: 'A Unverified', url: 'https://un.com', protocol: 'x402', domain_verified: 0, featured: 0, health_status: 'healthy' })
    insert(db, { name: 'Z DomainVerified', url: 'https://dv.com', protocol: 'x402', domain_verified: 1, featured: 0, health_status: 'healthy' })
    const { services } = queryServices(db, {})
    assert.equal(services[0].name, 'Z DomainVerified', 'domain_verified=1 should sort first among non-featured')
  })

  it('featured services still sort above domain_verified services', () => {
    const db = makeDb()
    // "A FeaturedOnly" would sort before "Z DomainVerified" alphabetically,
    // but featured must win regardless — swap names to ensure featured logic is tested
    insert(db, { name: 'Z DomainVerified', url: 'https://dv.com', protocol: 'x402', domain_verified: 1, featured: 0, health_status: 'healthy' })
    insert(db, { name: 'A FeaturedOnly', url: 'https://feat.com', protocol: 'x402', domain_verified: 0, featured: 1, health_status: 'healthy' })
    const { services } = queryServices(db, {})
    assert.equal(services[0].name, 'A FeaturedOnly', 'featured should still sort above domain_verified')
  })
})
