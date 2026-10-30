import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { captureSnapshot } from '../src/services/daily-snapshot.js'
import { withQuarantineSchema } from './helpers/test-db.js'

describe('daily-snapshot respects soft-deleted services', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE services (
        id INTEGER PRIMARY KEY,
        url TEXT,
        name TEXT,
        protocol TEXT DEFAULT 'L402',
        category TEXT DEFAULT 'AI',
        status TEXT DEFAULT 'active',
        health_status TEXT DEFAULT 'healthy',
        x402_payment_valid INTEGER DEFAULT 0,
        provider_deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        source TEXT DEFAULT 'test',
        self_registered INTEGER DEFAULT 0,
        domain_verified INTEGER DEFAULT 0,
        is_template INTEGER DEFAULT 0,
        is_demo INTEGER DEFAULT 0,
        reliability_score REAL,
        latency_p50_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE daily_snapshots (
        snapshot_date TEXT PRIMARY KEY,
        total_endpoints INTEGER,
        verified_endpoints INTEGER,
        total_providers INTEGER DEFAULT 0,
        verified_providers INTEGER DEFAULT 0,
        healthy_endpoints INTEGER DEFAULT 0,
        degraded_endpoints INTEGER DEFAULT 0,
        down_endpoints INTEGER DEFAULT 0,
        l402_endpoints INTEGER DEFAULT 0,
        l402_verified INTEGER DEFAULT 0,
        l402_healthy INTEGER DEFAULT 0,
        l402_providers INTEGER DEFAULT 0,
        x402_endpoints INTEGER DEFAULT 0,
        x402_verified INTEGER DEFAULT 0,
        x402_healthy INTEGER DEFAULT 0,
        x402_providers INTEGER DEFAULT 0,
        mpp_endpoints INTEGER DEFAULT 0,
        mpp_verified INTEGER DEFAULT 0,
        mpp_healthy INTEGER DEFAULT 0,
        mpp_providers INTEGER DEFAULT 0,
        avg_reliability_score REAL,
        median_latency_ms INTEGER,
        p90_latency_ms INTEGER,
        categories_json TEXT,
        top_providers_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `)
    withQuarantineSchema(db)

    const ins = db.prepare(`INSERT INTO services (url, name, protocol, health_status, status) VALUES (?, ?, ?, ?, 'active')`)
    ins.run('https://a.com/api', 'Service A', 'L402', 'healthy')
    ins.run('https://b.com/api', 'Service B', 'x402', 'healthy')
    ins.run('https://c.com/api', 'Service C', 'L402', 'down')

    // Soft-delete Service B
    db.prepare(`UPDATE services SET provider_deleted = 1, deleted_at = datetime('now') WHERE url = 'https://b.com/api'`).run()
  })

  after(() => db.close())

  it('should not count soft-deleted services in total_endpoints', () => {
    const snap = captureSnapshot(db)
    assert.equal(snap.total_endpoints, 2, 'soft-deleted service should be excluded from total')
  })

  it('should not count soft-deleted services in protocol stats', () => {
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)
    assert.equal(row.x402_endpoints, 0, 'soft-deleted x402 service should be excluded')
    assert.equal(row.l402_endpoints, 2)
  })

  it('should not count soft-deleted services in health breakdown', () => {
    captureSnapshot(db)
    const today = new Date().toISOString().slice(0, 10)
    const row = db.prepare('SELECT * FROM daily_snapshots WHERE snapshot_date = ?').get(today)
    assert.equal(row.healthy_endpoints, 1, 'only Service A should be healthy')
    assert.equal(row.down_endpoints, 1, 'only Service C should be down')
  })
})
