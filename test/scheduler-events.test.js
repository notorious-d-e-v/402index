// Skipped health runs are visible (2026-10-27). The disk guard skipped every run for ~18h and
// the only trace was one log line per hour; the digest said nothing.

import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { checkDiskSpace, runHealthChecks } from '../src/health/checker.js'
import { recordSchedulerEvent } from '../src/services/scheduler-events.js'

const DIGEST = { Authorization: `Bearer ${process.env.DIGEST_API_KEY || 'test-digest-key'}` }
const at85 = async () => ({ blocks: 1000, bsize: 4096, bfree: 150 })

describe('skipped health runs', () => {
  before(() => db.prepare('DELETE FROM scheduler_events').run())
  after(() => db.prepare('DELETE FROM scheduler_events').run())

  it('the disk guard records why it skipped', async () => {
    assert.equal(await checkDiskSpace({ statfsFn: at85, database: db }), 'skip')
    const e = db.prepare("SELECT job, event, reason, detail FROM scheduler_events ORDER BY id DESC LIMIT 1").get()
    assert.deepEqual({ ...e, detail: undefined }, { job: 'health', event: 'skipped', reason: 'disk-guard', detail: undefined })
    assert.match(e.detail, /85\.0%/)
  })

  it('the digest reports skipped runs in the last 24h with their reasons', async () => {
    recordSchedulerEvent(db, { job: 'health', event: 'skipped', reason: 'previous-run-active' })
    const { startServer, stopServer } = await import('./helpers/server.js')
    const base = await startServer()
    try {
      const d = await (await fetch(`${base}/api/v1/digest`, { headers: DIGEST })).json()
      assert.equal(d.health_runs.skipped_24h, 2)
      assert.deepEqual(d.health_runs.skip_reasons, { 'disk-guard': 1, 'previous-run-active': 1 })
    } finally {
      await stopServer()
    }
  })

  it('[health] Done carries DB file size and freelist, and a completed run is recorded', async () => {
    const lines = []
    const log = mock.method(console, 'log', (...a) => lines.push(a.join(' ')))
    try {
      await runHealthChecks({ checkDisk: async () => 'continue' })
    } finally {
      log.mock.restore()
    }
    const done = lines.find(l => l.startsWith('[health] Done'))
    assert.match(done, /db_bytes=\d+ freelist=\d+/)
    const e = db.prepare("SELECT event FROM scheduler_events WHERE job = 'health' ORDER BY id DESC LIMIT 1").get()
    assert.equal(e.event, 'completed')
  })
})
