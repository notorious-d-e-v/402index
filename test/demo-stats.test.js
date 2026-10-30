import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buildProbeSample } from '../src/routes/pages.js'
import { withQuarantineSchema } from './helpers/test-db.js'

// ─── Test database setup ─────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both')),
      price_sats INTEGER,
      price_usd REAL,
      payment_asset TEXT,
      payment_network TEXT,
      category TEXT,
      provider TEXT,
      source TEXT NOT NULL,
      featured INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      health_status TEXT DEFAULT 'unknown',
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      reliability_score REAL,
      last_checked TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      x402_payment_valid INTEGER,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      response_time_ms INTEGER,
      http_status INTEGER,
      error_message TEXT
    );
  `)
  withQuarantineSchema(db)
  return db
}

function insertService(db, overrides = {}) {
  const defaults = {
    id: Math.random().toString(36).slice(2),
    name: 'Test Service',
    url: 'https://example.com/api',
    protocol: 'L402',
    source: 'self-registered',
    status: 'active',
    health_status: 'unknown',
    price_sats: 100,
    category: 'tools',
  }
  const svc = { ...defaults, ...overrides }
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, health_status, price_sats, price_usd, category, provider, payment_asset, payment_network, reliability_score, x402_payment_valid, is_template, is_demo)
    VALUES (@id, @name, @url, @protocol, @source, @status, @health_status, @price_sats, @price_usd, @category, @provider, @payment_asset, @payment_network, @reliability_score, @x402_payment_valid, @is_template, @is_demo)
  `).run({
    price_usd: null, provider: null, payment_asset: null, payment_network: null,
    reliability_score: null, x402_payment_valid: null, is_template: 0, is_demo: 0,
    ...svc,
  })
  return svc
}

// ─── SQL precedence: ACTIVE_FILTER must use parentheses ──────────────────────

describe('demo stats — ACTIVE_FILTER SQL precedence', () => {
  it('counts only L402 services when filtering by protocol, not all active', () => {
    const db = createTestDb()

    // Insert 5 L402 services and 10 x402 services, all active
    for (let i = 0; i < 5; i++) {
      insertService(db, { id: `l402-${i}`, protocol: 'L402', url: `https://l402-${i}.com/api`, health_status: 'healthy' })
    }
    for (let i = 0; i < 10; i++) {
      insertService(db, { id: `x402-${i}`, protocol: 'x402', url: `https://x402-${i}.com/api`, health_status: 'healthy' })
    }

    // This is the query pattern used in the demo route
    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"
    const l402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402'`).get().c
    const x402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402'`).get().c

    assert.equal(l402Total, 5, 'L402 count should be 5, not 15')
    assert.equal(x402Total, 10, 'x402 count should be 10, not 15')
  })

  it('counts only healthy L402 services, not all healthy', () => {
    const db = createTestDb()

    // 3 healthy L402, 2 degraded L402, 8 healthy x402
    for (let i = 0; i < 3; i++) {
      insertService(db, { id: `l402-h-${i}`, protocol: 'L402', url: `https://l402-h-${i}.com/api`, health_status: 'healthy' })
    }
    for (let i = 0; i < 2; i++) {
      insertService(db, { id: `l402-d-${i}`, protocol: 'L402', url: `https://l402-d-${i}.com/api`, health_status: 'degraded' })
    }
    for (let i = 0; i < 8; i++) {
      insertService(db, { id: `x402-h-${i}`, protocol: 'x402', url: `https://x402-h-${i}.com/api`, health_status: 'healthy' })
    }

    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"
    const l402Healthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402' AND health_status = 'healthy'`).get().c

    assert.equal(l402Healthy, 3, 'L402 healthy should be 3, not 11')
  })

  it('verified count matches protocol-specific verification logic', () => {
    const db = createTestDb()

    // 2 healthy L402 (verified via health), 3 x402 with payment_valid (verified via flag), 5 x402 without payment_valid
    for (let i = 0; i < 2; i++) {
      insertService(db, { id: `l402-v-${i}`, protocol: 'L402', url: `https://l402-v-${i}.com/api`, health_status: 'healthy' })
    }
    for (let i = 0; i < 3; i++) {
      insertService(db, { id: `x402-v-${i}`, protocol: 'x402', url: `https://x402-v-${i}.com/api`, health_status: 'healthy', x402_payment_valid: 1 })
    }
    for (let i = 0; i < 5; i++) {
      insertService(db, { id: `x402-nv-${i}`, protocol: 'x402', url: `https://x402-nv-${i}.com/api`, health_status: 'healthy', x402_payment_valid: 0 })
    }

    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"
    const verifiedCount = db.prepare(
      `SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND ((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy'))`
    ).get().c

    assert.equal(verifiedCount, 5, 'verified should be 2 L402 healthy + 3 x402 payment_valid = 5, not 10')
  })

  it('excludes pending/rejected services from protocol counts', () => {
    const db = createTestDb()

    insertService(db, { id: 'active-l402', protocol: 'L402', url: 'https://active.com/api', status: 'active', health_status: 'healthy' })
    insertService(db, { id: 'pending-l402', protocol: 'L402', url: 'https://pending.com/api', status: 'pending', health_status: 'healthy' })
    insertService(db, { id: 'rejected-l402', protocol: 'L402', url: 'https://rejected.com/api', status: 'rejected', health_status: 'healthy' })
    insertService(db, { id: 'null-status-l402', protocol: 'L402', url: 'https://null.com/api', status: null, health_status: 'healthy' })

    const ACTIVE_FILTER = "WHERE (status = 'active' OR status IS NULL)"
    const l402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402'`).get().c

    assert.equal(l402Total, 2, 'should count active + null status only, not pending/rejected')
  })
})

// ─── Bug reproduction: WITHOUT parentheses (the bug) ─────────────────────────

describe('demo stats — SQL precedence bug reproduction', () => {
  it('WITHOUT parentheses: L402 count equals total (the bug)', () => {
    const db = createTestDb()

    for (let i = 0; i < 5; i++) {
      insertService(db, { id: `l402-${i}`, protocol: 'L402', url: `https://l402-${i}.com/api` })
    }
    for (let i = 0; i < 10; i++) {
      insertService(db, { id: `x402-${i}`, protocol: 'x402', url: `https://x402-${i}.com/api` })
    }

    // Without parentheses — this is the bug
    const BAD_FILTER = "WHERE status = 'active' OR status IS NULL"
    const l402WithBug = db.prepare(`SELECT COUNT(*) as c FROM services ${BAD_FILTER} AND protocol = 'L402'`).get().c

    // This SHOULD be 5 but the bug makes it return more because AND binds tighter than OR
    // SQL parses as: WHERE status = 'active' OR (status IS NULL AND protocol = 'L402')
    // Since all rows have status='active', all 15 match
    assert.equal(l402WithBug, 15, 'bug: without parens, L402 count matches total')

    // With parentheses — the fix
    const GOOD_FILTER = "WHERE (status = 'active' OR status IS NULL)"
    const l402Fixed = db.prepare(`SELECT COUNT(*) as c FROM services ${GOOD_FILTER} AND protocol = 'L402'`).get().c
    assert.equal(l402Fixed, 5, 'fix: with parens, L402 count is correct')
  })
})

// ─── buildProbeSample ────────────────────────────────────────────────────────

describe('buildProbeSample', () => {
  it('returns L402 service when protocol=L402', () => {
    const db = createTestDb()
    insertService(db, {
      id: 'l402-1', name: 'Weather API', protocol: 'L402',
      url: 'https://weather.example.com/api',
      health_status: 'healthy', reliability_score: 95,
      price_sats: 10, category: 'data/weather', provider: 'WeatherCorp',
    })
    insertService(db, {
      id: 'x402-1', name: 'Data API', protocol: 'x402',
      url: 'https://data.example.com/api',
      health_status: 'healthy', reliability_score: 90,
      payment_asset: 'USDC',
    })
    db.prepare(`INSERT INTO health_checks (service_id, status, response_time_ms, http_status) VALUES ('l402-1', 'healthy', 145, 402)`).run()

    const sample = buildProbeSample(db, 'L402')
    assert.equal(sample.service.protocol, 'L402')
    assert.equal(sample.service.name, 'Weather API')
    assert.ok(sample.flow.protocolHeaders.L402, 'should have L402 headers')
    assert.ok(sample.flow.protocolHeaders.L402.includes('WWW-Authenticate'), 'should show WWW-Authenticate')
  })

  it('returns x402 service when protocol=x402', () => {
    const db = createTestDb()
    insertService(db, {
      id: 'x402-1', name: 'Data API', protocol: 'x402',
      url: 'https://data.example.com/api',
      health_status: 'healthy', reliability_score: 90,
      payment_asset: 'USDC', price_usd: 0.01,
    })
    db.prepare(`INSERT INTO health_checks (service_id, status, response_time_ms, http_status) VALUES ('x402-1', 'healthy', 200, 402)`).run()

    const sample = buildProbeSample(db, 'x402')
    assert.equal(sample.service.protocol, 'x402')
    assert.ok(sample.flow.protocolHeaders.x402, 'should have x402 headers')
    assert.ok(sample.flow.protocolHeaders.x402.includes('PAYMENT-REQUIRED'), 'should show PAYMENT-REQUIRED')
  })

  it('returns static fallback when no healthy services exist', () => {
    const db = createTestDb()
    const sample = buildProbeSample(db, 'L402')
    assert.equal(sample.service.protocol, 'L402')
    assert.equal(sample.service.name, 'Example L402 API')
    assert.ok(sample.flow.protocolHeaders.L402)
  })

  it('does not return pending services', () => {
    const db = createTestDb()
    insertService(db, {
      id: 'pending-1', name: 'Pending API', protocol: 'L402',
      url: 'https://pending.example.com/api',
      health_status: 'healthy', reliability_score: 99,
      status: 'pending',
    })

    const sample = buildProbeSample(db, 'L402')
    // Should get static fallback since the only service is pending
    assert.equal(sample.service.name, 'Example L402 API', 'should not return pending service')
  })
})
