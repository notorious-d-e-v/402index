// Health sweep budget (2026-10-27). After quarantine, 140,058 rows remained, ~58k of them on
// watched dead hosts. Batches of 10 wait for their slowest member (a dead row costs ~10 s), so
// the sweep ran at ~1 check/s: ~39 h per pass on an hourly schedule. The interval stays hourly;
// instead each sweep has a time budget, works in priority order, and logs what it skipped.

import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { orderForSweep, runHealthChecks } from '../src/health/checker.js'

describe('orderForSweep', () => {
  it('self-registered and domain-verified rows first, then oldest last_checked (never-checked first)', () => {
    const rows = [
      { id: 'a', source: 'bazaar', domain_verified: 0, last_checked: '2026-10-27 10:00:00', hostname: 'h1' },
      { id: 'b', source: 'bazaar', domain_verified: 0, last_checked: null, hostname: 'h2' },
      { id: 'c', source: 'self-registered', domain_verified: 0, last_checked: '2026-10-27 12:00:00', hostname: 'h3' },
      { id: 'd', source: 'bazaar', domain_verified: 1, last_checked: '2026-10-27 11:00:00', hostname: 'h4' },
      { id: 'e', source: 'bazaar', domain_verified: 0, last_checked: '2026-10-26 09:00:00', hostname: 'h5' },
    ]
    assert.deepEqual(orderForSweep(rows).map(r => r.id), ['d', 'c', 'b', 'e', 'a'])
  })

  it('spreads one host across the order so workers do not queue on its per-host delay', () => {
    const rows = []
    for (let i = 0; i < 6; i++) rows.push({ id: `big${i}`, source: 'bazaar', domain_verified: 0, last_checked: `2026-10-26 0${i}:00:00`, hostname: 'big' })
    rows.push({ id: 'x', source: 'bazaar', domain_verified: 0, last_checked: '2026-10-26 07:00:00', hostname: 'x' })
    rows.push({ id: 'y', source: 'bazaar', domain_verified: 0, last_checked: '2026-10-26 08:00:00', hostname: 'y' })
    const order = orderForSweep(rows).map(r => r.id)
    assert.notEqual(order[1].slice(0, 3), 'big', `two big-host rows back to back at the head: ${order}`)
    assert.equal(order.length, 8)
  })
})

describe('runHealthChecks budget', () => {
  before(() => {
    const ins = db.prepare("INSERT INTO services (id, name, url, protocol, source, status, hostname) VALUES (?, ?, ?, 'x402', 'bazaar', 'active', ?)")
    for (let i = 0; i < 60; i++) ins.run(`budget-${i}`, `Budget ${i}`, `https://budget${i}.example.test/x`, `budget${i}.example.test`)
  })
  after(() => db.prepare("DELETE FROM services WHERE id LIKE 'budget-%'").run())

  it('stops starting checks when the budget runs out, logs what it skipped, and records it', async () => {
    const lines = []
    const log = mock.method(console, 'log', (...a) => lines.push(a.join(' ')))
    let started = 0
    try {
      await runHealthChecks({
        checkDisk: async () => 'continue',
        evaluate: async () => {},
        budgetMs: 150,
        concurrency: 4,
        check: async (s) => { started++; await new Promise(r => setTimeout(r, 50)); return { id: s.id, healthStatus: 'healthy', httpStatus: 402 } },
      })
    } finally {
      log.mock.restore()
    }
    assert.ok(started < 60 && started >= 4, `started ${started} of 60`)
    const skip = lines.find(l => l.startsWith('[health] Budget'))
    assert.ok(skip, `no budget line in: ${lines.filter(l => l.startsWith('[health]')).join(' | ')}`)
    assert.match(skip, new RegExp(`skipped ${60 - started}\\b`))
    const e = db.prepare("SELECT detail FROM scheduler_events WHERE job = 'health' AND event = 'completed' ORDER BY id DESC LIMIT 1").get()
    assert.equal(JSON.parse(e.detail).skipped_budget, 60 - started)
  })
})
