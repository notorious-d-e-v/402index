// Host quarantine (2026-10-27): a host that stops answering with a paywall leaves every
// count and list, keeps its /service/:id page, and comes back after it answers again.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateQuarantine, ENTER, EXIT } from '../src/health/quarantine.js'
import { ensureQuarantineSchema } from '../src/services/visibility.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function unitDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE services (id TEXT PRIMARY KEY, url TEXT, hostname TEXT, http_method TEXT, probe_body TEXT,
    status TEXT DEFAULT 'active', provider_deleted INTEGER DEFAULT 0, health_status TEXT DEFAULT 'unknown')`)
  ensureQuarantineSchema(db)
  return db
}
const addRows = (db, host, n, health = 'down') => {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO services (id, url, hostname, health_status) VALUES (?, ?, ?, ?)').run(`${host}-${i}`, `https://${host}/x402/${i}`, host, health)
}
const state = (db, host) => db.prepare('SELECT state, fail_streak, pass_streak FROM quarantined_hosts WHERE hostname = ?').get(host)
const always = status => async () => status

describe('evaluateQuarantine state machine', () => {
  let db
  beforeEach(() => { db = unitDb() })

  it(`a host whose apex and sampled rows answer 530 is quarantined on the ${ENTER}rd failing run, not before`, async () => {
    addRows(db, 'dead.example', 8)
    for (let run = 1; run < ENTER; run++) {
      await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(530) })
      assert.equal(state(db, 'dead.example').state, 'watch', `run ${run} must only watch`)
    }
    const r = await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(530) })
    assert.deepEqual(r.entered, ['dead.example'])
    assert.equal(state(db, 'dead.example').state, 'quarantined')
  })

  it('network errors count as failures; one 402 in the probe set keeps a watched host out', async () => {
    addRows(db, 'flaky.example', 6)
    await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(null) })
    assert.equal(state(db, 'flaky.example').fail_streak, 1)
    let n = 0
    await evaluateQuarantine(db, { minGapMinutes: 0, probe: async () => (n++ === 3 ? 402 : 530) })
    assert.equal(state(db, 'flaky.example'), undefined, 'a watched host that answers 402 is dropped')
  })

  it(`a quarantined host is released only after ${EXIT} consecutive runs with a 402`, async () => {
    addRows(db, 'back.example', 6)
    db.prepare("INSERT INTO quarantined_hosts (hostname, state, fail_streak, seeded) VALUES ('back.example', 'quarantined', 3, 1)").run()
    await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(402) })
    await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(402) })
    assert.equal(state(db, 'back.example').pass_streak, 2)
    await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(530) })
    assert.equal(state(db, 'back.example').pass_streak, 0, 'a failing run resets the streak')
    for (let i = 0; i < EXIT - 1; i++) await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(402) })
    assert.equal(state(db, 'back.example').state, 'quarantined')
    // Since 2026-10-28 the streak must also span 24 h (test/quarantine-hysteresis.test.js).
    db.prepare("UPDATE quarantined_hosts SET first_pass_at = datetime('now', '-25 hours')").run()
    const r = await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(402) })
    assert.deepEqual(r.released, ['back.example'])
    assert.equal(state(db, 'back.example').state, 'released', 'kept as released for flap detection')
  })

  it('hosts with any healthy row, or too few down rows, are not candidates', async () => {
    addRows(db, 'mixed.example', 6)
    db.prepare("UPDATE services SET health_status = 'healthy' WHERE id = 'mixed.example-0'").run()
    addRows(db, 'tiny.example', 2)
    const r = await evaluateQuarantine(db, { minGapMinutes: 0, probe: always(530) })
    assert.equal(r.evaluated, 0)
  })
})

describe('quarantined rows leave counts and lists but keep their page', () => {
  let BASE, db, stopServer, sweepCandidates
  const HOST = 'quarantine-it.example.test'
  const DIGEST = { Authorization: `Bearer ${process.env.DIGEST_API_KEY || 'test-digest-key'}` }

  before(async () => {
    const srv = await import('./helpers/server.js')
    stopServer = srv.stopServer
    BASE = await srv.startServer()
    db = (await import('../src/db.js')).default
    sweepCandidates = (await import('../src/health/checker.js')).sweepCandidates
  })
  after(async () => {
    db.prepare('DELETE FROM quarantined_hosts WHERE hostname = ?').run(HOST)
    db.prepare('DELETE FROM services WHERE hostname = ?').run(HOST)
    await stopServer()
  })

  const seed = () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT OR REPLACE INTO services (id, name, description, url, protocol, source, status, hostname, health_status)
        VALUES (?, ?, 'quarantine probe row', ?, 'x402', 'bazaar', 'active', ?, 'healthy')`).run(`qit-${i}`, `QuarantineIT ${i}`, `https://${HOST}/x402/${i}`, HOST)
    }
  }
  const quarantine = () => db.prepare("INSERT OR REPLACE INTO quarantined_hosts (hostname, state, fail_streak, seeded, reason) VALUES (?, 'quarantined', 3, 1, 'test')").run(HOST)
  const health = async () => (await fetch(`${BASE}/api/v1/health`)).json()

  it('drops the rows from every count, list and feed, and exposes the excluded count', async () => {
    seed()
    const before = await health()
    const digestBefore = await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()
    quarantine()
    const after = await health()
    assert.equal(after.total_endpoints, before.total_endpoints - 3)
    assert.equal(after.excluded_quarantined, (before.excluded_quarantined ?? 0) + 3)
    assert.equal(after.by_source.bazaar ?? 0, (before.by_source.bazaar ?? 0) - 3)

    const digestAfter = await (await fetch(`${BASE}/api/v1/digest`, { headers: DIGEST })).json()
    assert.equal(digestAfter.totals.endpoints, digestBefore.totals.endpoints - 3)

    const list = await (await fetch(`${BASE}/api/v1/services?q=QuarantineIT`)).json()
    assert.equal(list.services.filter(s => s.url.includes(HOST)).length, 0, 'default list hides quarantined rows')
    const opted = await (await fetch(`${BASE}/api/v1/services?q=QuarantineIT&quarantined=true`)).json()
    assert.equal(opted.services.filter(s => s.url.includes(HOST)).length, 3, 'quarantined=true brings them back')

    const llms = await (await fetch(`${BASE}/llms.txt`)).text()
    assert.match(llms, new RegExp(String(after.total_endpoints).replace(/\B(?=(\d{3})+(?!\d))/g, '[,]?')), 'llms.txt total matches /health')
    const feed = await (await fetch(`${BASE}/feed.xml`)).text()
    assert.ok(!feed.includes(HOST), 'feed.xml must not list quarantined rows')

    assert.equal(sweepCandidates().filter(s => s.url.includes(HOST)).length, 0, 'the sweep skips quarantined rows')
  })

  it('keeps /service/:id reachable with a quarantine banner', async () => {
    seed(); quarantine()
    const res = await fetch(`${BASE}/service/qit-0`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /quarantined/i)
  })
})

describe('QUARANTINE_ENABLED=false', () => {
  it('restores the pre-quarantine filter without touching the schema', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const v = await import('./src/services/visibility.js')
      console.log(JSON.stringify({ enabled: v.QUARANTINE_ENABLED, listed: v.LISTED === v.ACTIVE + ' AND 1' }))
    `], { cwd: ROOT, env: { ...process.env, QUARANTINE_ENABLED: 'false' } }).toString()
    assert.deepEqual(JSON.parse(out.trim()), { enabled: false, listed: true })
  })
})

describe('evaluateQuarantine runs hosts concurrently', () => {
  it('40 tracked hosts with 100 ms probes finish well under the 40 × 6 × 100 ms a serial pass would take', async () => {
    const db = unitDb()
    for (let i = 0; i < 40; i++) addRows(db, `slow${i}.example`, 5)
    const slow = async () => { await new Promise(r => setTimeout(r, 100)); return 530 }
    const t = Date.now()
    const r = await evaluateQuarantine(db, { minGapMinutes: 0, probe: slow })
    const ms = Date.now() - t
    assert.equal(r.evaluated, 40)
    assert.ok(ms < 6000, `took ${ms} ms; a serial pass is ~24 s`)
  })
})

describe('evaluateQuarantine counts at most one run per host per 45 minutes', () => {
  it('back-to-back runs (e.g. three deploys in 25 minutes) advance a host once', async () => {
    const db = unitDb()
    addRows(db, 'redeploy.example', 6)
    await evaluateQuarantine(db, { probe: always(530) })
    await evaluateQuarantine(db, { probe: always(530) })
    await evaluateQuarantine(db, { probe: always(530) })
    assert.equal(state(db, 'redeploy.example').state, 'watch')
    assert.equal(state(db, 'redeploy.example').fail_streak, 1)
    db.prepare("UPDATE quarantined_hosts SET last_probe_at = datetime('now', '-50 minutes')").run()
    await evaluateQuarantine(db, { probe: always(530) })
    assert.equal(state(db, 'redeploy.example').fail_streak, 2)
  })
})
