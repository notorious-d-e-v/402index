import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { findOpportunities } from '../src/services/opportunities.js'
import { withQuarantineSchema } from './helpers/test-db.js'

describe('opportunities respects soft-deleted services', () => {
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
        source TEXT DEFAULT 'test'
      );
    `)
    withQuarantineSchema(db)

    // 4 services in AI — before soft-delete: total=4, healthy=2, l402=2, x402=2
    const ins = db.prepare(`INSERT INTO services (url, name, protocol, category, health_status, status) VALUES (?, ?, ?, 'AI', ?, 'active')`)
    ins.run('https://a.com/api', 'A', 'L402', 'healthy')
    ins.run('https://b.com/api', 'B', 'L402', 'down')
    ins.run('https://c.com/api', 'C', 'x402', 'down')
    ins.run('https://d.com/api', 'D', 'x402', 'healthy')

    // Soft-delete both x402 services
    db.prepare(`UPDATE services SET provider_deleted = 1, deleted_at = datetime('now') WHERE url IN ('https://c.com/api', 'https://d.com/api')`).run()
  })

  after(() => db.close())

  it('should not include soft-deleted services in category gap counts', () => {
    const opps = findOpportunities(db)
    // After soft-delete: only 2 active services remain (total < 3)
    // AI should NOT appear as a gap (HAVING total >= 3 fails)
    const aiGap = opps.find(o => o.type === 'gap' && o.category === 'AI')
    assert.equal(aiGap, undefined, 'AI category should not appear as gap — only 2 active services remain')
  })

  it('should not include soft-deleted services in protocol coverage', () => {
    const opps = findOpportunities(db)
    // After soft-delete: only A (L402) and B (L402) remain — zero x402
    // Should flag protocol_gap with missing x402
    const protocolGap = opps.find(o => o.type === 'protocol_gap' && o.category === 'AI')
    assert.ok(protocolGap, 'should flag AI as missing x402 protocol (both x402 services are soft-deleted)')
    assert.equal(protocolGap.protocol_coverage.x402, 0, 'x402 count should be 0 after soft-delete')
  })
})
