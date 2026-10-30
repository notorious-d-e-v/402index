// Digest quarantine and bazaar blocks (2026-10-28): the daily digest reads what quarantine
// excluded and how fresh the Bazaar poll is without a second call to /api/v1/health.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

const DIGEST = { Authorization: `Bearer ${process.env.DIGEST_API_KEY || 'test-digest-key'}` }
let BASE, db, stopServer
const digest = async () => (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()

before(async () => {
  const srv = await import('./helpers/server.js')
  stopServer = srv.stopServer
  BASE = await srv.startServer()
  db = (await import('../src/db.js')).default
})
after(async () => {
  db.prepare("DELETE FROM services WHERE id LIKE 'dblk-%'").run()
  db.prepare("DELETE FROM quarantined_hosts WHERE hostname LIKE 'dblk-%'").run()
  db.prepare("DELETE FROM quarantine_events WHERE hostname LIKE 'dblk-%'").run()
  await stopServer()
})

describe('digest.quarantine', () => {
  it('counts quarantined and held hosts, rows excluded, and the last 24 h of state changes with direction', async () => {
    const add = db.prepare("INSERT INTO services (id, name, url, protocol, source, status, hostname) VALUES (?, ?, ?, 'x402', 'bazaar', 'active', ?)")
    for (const h of ['dblk-q.example', 'dblk-h.example']) for (let i = 0; i < 2; i++) add.run(`dblk-${h}-${i}`, h, `https://${h}/${i}`, h)
    db.prepare("INSERT INTO quarantined_hosts (hostname, state) VALUES ('dblk-q.example', 'quarantined'), ('dblk-h.example', 'held')").run()
    db.prepare("INSERT INTO quarantine_events (hostname, from_state, to_state, active_rows) VALUES ('dblk-q.example', 'watch', 'quarantined', 2), ('dblk-r.example', 'quarantined', 'released', 9)").run()
    const q = (await digest()).quarantine
    assert.ok(q, 'digest has a quarantine block')
    assert.ok(q.hosts_quarantined >= 1)
    assert.ok(q.hosts_held >= 1)
    assert.ok(q.rows_excluded >= 4)
    const mine = q.changes_24h.filter(c => c.hostname.startsWith('dblk-'))
    assert.deepEqual(mine.map(c => [c.hostname, c.direction, c.active_rows]), [['dblk-q.example', 'excluded', 2], ['dblk-r.example', 'restored', 9]])
    const health = await (await fetch(`${BASE}/api/v1/health`)).json()
    assert.equal(q.rows_excluded, health.excluded_quarantined, 'held rows are excluded in /health too')
  })
})

describe('digest.bazaar', () => {
  it('carries upstream_total, upstream_missing and last_page_processed_at', async () => {
    db.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('bazaar_offset', '4200', '2026-10-28 12:00:00')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run()
    const b = (await digest()).bazaar
    assert.ok(b, 'digest has a bazaar block')
    assert.ok('upstream_total' in b && 'upstream_missing' in b)
    assert.equal(b.last_page_processed_at, '2026-10-28 12:00:00')
    assert.equal(b.offset, 4200)
  })
})
