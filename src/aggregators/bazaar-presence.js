// Bazaar presence: which rows the live Bazaar listing still carries (2026-10-27).
//
// On 2026-10-27 the index held ~189k source=bazaar rows against an upstream total of ~85k: rows
// the listing had dropped were never removed. Every full catalog pass now stamps the rows it
// lists with the pass id (services.bazaar_seen_pass) and logs itself in bazaar_passes. When a
// complete pass ends:
//   - active bazaar rows it did not list get upstream_missing_since (a visible bucket)
//   - rows absent from the last RETIRE_AFTER complete passes become status='retired',
//     retired_batch='auto-pass-<id>'
// A pass is complete only if it listed at least 90% of the upstream total, so a truncated or
// rate-limited pass never counts against anyone. Retirement uses status, not provider_deleted:
// purgeSoftDeleted hard-deletes provider_deleted rows after 30 days. The upsert in bazaar.js
// clears all of this when a retired or missing row is listed again.
//
// Storage is one integer per row plus one row per pass. A presence table appending ~85k URLs a
// pass would add ~120 MB a day to a 4.6 GB volume.

export const RETIRE_AFTER = 7
const COMPLETE_SHARE = 0.9
const CHUNK = 20000

function addColumn(database, sql) {
  try { database.exec(sql) } catch { /* column exists */ }
}

export function ensureBazaarPresenceSchema(database) {
  addColumn(database, 'ALTER TABLE services ADD COLUMN bazaar_seen_pass INTEGER')
  addColumn(database, 'ALTER TABLE services ADD COLUMN upstream_missing_since TEXT')
  addColumn(database, 'ALTER TABLE services ADD COLUMN retired_batch TEXT')
  addColumn(database, 'ALTER TABLE services ADD COLUMN retired_at TEXT')
  database.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_passes (
      pass_id INTEGER PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      upstream_total INTEGER NOT NULL,
      seen INTEGER NOT NULL,
      complete INTEGER NOT NULL,
      marked_missing INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_services_retired_batch ON services(retired_batch) WHERE retired_batch IS NOT NULL;
  `)
}

export function currentPassId(database) {
  const v = database.prepare("SELECT value FROM sync_state WHERE key = 'bazaar_pass_id'").get()?.value
  return parseInt(v) || 1
}

// Narrow UPDATEs in bounded transactions (journal_mode=delete: the journal grows with pages touched).
function chunkedUpdate(database, sql, params) {
  const stmt = database.prepare(`${sql} WHERE rowid IN (SELECT rowid FROM services WHERE ${params.where} LIMIT ${CHUNK})`)
  let total = 0
  for (;;) {
    const n = database.transaction(() => stmt.run(params.args).changes).immediate()
    total += n
    if (n < CHUNK) return total
  }
}

/** Close the current pass. Called when a poll reaches the end of the catalog. */
export function completePass(database, upstreamTotal) {
  const passId = currentPassId(database)
  const seen = database.prepare('SELECT COUNT(*) AS c FROM services WHERE bazaar_seen_pass = ?').get(passId).c
  const complete = upstreamTotal > 0 && seen >= upstreamTotal * COMPLETE_SHARE ? 1 : 0
  let markedMissing = 0, retired = 0

  if (complete) {
    const absent = `source = 'bazaar' AND (status = 'active' OR status IS NULL) AND (bazaar_seen_pass IS NULL OR bazaar_seen_pass < @pass)`
    markedMissing = chunkedUpdate(database, "UPDATE services SET upstream_missing_since = datetime('now')",
      { where: `${absent} AND upstream_missing_since IS NULL`, args: { pass: passId } })

    // The RETIRE_AFTER-th most recent complete pass, counting this one. A row last seen before
    // it has been missing from every one of those passes.
    const horizon = database.prepare('SELECT pass_id FROM bazaar_passes WHERE complete = 1 ORDER BY pass_id DESC LIMIT 1 OFFSET ?')
      .get(RETIRE_AFTER - 2)?.pass_id
    if (horizon) {
      retired = chunkedUpdate(database, "UPDATE services SET status = 'retired', retired_batch = @batch, retired_at = datetime('now')",
        { where: `source = 'bazaar' AND (status = 'active' OR status IS NULL) AND (bazaar_seen_pass IS NULL OR bazaar_seen_pass < @horizon)`,
          args: { horizon, batch: `auto-pass-${passId}` } })
    }
  }

  database.prepare('INSERT INTO bazaar_passes (pass_id, upstream_total, seen, complete, marked_missing, retired) VALUES (?, ?, ?, ?, ?, ?)')
    .run(passId, upstreamTotal, seen, complete, markedMissing, retired)
  database.prepare(`INSERT INTO sync_state (key, value) VALUES ('bazaar_pass_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(String(passId + 1))
  return { passId, upstreamTotal, seen, complete, markedMissing, retired }
}

/** Numbers for /api/v1/health. */
export function bazaarDrift(database) {
  const last = database.prepare('SELECT pass_id, completed_at, upstream_total, seen FROM bazaar_passes WHERE complete = 1 ORDER BY pass_id DESC LIMIT 1').get()
  // bazaar.js writes the offset after every page, so its updated_at is the last page processed.
  const offset = database.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'bazaar_offset'").get()
  return {
    upstream_total: last?.upstream_total ?? null,
    last_complete_pass: last?.pass_id ?? null,
    last_complete_pass_at: last?.completed_at ?? null,
    last_page_processed_at: offset?.updated_at ?? null,
    offset: offset ? Number(offset.value) : null,
    upstream_missing: database.prepare("SELECT COUNT(*) AS c FROM services WHERE source = 'bazaar' AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL) AND upstream_missing_since IS NOT NULL").get().c,
    retired: database.prepare("SELECT COUNT(*) AS c FROM services WHERE status = 'retired'").get().c,
  }
}
