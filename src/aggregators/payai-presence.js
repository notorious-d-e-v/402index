// PayAI owns only source='payai' rows. Shared rows keep their owner's lifecycle.
export const RETIRE_AFTER = 7
const CHUNK = 20000

export function ensurePayaiPresenceSchema(database) {
  const columns = database.prepare('PRAGMA table_info(services)').all()
  if (!columns.some(column => column.name === 'payai_seen_pass')) {
    database.exec('ALTER TABLE services ADD COLUMN payai_seen_pass INTEGER')
  }
  database.exec(`CREATE TABLE IF NOT EXISTS payai_passes (
    pass_id INTEGER PRIMARY KEY,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    upstream_total INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    marked_missing INTEGER NOT NULL DEFAULT 0,
    retired INTEGER NOT NULL DEFAULT 0
  )`)
}

export function getPayaiState(database, key) {
  return database.prepare('SELECT value FROM sync_state WHERE key = ?').get(`payai_${key}`)?.value
}

export function setPayaiState(database, key, value) {
  database.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(`payai_${key}`, String(value))
}

export function startPayaiPass(database, timeoutMs) {
  let passId = Number(getPayaiState(database, 'pass_id')) || 1
  let offset = Number(getPayaiState(database, 'offset')) || 0
  const started = Date.parse(getPayaiState(database, 'pass_started_at'))
  if (!Number.isFinite(started) || Date.now() - started > timeoutMs) {
    // Abandoned passes must not share an id with their replacement, or their
    // old row stamps could falsely count as presence in the new pass.
    if (Number.isFinite(started) || offset > 0) passId++
    offset = 0
    database.transaction(() => {
      setPayaiState(database, 'pass_id', passId)
      setPayaiState(database, 'offset', 0)
      setPayaiState(database, 'pass_seen', 0)
      setPayaiState(database, 'pass_errors', 0)
      setPayaiState(database, 'pass_total', 0)
      setPayaiState(database, 'pass_started_at', new Date().toISOString())
    })()
  }
  return { passId, offset }
}

function chunkedUpdate(database, set, where, args) {
  const statement = database.prepare(`UPDATE services SET ${set}
    WHERE rowid IN (SELECT rowid FROM services WHERE ${where} LIMIT ${CHUNK})`)
  let total = 0
  for (;;) {
    const changed = database.transaction(() => statement.run(args).changes).immediate()
    total += changed
    if (changed < CHUNK) return total
  }
}

export function completePayaiPass(database, passId) {
  const upstreamTotal = Number(getPayaiState(database, 'pass_total'))
  const seen = Number(getPayaiState(database, 'pass_seen'))
  const errors = Number(getPayaiState(database, 'pass_errors'))
  // Seen counts raw inspected items, including intentional policy exclusions:
  // the server's total includes testnets and duplicate URLs too.
  const complete = upstreamTotal > 0 && seen >= upstreamTotal * 0.9 && errors === 0 ? 1 : 0
  let markedMissing = 0, retired = 0
  const active = "source = 'payai' AND (status = 'active' OR status IS NULL) AND COALESCE(provider_deleted, 0) = 0"
  if (complete) {
    markedMissing = chunkedUpdate(database, "upstream_missing_since = datetime('now')",
      `${active} AND (payai_seen_pass IS NULL OR payai_seen_pass < @pass) AND upstream_missing_since IS NULL`, { pass: passId })
    const horizon = database.prepare('SELECT pass_id FROM payai_passes WHERE complete = 1 ORDER BY pass_id DESC LIMIT 1 OFFSET ?')
      .get(RETIRE_AFTER - 2)?.pass_id
    if (horizon) {
      retired = chunkedUpdate(database, "status = 'retired', retired_batch = @batch, retired_at = datetime('now')",
        `${active} AND (payai_seen_pass IS NULL OR payai_seen_pass < @horizon)`,
        { horizon, batch: `payai-auto-pass-${passId}` })
    }
  }
  database.transaction(() => {
    database.prepare('INSERT INTO payai_passes (pass_id, upstream_total, seen, complete, marked_missing, retired) VALUES (?, ?, ?, ?, ?, ?)')
      .run(passId, upstreamTotal, seen, complete, markedMissing, retired)
    setPayaiState(database, 'pass_id', passId + 1)
    setPayaiState(database, 'offset', 0)
    setPayaiState(database, 'pass_seen', 0)
    setPayaiState(database, 'pass_errors', 0)
    setPayaiState(database, 'pass_total', 0)
    setPayaiState(database, 'pass_started_at', new Date().toISOString())
    if (complete) setPayaiState(database, 'last_full_pass', new Date().toISOString())
  })()
  return { passId, upstreamTotal, seen, complete, markedMissing, retired }
}
