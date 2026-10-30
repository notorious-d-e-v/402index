// Host quarantine: take a host that has stopped answering with a paywall out of every count
// and list, and put it back once it answers again (2026-10-27).
//
// Motivating case: market.datapackvibe.com, ~70k Bazaar rows on one hostname. Its Cloudflare
// tunnel went dark 2026-10-18 (530, "error code: 1033"), came back by 10-25, and was dark again
// 10-27 (x402-foundation/x402#3844). One flapping host was a third of the index.
//
// Once per health run, before the sweep, each tracked host gets a host-level probe: its apex
// plus up to SAMPLE rows chosen at random. A probe set FAILS when no response is a 402 or 2xx
// (network errors and timeouts count as failures). It PASSES when at least one response is 402.
//   new host, fails          → watch, fail_streak 1
//   watch, fails ENTER times → quarantined, or held if it left quarantine < FLAP_WINDOW_DAYS ago
//   watch, any 402/2xx       → dropped (or back to released, keeping its exit record)
//   quarantined, passes      → released once BOTH pass_streak ≥ EXIT and EXIT_HOURS have passed
//                              since the streak's first pass; hosts with > LARGE_HOST_ROWS active
//                              rows need LARGE_EXIT runs and LARGE_EXIT_HOURS. Any non-pass resets.
//   held                     → probed and recorded, never released here: scripts/ops/release-held.mjs
//   released                 → kept FLAP_WINDOW_DAYS, then pruned
// Hysteresis added 2026-10-28: market.datapackvibe.com (77k rows) entered 10-27 19:50Z and left
// 22:09Z after three passing runs; the symmetric 3-in/3-out rule moved the public total by half.
// Quarantined rows are skipped by the sweep (getServices), so this probe is the only thing
// still watching them.
import { probeEndpoint } from '../services/probe-endpoint.js'
import { ACTIVE, QUARANTINE_ENABLED, recordQuarantineEvent } from '../services/visibility.js'

export const SAMPLE = 5
export const ENTER = 3
export const EXIT = 3
export const EXIT_HOURS = 24
export const LARGE_HOST_ROWS = 1000
export const LARGE_EXIT = 6
export const LARGE_EXIT_HOURS = 72
export const FLAP_WINDOW_DAYS = 30
export const MIN_GAP_MINUTES = 45
const HOST_CONCURRENCY = 16
const MIN_ROWS = 5

async function defaultProbe(url, method, body) {
  const r = await probeEndpoint(url, { method: method || 'GET', body: body || '{}', followRedirects: true })
  return r.errorMessage ? null : r.httpStatus
}

const ok = s => s === 402 || (s >= 200 && s < 300)
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const hoursSince = ts => (ts ? (Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 3.6e6 : 0)

/**
 * Discover failing hosts and advance every tracked host's state.
 * @param {object} database
 * @param {{ probe?: (url: string, method?: string, body?: string) => Promise<number|null> }} [opts]
 */
export async function evaluateQuarantine(database, { probe = defaultProbe, minGapMinutes = MIN_GAP_MINUTES } = {}) {
  if (!QUARANTINE_ENABLED) return { evaluated: 0 }

  // A host's streak advances at most once per MIN_GAP_MINUTES. Runs start at every boot, and on
  // 2026-10-27 three deploys in 25 minutes walked 102 hosts through "3 failing runs" — the rule
  // means three sweeps, roughly three hours of evidence.
  // Exit records older than the flap window are no longer needed; prune before reading the table.
  database.prepare(`DELETE FROM quarantined_hosts WHERE state = 'released' AND exited_at <= datetime('now', ?)`).run(`-${FLAP_WINDOW_DAYS} days`)
  database.prepare(`DELETE FROM quarantine_events WHERE at <= datetime('now', '-90 days')`).run()
  const tracked = database.prepare(
    `SELECT * FROM quarantined_hosts WHERE last_probe_at IS NULL OR last_probe_at <= datetime('now', ?)`
  ).all(`-${minGapMinutes} minutes`)
  const recentlyProbed = database.prepare(
    `SELECT hostname FROM quarantined_hosts WHERE last_probe_at > datetime('now', ?)`
  ).all(`-${minGapMinutes} minutes`).map(r => r.hostname)
  const known = new Set([...tracked.map(t => t.hostname), ...recentlyProbed])
  // A host whose rows the sweep has driven down and none of which answers healthy. Uses the
  // sweep's own verdicts, so a host only becomes a candidate after the sweep has seen it fail.
  const candidates = database.prepare(`
    SELECT hostname FROM services WHERE ${ACTIVE} AND hostname IS NOT NULL
    GROUP BY hostname
    HAVING COUNT(*) >= ${MIN_ROWS} AND SUM(health_status = 'healthy') = 0 AND SUM(health_status = 'down') * 2 >= COUNT(*)
  `).all().map(r => r.hostname).filter(h => !known.has(h))

  const sampleRows = database.prepare(
    `SELECT url, http_method, probe_body FROM services WHERE hostname = ? AND ${ACTIVE} ORDER BY random() LIMIT ${SAMPLE}`
  )
  const activeRows = database.prepare(`SELECT COUNT(*) AS c FROM services WHERE hostname = ? AND ${ACTIVE}`)
  const write = database.prepare(`
    INSERT INTO quarantined_hosts (hostname, state, fail_streak, pass_streak, entered_at, last_probe_at, last_http_status, reason,
      first_pass_at, exited_at, flap_count)
    VALUES (@hostname, @state, @fail_streak, @pass_streak, @entered_at, datetime('now'), @last_http_status, @reason,
      @first_pass_at, @exited_at, @flap_count)
    ON CONFLICT (hostname) DO UPDATE SET state = excluded.state, fail_streak = excluded.fail_streak,
      pass_streak = excluded.pass_streak, entered_at = excluded.entered_at, last_probe_at = excluded.last_probe_at,
      last_http_status = excluded.last_http_status,
      reason = CASE WHEN @new_reason THEN excluded.reason ELSE COALESCE(quarantined_hosts.reason, excluded.reason) END,
      first_pass_at = excluded.first_pass_at, exited_at = excluded.exited_at, flap_count = excluded.flap_count
  `)
  const drop = database.prepare('DELETE FROM quarantined_hosts WHERE hostname = ?')
  const save = (host, changes) => write.run({
    hostname: host.hostname, state: host.state, fail_streak: host.fail_streak ?? 0, pass_streak: host.pass_streak ?? 0,
    entered_at: host.entered_at ?? null, last_http_status: null, reason: null, first_pass_at: host.first_pass_at ?? null,
    exited_at: host.exited_at ?? null, flap_count: host.flap_count ?? 0, new_reason: 0, ...changes,
  })

  const summary = { evaluated: 0, entered: [], released: [], held: [], watching: 0, quarantined: 0 }
  const hosts = [
    ...tracked,
    ...candidates.map(h => ({ hostname: h, state: null, fail_streak: 0, pass_streak: 0, entered_at: null })),
  ]

  // Hosts are independent, so probe up to HOST_CONCURRENCY of them at once: on 2026-10-27 the
  // first run found 386 candidate hosts, and probing them one by one held the sweep ~20 min.
  // A host's own probes stay sequential. State writes are synchronous, so workers never interleave.
  async function evaluateHost(host) {
    const targets = [{ url: `https://${host.hostname}/`, http_method: 'GET', probe_body: null }, ...sampleRows.all(host.hostname)]
    const statuses = []
    for (const t of targets) {
      try { statuses.push(await probe(t.url, t.http_method, t.probe_body)) } catch { statuses.push(null) }
    }
    summary.evaluated++
    const fails = !statuses.some(ok)
    const passes = statuses.includes(402)
    const last = statuses.find(s => s != null) ?? null
    const reason = `no 402/2xx from apex + ${targets.length - 1} rows: ${statuses.join(',')}`
    const passStreak = passes ? host.pass_streak + 1 : 0
    const firstPass = passes ? (host.first_pass_at ?? nowSql()) : null

    if (host.state === 'held') {
      save(host, { pass_streak: passStreak, first_pass_at: firstPass, last_http_status: last, reason })
      summary.held.push(host.hostname)
      return
    }

    if (host.state === 'quarantined') {
      const large = activeRows.get(host.hostname).c > LARGE_HOST_ROWS
      const [needRuns, needHours] = large ? [LARGE_EXIT, LARGE_EXIT_HOURS] : [EXIT, EXIT_HOURS]
      if (passStreak >= needRuns && hoursSince(firstPass) >= needHours) {
        recordQuarantineEvent(database, { hostname: host.hostname, from: 'quarantined', to: 'released',
          detail: `${passStreak} passing runs over ${Math.floor(hoursSince(firstPass))} h (${statuses.join(',')})` })
        save(host, { state: 'released', fail_streak: 0, pass_streak: 0, first_pass_at: null, exited_at: nowSql(), last_http_status: last, reason })
        summary.released.push(host.hostname)
        console.log(`[quarantine] released ${host.hostname} after ${passStreak} passing runs over ${Math.floor(hoursSince(firstPass))} h (${statuses.join(',')})`)
      } else {
        save(host, { fail_streak: passes ? host.fail_streak : host.fail_streak + 1, pass_streak: passStreak, first_pass_at: firstPass, last_http_status: last, reason })
        summary.quarantined++
      }
      return
    }

    // watch, released, or a new candidate
    if (!fails) {
      if (host.exited_at) save(host, { state: 'released', fail_streak: 0, pass_streak: 0, last_http_status: last })
      else if (host.state === 'watch') drop.run(host.hostname)
      return
    }
    const streak = host.fail_streak + 1
    if (streak >= ENTER) {
      const flapped = host.exited_at && hoursSince(host.exited_at) <= FLAP_WINDOW_DAYS * 24
      const to = flapped ? 'held' : 'quarantined'
      const why = flapped ? `flap: re-entered ${Math.floor(hoursSince(host.exited_at))} h after leaving quarantine; ${reason}` : reason
      recordQuarantineEvent(database, { hostname: host.hostname, from: host.state ?? 'watch', to, detail: why })
      save(host, { state: to, fail_streak: streak, pass_streak: 0, first_pass_at: null, entered_at: nowSql(), last_http_status: last,
        reason: why, new_reason: host.exited_at ? 1 : 0, flap_count: (host.flap_count ?? 0) + (host.exited_at ? 1 : 0) })
      summary.entered.push(host.hostname)
      if (flapped) summary.held.push(host.hostname)
      else summary.quarantined++
      console.log(`[quarantine] ${to} ${host.hostname} after ${ENTER} failing runs (${statuses.join(',')})`)
    } else {
      save(host, { state: 'watch', fail_streak: streak, pass_streak: 0, first_pass_at: null, entered_at: null, last_http_status: last, reason })
      summary.watching++
    }
  }
  let next = 0
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, hosts.length) }, async () => {
    while (next < hosts.length) await evaluateHost(hosts[next++])
  }))
  if (summary.evaluated > 0) console.log(`[quarantine] evaluated ${summary.evaluated} hosts: quarantined=${summary.quarantined} held=${summary.held.length} watching=${summary.watching} entered=${summary.entered.length} released=${summary.released.length}`)
  return summary
}
