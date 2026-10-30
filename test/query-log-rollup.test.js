// query_log keeps raw rows for 30 days; older rows are folded into query_log_daily (2026-10-27).
//
// query_log was 3.68M rows / 381 MB at 90-day retention, 88% of it older than 14 days, while
// every digest and admin query reads a 24h or 7d window — except the all-time 402index-mcp
// summary. These tests pin the rollup (exact counts, atomic per chunk, bounded per call) and
// the summary that now reads raw + rollup.

import { describe, it, beforeEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureQueryLogDaily, rollupQueryLog, mcpAllTime } from '../src/services/query-log-rollup.js'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query_text TEXT, filters TEXT, result_count INTEGER, response_time_ms INTEGER,
      user_agent TEXT, degraded_reason TEXT
    );
    CREATE INDEX idx_query_log_timestamp ON query_log(timestamp);
  `)
  ensureQueryLogDaily(db)
  return db
}

const ins = (db, daysAgo, q, ua, results = 3, filters = null) => db.prepare(
  "INSERT INTO query_log (timestamp, query_text, filters, result_count, user_agent) VALUES (datetime('now', ?), ?, ?, ?, ?)"
).run(`-${daysAgo} days`, q, filters, results, ua)

describe('rollupQueryLog', () => {
  let db
  beforeEach(() => { db = freshDb() })

  it('folds rows older than the cutoff into exact daily counts and deletes them', () => {
    ins(db, 40, 'weather', 'botA', 0)
    ins(db, 40, 'weather', 'botA', 5)
    ins(db, 40, 'weather', 'botB', 5)
    ins(db, 41, null, 'botA', 9)
    ins(db, 5, 'weather', 'botA', 0) // inside retention: untouched

    const r = rollupQueryLog(db, { retentionDays: 30 })
    assert.equal(r.rolled, 4)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM query_log').get().c, 1, 'recent row stays raw')

    const rows = db.prepare('SELECT term, user_agent, count, zero_result_count FROM query_log_daily ORDER BY day, term, user_agent').all()
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { term: '', user_agent: 'botA', count: 1, zero_result_count: 0 },
      { term: 'weather', user_agent: 'botA', count: 2, zero_result_count: 1 },
      { term: 'weather', user_agent: 'botB', count: 1, zero_result_count: 0 },
    ])
  })

  it('accumulates when one day is split across chunks, and a re-run adds nothing', () => {
    for (let i = 0; i < 7; i++) ins(db, 35, 'same', 'botA', i % 2)
    const r = rollupQueryLog(db, { retentionDays: 30, chunkRows: 3 })
    assert.equal(r.rolled, 7)
    assert.equal(r.chunks, 3)
    const row = db.prepare('SELECT count, zero_result_count FROM query_log_daily').get()
    assert.equal(row.count, 7)
    assert.equal(row.zero_result_count, 4)
    assert.equal(rollupQueryLog(db, { retentionDays: 30 }).rolled, 0)
    assert.equal(db.prepare('SELECT count FROM query_log_daily').get().count, 7)
  })

  it('stops after maxChunks so the hourly run stays bounded', () => {
    for (let i = 0; i < 10; i++) ins(db, 50, `q${i}`, 'botA')
    const r = rollupQueryLog(db, { retentionDays: 30, chunkRows: 2, maxChunks: 2 })
    assert.equal(r.rolled, 4)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM query_log').get().c, 6)
  })

  it('keeps first_seen/last_seen so admin can still report when mcp traffic began', () => {
    db.prepare("INSERT INTO query_log (timestamp, query_text, user_agent) VALUES ('2026-08-01 10:00:00', 'a', '402index-mcp/1.0')").run()
    db.prepare("INSERT INTO query_log (timestamp, query_text, user_agent) VALUES ('2026-08-01 18:30:00', 'a', '402index-mcp/1.0')").run()
    rollupQueryLog(db, { retentionDays: 30 })
    const row = db.prepare('SELECT first_seen, last_seen FROM query_log_daily').get()
    assert.equal(row.first_seen, '2026-08-01 10:00:00')
    assert.equal(row.last_seen, '2026-08-01 18:30:00')
  })
})

describe('mcpAllTime', () => {
  it('is identical before and after a rollup', () => {
    const db = freshDb()
    ins(db, 60, 'a', '402index-mcp/1.0')
    ins(db, 60, 'b', '402index-mcp/1.0')
    ins(db, 45, 'a', 'mozilla 402index-mcp/2.0')
    ins(db, 45, 'a', 'botA')
    ins(db, 2, 'c', '402index-mcp/1.0')
    const beforeRollup = mcpAllTime(db)
    assert.equal(beforeRollup.total, 4)
    assert.equal(beforeRollup.activeDays, 3)
    rollupQueryLog(db, { retentionDays: 30 })
    assert.equal(db.prepare('SELECT COUNT(*) c FROM query_log').get().c, 1)
    assert.deepEqual(mcpAllTime(db), beforeRollup)
  })
})

describe('digest reports all-time mcp traffic across raw and rolled-up rows', () => {
  let BASE, db, stopServer
  before(async () => {
    const srv = await import('./helpers/server.js')
    stopServer = srv.stopServer
    BASE = await srv.startServer()
    db = (await import('../src/db.js')).default
  })
  after(async () => {
    db.prepare("DELETE FROM query_log_daily WHERE user_agent = 'rollup-test 402index-mcp/9'").run()
    db.prepare("DELETE FROM query_log WHERE user_agent = 'rollup-test 402index-mcp/9'").run()
    await stopServer()
  })

  it('mcp_queries_total does not drop when old rows leave query_log', async () => {
    const read = async () => {
      const res = await fetch(`${BASE}/api/v1/digest?fresh=1`, { headers: { Authorization: `Bearer ${process.env.DIGEST_API_KEY || 'test-digest-key'}` } })
      return (await res.json()).traffic
    }
    const base = await read()
    ins(db, 45, 'x', 'rollup-test 402index-mcp/9')
    ins(db, 46, 'y', 'rollup-test 402index-mcp/9')
    const withRaw = await read()
    assert.equal(withRaw.mcp_queries_total, base.mcp_queries_total + 2)
    rollupQueryLog(db, { retentionDays: 30 })
    const afterRollup = await read()
    assert.equal(afterRollup.mcp_queries_total, withRaw.mcp_queries_total)
    assert.equal(afterRollup.mcp_active_days, withRaw.mcp_active_days)
  })
})
