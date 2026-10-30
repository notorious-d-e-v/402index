// Which services count. One definition, imported by every count, list and feed (2026-10-27).
//
// LISTED = active (not pending/rejected/retired), not provider-deleted, and not on a
// quarantined host. A host is quarantined when it has stopped answering with a paywall
// (src/health/quarantine.js); its rows keep their /service/:id page but leave every count,
// default list, llms.txt, feed.xml and digest. Before this module each route carried its own
// copy of the active filter, which is how counts drift apart.
//
// QUARANTINE_ENABLED=false restores the old counts without a schema change.

export const QUARANTINE_ENABLED = process.env.QUARANTINE_ENABLED !== 'false'

export const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"

// held = re-entered within 30 days of leaving; out of counts until scripts/ops/release-held.mjs.
export const EXCLUDED_STATES = "('quarantined', 'held')"

export const NOT_QUARANTINED = QUARANTINE_ENABLED
  ? `(hostname IS NULL OR hostname NOT IN (SELECT hostname FROM quarantined_hosts WHERE state IN ${EXCLUDED_STATES}))`
  : '1'

export const LISTED = `${ACTIVE} AND ${NOT_QUARANTINED}`

const HOSTS_TABLE = `
    CREATE TABLE IF NOT EXISTS quarantined_hosts (
      hostname TEXT PRIMARY KEY,
      -- watch: failing, not yet excluded. quarantined: excluded, leaves on its own.
      -- held: flapped, excluded until an operator releases it. released: back in counts; kept
      -- 30 days so a re-entry can be recognised as a flap.
      state TEXT NOT NULL CHECK (state IN ('watch', 'quarantined', 'held', 'released')),
      fail_streak INTEGER NOT NULL DEFAULT 0,
      pass_streak INTEGER NOT NULL DEFAULT 0,
      entered_at TEXT,
      last_probe_at TEXT,
      last_http_status INTEGER,
      reason TEXT,
      seeded INTEGER NOT NULL DEFAULT 0,
      first_pass_at TEXT,
      exited_at TEXT,
      flap_count INTEGER NOT NULL DEFAULT 0
    )`
const V1_COLUMNS = 'hostname, state, fail_streak, pass_streak, entered_at, last_probe_at, last_http_status, reason, seeded'

export function ensureQuarantineSchema(database) {
  const existing = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quarantined_hosts'").get()
  if (existing && !existing.sql.includes("'held'")) {
    // 2026-10-27 table: the state CHECK cannot be altered in place, so rebuild (a few hundred rows).
    database.transaction(() => {
      database.exec('ALTER TABLE quarantined_hosts RENAME TO quarantined_hosts_v1')
      database.exec(HOSTS_TABLE)
      database.exec(`INSERT INTO quarantined_hosts (${V1_COLUMNS}) SELECT ${V1_COLUMNS} FROM quarantined_hosts_v1`)
      database.exec('DROP TABLE quarantined_hosts_v1')
    })()
  } else {
    database.exec(HOSTS_TABLE)
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS quarantine_events (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      hostname TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      active_rows INTEGER,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quarantine_events_at ON quarantine_events(at);
  `)
}

/** One row per move into or out of the excluded states. Never throws. */
export function recordQuarantineEvent(database, { hostname, from, to, detail = null }) {
  try {
    const rows = database.prepare(`SELECT COUNT(*) AS c FROM services WHERE hostname = ? AND ${ACTIVE}`).get(hostname).c
    database.prepare('INSERT INTO quarantine_events (hostname, from_state, to_state, active_rows, detail) VALUES (?, ?, ?, ?, ?)')
      .run(hostname, from ?? null, to, rows, detail)
  } catch (err) {
    console.error(`[quarantine] could not record event for ${hostname}: ${err.message}`)
  }
}

/** Active rows hidden by quarantine. 0 when the flag is off. */
export function countQuarantined(database) {
  if (!QUARANTINE_ENABLED) return 0
  return database.prepare(
    `SELECT COUNT(*) AS c FROM services WHERE ${ACTIVE} AND hostname IN (SELECT hostname FROM quarantined_hosts WHERE state IN ${EXCLUDED_STATES})`
  ).get().c
}

const EXCLUDED = new Set(['quarantined', 'held'])

/** The digest's quarantine block. */
export function quarantineSummary(database) {
  const byState = Object.fromEntries(database.prepare('SELECT state, COUNT(*) AS n FROM quarantined_hosts GROUP BY state').all().map(r => [r.state, r.n]))
  const changes = database.prepare(
    "SELECT at, hostname, from_state, to_state, active_rows FROM quarantine_events WHERE at > datetime('now', '-24 hours') ORDER BY id"
  ).all().map(e => ({ at: e.at, hostname: e.hostname, from: e.from_state, to: e.to_state, active_rows: e.active_rows,
    direction: EXCLUDED.has(e.to_state) ? 'excluded' : 'restored' }))
  return {
    enabled: QUARANTINE_ENABLED,
    hosts_quarantined: byState.quarantined ?? 0,
    hosts_held: byState.held ?? 0,
    hosts_watching: byState.watch ?? 0,
    rows_excluded: countQuarantined(database),
    changes_24h: changes,
  }
}

export function isHostQuarantined(database, hostname) {
  if (!QUARANTINE_ENABLED || !hostname) return null
  return database.prepare(`SELECT hostname, state, entered_at, reason, last_http_status FROM quarantined_hosts WHERE hostname = ? AND state IN ${EXCLUDED_STATES}`).get(hostname) || null
}
