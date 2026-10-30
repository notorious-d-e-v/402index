import { Router } from 'express'
import { mcpAllTime } from '../../services/query-log-rollup.js'
import { healthRuns24h } from '../../services/scheduler-events.js'
import db from '../../db.js'
import { LISTED, countQuarantined, quarantineSummary } from '../../services/visibility.js'
import { bazaarDrift } from '../../aggregators/bazaar-presence.js'
import { getProvider } from '../../services/l402-provider.js'

const router = Router()

/**
 * Read payment counters from the partner gateway.
 *
 * The index has no payment ledger — no macaroon, token or settlement table exists here — so
 * every revenue question has to be answered by the gateway or not at all. On 2026-08-03 that
 * gap turned a user-agent slipping below a top-15 traffic cutoff into a reported lost sale,
 * when the gateway's own counters said what was actually true: challenges issued, none ever
 * paid, nothing earned.
 *
 * Failure is reported, never thrown. This block feeds the daily digest, which is how outages
 * get noticed; a gateway that is down is exactly when the digest most needs to still render.
 * An unreadable gateway yields nulls plus the reason — deliberately not zeroes, which would
 * read as "we know, and the answer is none".
 */
async function readPaymentStatus() {
  const unavailable = (error) => ({
    gateway_reachable: false,
    active_macaroons: null,
    paid_macaroons: null,
    unpaid_macaroons: null,
    sats_earned_total: null,
    error,
  })

  try {
    const status = await getProvider().getStatus()
    if (!status) return unavailable('no L402 gateway configured')

    return {
      gateway_reachable: true,
      active_macaroons: status.activeMacaroons ?? null,
      paid_macaroons: status.paidMacaroons ?? null,
      unpaid_macaroons: status.unpaidMacaroons ?? null,
      sats_earned_total: status.satsEarnedTotal ?? null,
      // Present once the gateway reports swap-creation capability; null against older
      // gateway builds. Absence is not evidence that creation works.
      swap_creation: status.swapCreation ?? null,
      gateway_healthy: status.healthy ?? null,
      error: null,
    }
  } catch (err) {
    return unavailable(err.message)
  }
}

// Classify a raw User-Agent string into a coarse client type for the digest's
// top-agents breakdown. Restored here after the #276 route-split moved the
// /digest handler out of the monolithic src/routes/api.js without carrying the
// helper across. Behaviour is verbatim from the pre-split api.js.
function classifyAgent(ua) {
  if (!ua || ua === '') return 'api'
  if (ua.includes('402index-mcp')) return 'mcp'
  if (ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Safari')) return 'browser'
  return 'api'
}

router.get('/digest', async (req, res) => {
  try {
    const payments = await readPaymentStatus()
    const ACTIVE = LISTED

    // ── Totals ──
    const totalEndpoints = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE}`).get().c

    const byProtocol = {}
    db.prepare(`SELECT protocol, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY protocol`).all()
      .forEach(r => { byProtocol[r.protocol] = r.c })

    const byHealth = {}
    db.prepare(`SELECT health_status, COUNT(*) as c FROM services WHERE ${ACTIVE} GROUP BY health_status`).all()
      .forEach(r => { byHealth[r.health_status] = r.c })

    // Providers via JS hostname extraction (same approach as /health)
    const allUrls = db.prepare(`SELECT url, is_template, is_demo FROM services WHERE ${ACTIVE}`).all()
    const providerSet = new Set()
    for (const svc of allUrls) {
      if (svc.is_template || svc.is_demo) continue
      try { providerSet.add(new URL(svc.url).hostname) } catch { /* skip */ }
    }

    const paymentVerified = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE} AND x402_payment_valid = 1`).get().c
    const domainVerifiedProviders = db.prepare("SELECT COUNT(DISTINCT domain) as c FROM domain_claims WHERE status = 'verified'").get().c

    const l402Formats = db.prepare(`
      SELECT l402_format, COUNT(*) as count
      FROM services
      WHERE protocol = 'L402' AND l402_format IS NOT NULL AND ${ACTIVE}
      GROUP BY l402_format
    `).all()

    const l402FormatCounts = {}
    let l402CompliantCount = 0
    let l402NonCompliantCount = 0
    for (const row of l402Formats) {
      l402FormatCounts[row.l402_format] = row.count
      if (row.l402_format === 'v2_tlv' || row.l402_format === 'v1_binary') {
        l402CompliantCount += row.count
      } else {
        l402NonCompliantCount += row.count
      }
    }

    // ── Registrations ──
    const last24h = db.prepare(`
      SELECT id, name, url, protocol, provider, source, registered_at as created_at
      FROM services
      WHERE source = 'self-registered'
        AND registered_at > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY registered_at DESC
    `).all()

    // POST /register answers 201 for every new registration, pending ones included. Poller
    // imports (Bazaar, MPP, ...) used to be counted here too, which made "registrations" track
    // upstream churn instead of providers coming to us.
    const last7dCount = db.prepare(`
      SELECT COUNT(*) as c FROM services
      WHERE registered_at > datetime('now', '-7 days') AND source LIKE '%self-registered%'
    `).get().c

    const pendingApproval = db.prepare("SELECT COUNT(*) as c FROM services WHERE status = 'pending'").get().c

    const selfRegisteredTotal = db.prepare(`
      SELECT COUNT(*) as c FROM services WHERE source = 'self-registered' AND ${ACTIVE}
    `).get().c

    // ── Traffic ──
    const queriesToday = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    const queries7d = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > datetime('now', '-7 days')"
    ).get().c

    const uniqueAgentsToday = db.prepare(
      "SELECT COUNT(DISTINCT user_agent) as c FROM query_log WHERE timestamp > date('now')"
    ).get().c

    const mcpToday = db.prepare(
      "SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now') AND user_agent LIKE '%402index-mcp%'"
    ).get().c

    // Raw rows are kept 30 days; older ones live in query_log_daily (see query-log-rollup.js).
    const mcpSummary = mcpAllTime(db)

    // ── Search Intelligence ──
    const topSearches = db.prepare(
      `SELECT query_text as term, COUNT(*) as count
       FROM query_log
       WHERE query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 20`
    ).all()

    const zeroResults = db.prepare(
      `SELECT query_text as term, filters, COUNT(*) as count
       FROM query_log
       WHERE result_count = 0
         AND query_text IS NOT NULL AND query_text != ''
         AND timestamp > datetime('now', '-7 days')
       GROUP BY query_text
       ORDER BY count DESC LIMIT 10`
    ).all()

    const topAgents = db.prepare(
      `SELECT user_agent as agent, COUNT(*) as count
       FROM query_log
       WHERE timestamp > datetime('now', '-7 days')
       GROUP BY user_agent
       ORDER BY count DESC LIMIT 15`
    ).all().map(r => ({ ...r, type: classifyAgent(r.agent) }))

    // ── Health Changes (approximate — based on current status + last_checked) ──
    const newlyDegraded = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'degraded'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    const newlyDown = db.prepare(`
      SELECT id, name, url, protocol, provider, health_status, last_checked
      FROM services
      WHERE health_status = 'down'
        AND last_checked > datetime('now', '-24 hours')
        AND ${ACTIVE}
      ORDER BY last_checked DESC LIMIT 10
    `).all()

    // Recovered: currently healthy but had a down/degraded check in last 48h
    const recovered = db.prepare(`
      SELECT s.id, s.name, s.url, s.protocol, s.provider, s.health_status, s.last_checked
      FROM services s
      WHERE s.health_status = 'healthy'
        AND s.last_checked > datetime('now', '-24 hours')
        AND EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.service_id = s.id
            AND hc.status IN ('down', 'degraded')
            AND hc.checked_at > datetime('now', '-48 hours')
        )
        AND (s.status = 'active' OR s.status IS NULL)
        AND (s.provider_deleted = 0 OR s.provider_deleted IS NULL)
      ORDER BY s.last_checked DESC LIMIT 10
    `).all()

    res.json({
      generated_at: new Date().toISOString(),
      // "N health runs skipped in 24h, reason": a stalled checker must show up here, not only in logs.
      health_runs: healthRuns24h(db),
      // Hosts out of the counts and what moved in the last 24 h (2026-10-28: one 77k-row host
      // leaving quarantine doubled totals.endpoints overnight).
      quarantine: quarantineSummary(db),
      // Bazaar poll freshness. last_page_processed_at is when the poller last stored an offset;
      // a stale value with no pass completing is the silent hang in #370.
      bazaar: (() => {
        const d = bazaarDrift(db)
        return { upstream_total: d.upstream_total, upstream_missing: d.upstream_missing, last_page_processed_at: d.last_page_processed_at,
          offset: d.offset, last_complete_pass: d.last_complete_pass, last_complete_pass_at: d.last_complete_pass_at }
      })(),
      totals: {
        endpoints: totalEndpoints,
        providers: providerSet.size,
        by_protocol: byProtocol,
        by_health: byHealth,
        payment_verified: paymentVerified,
        // The key is kept for existing readers; the count is x402 rows whose 402 challenge parsed.
        payment_verified_means: '402 header parsed',
        // What the totals leave out, so a drop in endpoints can be read without /api/v1/health.
        ...(() => {
          const drift = bazaarDrift(db)
          return {
            excluded_quarantined: countQuarantined(db),
            excluded_retired: drift.retired,
            bazaar_upstream_total: drift.upstream_total,
            bazaar_upstream_missing: drift.upstream_missing,
          }
        })(),
        domain_verified_providers: domainVerifiedProviders,
        l402_format_counts: l402FormatCounts,
        l402_compliant_count: l402CompliantCount,
        l402_non_compliant_count: l402NonCompliantCount,
      },
      registrations: {
        last_24h: last24h,
        last_7d_count: last7dCount,
        pending_approval: pendingApproval,
        self_registered_total: selfRegisteredTotal,
      },
      traffic: {
        queries_today: queriesToday,
        queries_7d: queries7d,
        unique_agents_today: uniqueAgentsToday,
        mcp_queries_today: mcpToday,
        mcp_queries_total: mcpSummary.total,
        mcp_active_days: mcpSummary.activeDays,
      },
      search_intelligence: {
        top_searches_7d: topSearches,
        zero_results_7d: zeroResults,
        top_user_agents_7d: topAgents,
      },
      health_changes: {
        newly_degraded_24h: newlyDegraded,
        newly_down_24h: newlyDown,
        recovered_24h: recovered,
      },
      payments,
    })
  } catch (err) {
    console.error('GET /api/v1/digest error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

export default router
