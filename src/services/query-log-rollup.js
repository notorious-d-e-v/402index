// query_log keeps raw rows for QUERY_LOG_RETENTION_DAYS (30); older rows are folded into
// query_log_daily, one row per (day, term, filters, user_agent), then deleted.
//
// Why: at 90-day retention query_log was 3.68M rows / 381 MB (2026-10-27), on a volume the
// health checker refuses to work on above 80%. Every digest/admin query reads a 24h or 7d
// window of raw rows, except the all-time 402index-mcp summary, which mcpAllTime() serves
// from raw + rollup. 91 days of history roll up into ~168k rows.
//
// Each chunk rolls up and deletes the same rows in one transaction, so a crash can never
// count a row twice, and a chunk touches at most chunkRows narrow rows (journal_mode=delete:
// the rollback journal grows with pages touched). No side effects on import: ops scripts can
// pass their own handle without loading src/db.js.

export const QUERY_LOG_RETENTION_DAYS = 30

export function ensureQueryLogDaily(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS query_log_daily (
      day TEXT NOT NULL,
      term TEXT NOT NULL,
      filters TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      count INTEGER NOT NULL,
      zero_result_count INTEGER NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (day, term, filters, user_agent)
    )
  `)
}

// NULL term/filters/user_agent are stored as '' so the primary key can merge them; every
// consumer already treats NULL and '' query_text the same way.
const CHUNK_IDS = `SELECT id FROM query_log WHERE timestamp < @cutoff ORDER BY timestamp, id LIMIT @n`

/**
 * Fold raw rows older than retentionDays into query_log_daily, chunk by chunk.
 * @returns {{ rolled: number, chunks: number }}
 */
export function rollupQueryLog(database, { retentionDays = QUERY_LOG_RETENTION_DAYS, chunkRows = 20000, maxChunks = Infinity } = {}) {
  const cutoff = database.prepare("SELECT datetime('now', ?) AS c").get(`-${retentionDays} days`).c
  const fold = database.prepare(`
    INSERT INTO query_log_daily (day, term, filters, user_agent, count, zero_result_count, first_seen, last_seen)
    SELECT date(timestamp), IFNULL(query_text, ''), IFNULL(filters, ''), IFNULL(user_agent, ''),
           COUNT(*), SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END), MIN(timestamp), MAX(timestamp)
    FROM query_log WHERE id IN (${CHUNK_IDS})
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (day, term, filters, user_agent) DO UPDATE SET
      count = count + excluded.count,
      zero_result_count = zero_result_count + excluded.zero_result_count,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen)
  `)
  const drop = database.prepare(`DELETE FROM query_log WHERE id IN (${CHUNK_IDS})`)
  const chunk = database.transaction(() => {
    fold.run({ cutoff, n: chunkRows })
    return drop.run({ cutoff, n: chunkRows }).changes
  })

  let rolled = 0, chunks = 0
  while (chunks < maxChunks) {
    const n = chunk.immediate()
    if (n === 0) break
    rolled += n
    chunks++
  }
  return { rolled, chunks }
}

const MCP = "LIKE '%402index-mcp%'"

/** All-time 402index-mcp traffic across raw rows and rolled-up days. */
export function mcpAllTime(database) {
  const raw = database.prepare(
    `SELECT COUNT(*) AS total, MIN(timestamp) AS firstSeen, MAX(timestamp) AS lastSeen FROM query_log WHERE user_agent ${MCP}`
  ).get()
  const rolled = database.prepare(
    `SELECT IFNULL(SUM(count), 0) AS total, MIN(first_seen) AS firstSeen, MAX(last_seen) AS lastSeen FROM query_log_daily WHERE user_agent ${MCP}`
  ).get()
  const activeDays = database.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT date(timestamp) FROM query_log WHERE user_agent ${MCP}
      UNION
      SELECT day FROM query_log_daily WHERE user_agent ${MCP}
    )
  `).get().c
  const pick = (a, b, f) => (a == null ? b : b == null ? a : f(a, b))
  return {
    total: raw.total + rolled.total,
    activeDays,
    firstSeen: pick(raw.firstSeen, rolled.firstSeen, (a, b) => (a < b ? a : b)),
    lastSeen: pick(raw.lastSeen, rolled.lastSeen, (a, b) => (a > b ? a : b)),
  }
}
