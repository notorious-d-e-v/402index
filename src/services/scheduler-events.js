// A small ledger of scheduled-job outcomes, so a job that quietly stops running shows up in the
// digest (2026-10-27: the disk guard skipped every health run for ~18h, visible only as one log
// line an hour). Kept 30 days.

export function ensureSchedulerEvents(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      job TEXT NOT NULL,
      event TEXT NOT NULL,
      reason TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_events_at ON scheduler_events(at);
  `)
}

/** Never throws: a full disk is one of the reasons this gets called. */
export function recordSchedulerEvent(database, { job, event, reason = null, detail = null }) {
  try {
    database.prepare('INSERT INTO scheduler_events (job, event, reason, detail) VALUES (?, ?, ?, ?)').run(job, event, reason, detail)
  } catch (err) {
    console.warn(`[scheduler] could not record ${job} ${event}: ${err.message}`)
  }
}

export function pruneSchedulerEvents(database) {
  database.prepare("DELETE FROM scheduler_events WHERE at < datetime('now', '-30 days')").run()
}

/** Health-run outcomes over the last 24h, for the digest. */
export function healthRuns24h(database) {
  const rows = database.prepare(`
    SELECT event, reason, COUNT(*) AS n FROM scheduler_events
    WHERE job = 'health' AND at > datetime('now', '-1 day') GROUP BY event, reason
  `).all()
  const skipReasons = {}
  let skipped = 0, completed = 0
  for (const r of rows) {
    if (r.event === 'skipped') { skipped += r.n; skipReasons[r.reason || 'unknown'] = r.n }
    if (r.event === 'completed') completed += r.n
  }
  const last = database.prepare("SELECT at, detail FROM scheduler_events WHERE job = 'health' AND event = 'completed' ORDER BY id DESC LIMIT 1").get()
  return { skipped_24h: skipped, skip_reasons: skipReasons, completed_24h: completed, last_completed_at: last?.at ?? null, last_completed: last?.detail ?? null }
}
