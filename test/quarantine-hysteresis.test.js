// Quarantine hysteresis (2026-10-28). market.datapackvibe.com (77k rows) entered quarantine at
// 19:50Z on 10-27 and left at 22:09Z after three passing runs; the public total went 71.9k → 149k.
// Exit now needs both a run count and elapsed time, large hosts need more of each, and a host that
// re-enters within 30 days of leaving is held until an operator releases it.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateQuarantine, ENTER, EXIT, EXIT_HOURS, LARGE_HOST_ROWS, LARGE_EXIT, LARGE_EXIT_HOURS } from '../src/health/quarantine.js'
import { ensureQuarantineSchema, countQuarantined, quarantineSummary } from '../src/services/visibility.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function unitDb(file = ':memory:') {
  const db = new Database(file)
  db.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, url TEXT, hostname TEXT, http_method TEXT, probe_body TEXT,
    status TEXT DEFAULT 'active', provider_deleted INTEGER DEFAULT 0, health_status TEXT DEFAULT 'unknown')`)
  ensureQuarantineSchema(db)
  return db
}
const addRows = (db, host, n, health = 'down') => {
  const ins = db.prepare('INSERT INTO services (id, url, hostname, health_status) VALUES (?, ?, ?, ?)')
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(`${host}-${i}`, `https://${host}/x402/${i}`, host, health) })()
}
const row = (db, host) => db.prepare('SELECT * FROM quarantined_hosts WHERE hostname = ?').get(host)
const always = status => async () => status
const run = (db, status) => evaluateQuarantine(db, { minGapMinutes: 0, probe: always(status) })
const quarantine = (db, host) => db.prepare("INSERT INTO quarantined_hosts (hostname, state, fail_streak, entered_at) VALUES (?, 'quarantined', 3, datetime('now', '-5 days'))").run(host)
// Moves the current pass streak's start back, as if the passing runs had been spread over time.
const firstPassHoursAgo = (db, host, h) => db.prepare(`UPDATE quarantined_hosts SET first_pass_at = datetime('now', '-${h} hours') WHERE hostname = ?`).run(host)

describe('entry is unchanged', () => {
  it(`a never-quarantined host enters on the ${ENTER}rd failing run as quarantined, with flap_count 0`, async () => {
    const db = unitDb()
    addRows(db, 'dead.example', 8)
    for (let i = 1; i < ENTER; i++) { await run(db, 530); assert.equal(row(db, 'dead.example').state, 'watch') }
    await run(db, 530)
    assert.equal(row(db, 'dead.example').state, 'quarantined')
    assert.equal(row(db, 'dead.example').flap_count, 0)
  })
})

describe('exit needs passing runs AND elapsed time', () => {
  let db
  beforeEach(() => { db = unitDb(); addRows(db, 'small.example', 10); quarantine(db, 'small.example') })

  it(`time gate: ${EXIT} passing runs inside ${EXIT_HOURS} h do not release`, async () => {
    for (let i = 0; i < EXIT + 2; i++) await run(db, 402)
    const r = row(db, 'small.example')
    assert.equal(r.state, 'quarantined')
    assert.equal(r.pass_streak, EXIT + 2)
    assert.ok(r.first_pass_at, 'first_pass_at is set on the first pass')
  })

  it(`count gate: ${EXIT - 1} passing runs spread over ${EXIT_HOURS + 1} h do not release`, async () => {
    for (let i = 0; i < EXIT - 1; i++) await run(db, 402)
    firstPassHoursAgo(db, 'small.example', EXIT_HOURS + 1)
    assert.equal(row(db, 'small.example').state, 'quarantined')
    const r = await run(db, 402) // EXIT-th pass, with the time gate met → released
    assert.deepEqual(r.released, ['small.example'])
  })

  it('a failing run resets both the streak and the clock', async () => {
    await run(db, 402)
    firstPassHoursAgo(db, 'small.example', 30)
    await run(db, 530)
    const r = row(db, 'small.example')
    assert.equal(r.pass_streak, 0)
    assert.equal(r.first_pass_at, null)
  })

  it('a released host stays in the table as released, with exited_at, and counts again', async () => {
    for (let i = 0; i < EXIT; i++) await run(db, 402)
    firstPassHoursAgo(db, 'small.example', EXIT_HOURS)
    await run(db, 402)
    const r = row(db, 'small.example')
    assert.equal(r.state, 'released')
    assert.ok(r.exited_at)
    assert.equal(countQuarantined(db), 0)
  })

  it(`hosts with > ${LARGE_HOST_ROWS} active rows need ${LARGE_EXIT} runs and ${LARGE_EXIT_HOURS} h`, async () => {
    addRows(db, 'farm.example', LARGE_HOST_ROWS + 1)
    quarantine(db, 'farm.example')
    for (let i = 0; i < LARGE_EXIT - 1; i++) await run(db, 402)
    firstPassHoursAgo(db, 'farm.example', LARGE_EXIT_HOURS + 1)
    assert.equal(row(db, 'farm.example').state, 'quarantined', `${LARGE_EXIT - 1} runs over ${LARGE_EXIT_HOURS + 1} h is not enough`)
    firstPassHoursAgo(db, 'farm.example', LARGE_EXIT_HOURS - 1)
    await run(db, 402)
    assert.equal(row(db, 'farm.example').state, 'quarantined', `${LARGE_EXIT} runs over ${LARGE_EXIT_HOURS - 1} h is not enough`)
    firstPassHoursAgo(db, 'farm.example', LARGE_EXIT_HOURS)
    await run(db, 402)
    assert.equal(row(db, 'farm.example').state, 'released')
  })
})

describe('a host that re-enters within 30 days is held', () => {
  const released = (db, host, daysAgo) => db.prepare(`INSERT INTO quarantined_hosts (hostname, state, entered_at, exited_at)
    VALUES (?, 'released', datetime('now', '-${daysAgo + 1} days'), datetime('now', '-${daysAgo} days'))`).run(host)

  it(`fails ${ENTER} runs 10 days after release → held, flap_count 1, out of counts`, async () => {
    const db = unitDb()
    addRows(db, 'flap.example', 10)
    released(db, 'flap.example', 10)
    for (let i = 0; i < ENTER; i++) await run(db, 530)
    const r = row(db, 'flap.example')
    assert.equal(r.state, 'held')
    assert.equal(r.flap_count, 1)
    assert.equal(countQuarantined(db), 10)
  })

  it('a held host is never released by passing runs, however many and however long', async () => {
    const db = unitDb()
    addRows(db, 'flap.example', 10)
    db.prepare("INSERT INTO quarantined_hosts (hostname, state, flap_count, entered_at) VALUES ('flap.example', 'held', 1, datetime('now', '-10 days'))").run()
    for (let i = 0; i < 10; i++) await run(db, 402)
    firstPassHoursAgo(db, 'flap.example', 500)
    await run(db, 402)
    assert.equal(row(db, 'flap.example').state, 'held')
    assert.equal(row(db, 'flap.example').pass_streak, 11, 'passes are still recorded for the operator')
  })

  it('re-entry more than 30 days after release is an ordinary quarantine (the exit record has been pruned)', async () => {
    const db = unitDb()
    addRows(db, 'old.example', 10)
    released(db, 'old.example', 31)
    for (let i = 0; i < ENTER; i++) await run(db, 530)
    assert.equal(row(db, 'old.example').state, 'quarantined')
    assert.equal(row(db, 'old.example').flap_count, 0)
  })

  it('a released host that answers 402 stays released and keeps its exit record', async () => {
    const db = unitDb()
    addRows(db, 'fine.example', 10)
    released(db, 'fine.example', 3)
    await run(db, 530)
    assert.equal(row(db, 'fine.example').state, 'watch')
    await run(db, 402)
    const r = row(db, 'fine.example')
    assert.equal(r.state, 'released')
    assert.ok(r.exited_at)
  })

  it('released rows older than 30 days are pruned', async () => {
    const db = unitDb()
    released(db, 'gone.example', 31)
    await run(db, 402)
    assert.equal(row(db, 'gone.example'), undefined)
  })
})

describe('state changes are recorded', () => {
  it('entry, release and hold each write a quarantine_events row; quarantineSummary reports them', async () => {
    const db = unitDb()
    addRows(db, 'ev.example', 10)
    for (let i = 0; i < ENTER; i++) await run(db, 530)
    for (let i = 0; i < EXIT; i++) await run(db, 402)
    firstPassHoursAgo(db, 'ev.example', EXIT_HOURS)
    await run(db, 402)
    db.prepare("UPDATE services SET health_status = 'down'").run()
    for (let i = 0; i < ENTER; i++) await run(db, 530)
    const ev = db.prepare('SELECT from_state, to_state, active_rows FROM quarantine_events ORDER BY id').all()
    assert.deepEqual(ev.map(e => `${e.from_state}->${e.to_state}`), ['watch->quarantined', 'quarantined->released', 'watch->held'])
    assert.equal(ev[0].active_rows, 10)
    const s = quarantineSummary(db)
    assert.equal(s.hosts_held, 1)
    assert.equal(s.hosts_quarantined, 0)
    assert.equal(s.rows_excluded, 10)
    assert.deepEqual(s.changes_24h.map(c => c.direction), ['excluded', 'restored', 'excluded'])
  })
})

describe('schema migration', () => {
  it('rebuilds a 2026-10-27 table (CHECK watch|quarantined) keeping its rows, and then accepts held', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qmig-')), 'db.sqlite')
    const old = new Database(file)
    old.exec(`CREATE TABLE quarantined_hosts (hostname TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('watch', 'quarantined')),
      fail_streak INTEGER NOT NULL DEFAULT 0, pass_streak INTEGER NOT NULL DEFAULT 0, entered_at TEXT, last_probe_at TEXT,
      last_http_status INTEGER, reason TEXT, seeded INTEGER NOT NULL DEFAULT 0)`)
    old.prepare("INSERT INTO quarantined_hosts (hostname, state, fail_streak, reason, seeded) VALUES ('orbisapi.com', 'quarantined', 13, 'r', 0)").run()
    old.close()
    const db = unitDb(file)
    assert.equal(row(db, 'orbisapi.com').fail_streak, 13)
    assert.equal(row(db, 'orbisapi.com').flap_count, 0)
    db.prepare("UPDATE quarantined_hosts SET state = 'held' WHERE hostname = 'orbisapi.com'").run()
    ensureQuarantineSchema(db) // idempotent
    assert.equal(row(db, 'orbisapi.com').state, 'held')
  })
})

describe('ops scripts', () => {
  const script = (name, args) => execFileSync(process.execPath, [join(ROOT, 'scripts/ops', name), ...args], { cwd: ROOT }).toString()

  it('seed-quarantine --exited-at records the earlier exit so the next re-entry is held', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qseed-')), 'db.sqlite')
    const db = unitDb(file); addRows(db, 'farm.example', 50); db.close()
    script('seed-quarantine.mjs', ['--db', file, '--host', 'farm.example', '--expect', '50', '--reason', 'flap:test', '--exited-at', '2026-10-27 22:09:40', '--yes'])
    const r = row(new Database(file), 'farm.example')
    assert.equal(r.state, 'quarantined')
    assert.equal(r.exited_at, '2026-10-27 22:09:40')
    assert.equal(r.flap_count, 1)
    assert.equal(r.reason, 'flap:test')
  })

  it('release-held moves a held host to released only with --yes, and refuses a non-held host', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qrel-')), 'db.sqlite')
    const db = unitDb(file); addRows(db, 'flap.example', 5)
    db.prepare("INSERT INTO quarantined_hosts (hostname, state, flap_count) VALUES ('flap.example', 'held', 1), ('q.example', 'quarantined', 0)").run()
    db.close()
    script('release-held.mjs', ['--db', file, '--host', 'flap.example'])
    assert.equal(row(new Database(file), 'flap.example').state, 'held', 'no --yes, no write')
    script('release-held.mjs', ['--db', file, '--host', 'flap.example', '--reason', 'operator checked', '--yes'])
    const r = row(new Database(file), 'flap.example')
    assert.equal(r.state, 'released')
    assert.ok(r.exited_at)
    assert.throws(() => script('release-held.mjs', ['--db', file, '--host', 'q.example', '--reason', 'x', '--yes']))
  })
})
