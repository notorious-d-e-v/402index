import db from '../db.js'
import { LISTED } from './visibility.js'

const ACTIVE_FILTER = LISTED

/**
 * Capture a daily snapshot of ecosystem metrics.
 * Upserts on snapshot_date — safe to call multiple times per day.
 */
export function captureSnapshot(database = db) {
  const today = new Date().toISOString().slice(0, 10)

  // Aggregate counts
  const totalEndpoints = database.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER}`).get().c
  const verifiedEndpoints = database.prepare(
    `SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND ((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy') OR (protocol = 'MPP' AND health_status = 'healthy'))`
  ).get().c

  // Health breakdown
  const healthRows = database.prepare(`SELECT health_status, COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} GROUP BY health_status`).all()
  const healthMap = { healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of healthRows) {
    if (healthMap[row.health_status] !== undefined) healthMap[row.health_status] = row.c
  }

  // Per-protocol endpoint counts
  const protocols = ['L402', 'x402', 'MPP']
  const protocolStats = {}
  for (const proto of protocols) {
    const total = database.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = ?`).get(proto).c
    const healthy = database.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = ? AND health_status = 'healthy'`).get(proto).c
    let verified
    if (proto === 'x402') {
      verified = database.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = 'x402' AND x402_payment_valid = 1`).get().c
    } else {
      verified = healthy
    }
    protocolStats[proto] = { total, verified, healthy }
  }

  // Provider counts (hostname dedup, excluding templates/demos)
  const allUrls = database.prepare(`SELECT url, protocol, is_template, is_demo, x402_payment_valid, health_status FROM services WHERE ${ACTIVE_FILTER}`).all()
  const providerSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
  const allProviderSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
  for (const svc of allUrls) {
    if (svc.is_template || svc.is_demo) continue
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    allProviderSets.total.add(host)
    allProviderSets[svc.protocol]?.add(host)
    if ((svc.protocol === 'L402' && svc.health_status === 'healthy') ||
        (svc.protocol === 'x402' && svc.x402_payment_valid === 1) ||
        (svc.protocol === 'MPP' && svc.health_status === 'healthy')) {
      providerSets.total.add(host)
      providerSets[svc.protocol]?.add(host)
    }
  }

  // Reliability & latency aggregates
  const reliabilityRow = database.prepare(
    `SELECT AVG(reliability_score) as avg_rel FROM services WHERE ${ACTIVE_FILTER} AND reliability_score IS NOT NULL AND is_template = 0 AND is_demo = 0`
  ).get()

  const latencyRows = database.prepare(
    `SELECT latency_p50_ms FROM services WHERE ${ACTIVE_FILTER} AND health_status = 'healthy' AND latency_p50_ms IS NOT NULL AND is_template = 0 AND is_demo = 0 ORDER BY latency_p50_ms`
  ).all().map(r => r.latency_p50_ms)

  let medianLatency = null
  let p90Latency = null
  if (latencyRows.length > 0) {
    medianLatency = latencyRows[Math.floor(latencyRows.length / 2)]
    p90Latency = latencyRows[Math.floor(latencyRows.length * 0.9)]
  }

  // Category counts (healthy endpoints per category per protocol)
  const categoryRows = database.prepare(
    `SELECT category, protocol, COUNT(*) as count FROM services WHERE ${ACTIVE_FILTER} AND health_status = 'healthy' AND category IS NOT NULL AND is_template = 0 AND is_demo = 0 GROUP BY category, protocol`
  ).all()
  const categories = {}
  for (const row of categoryRows) {
    if (!categories[row.category]) categories[row.category] = {}
    categories[row.category][row.protocol] = row.count
  }

  // Top providers by reliability (min 2 endpoints, exclude templates/demos)
  const providerRows = database.prepare(
    `SELECT url, name, protocol, reliability_score, latency_p50_ms, health_status FROM services WHERE ${ACTIVE_FILTER} AND reliability_score IS NOT NULL AND is_template = 0 AND is_demo = 0`
  ).all()

  const providerMap = new Map()
  for (const svc of providerRows) {
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    if (!providerMap.has(host)) {
      providerMap.set(host, { provider: host, protocols: new Set(), scores: [], latencies: [], healthyCount: 0, totalCount: 0 })
    }
    const p = providerMap.get(host)
    p.protocols.add(svc.protocol)
    p.scores.push(svc.reliability_score)
    if (svc.latency_p50_ms != null) p.latencies.push(svc.latency_p50_ms)
    if (svc.health_status === 'healthy') p.healthyCount++
    p.totalCount++
  }

  const topProviders = [...providerMap.values()]
    .filter(p => p.totalCount >= 2)
    .map(p => ({
      provider: p.provider,
      protocols: [...p.protocols],
      avg_reliability: Math.round((p.scores.reduce((a, b) => a + b, 0) / p.scores.length) * 10) / 10,
      endpoints: p.totalCount,
      healthy_pct: Math.round((p.healthyCount / p.totalCount) * 100),
      avg_latency: p.latencies.length > 0 ? Math.round(p.latencies.reduce((a, b) => a + b, 0) / p.latencies.length) : null,
    }))
    .sort((a, b) => b.avg_reliability - a.avg_reliability)
    .slice(0, 20)

  // Upsert
  database.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (
      snapshot_date, total_endpoints, verified_endpoints, total_providers, verified_providers,
      healthy_endpoints, degraded_endpoints, down_endpoints,
      l402_endpoints, l402_verified, l402_healthy, l402_providers,
      x402_endpoints, x402_verified, x402_healthy, x402_providers,
      mpp_endpoints, mpp_verified, mpp_healthy, mpp_providers,
      avg_reliability_score, median_latency_ms, p90_latency_ms,
      categories_json, top_providers_json
    ) VALUES (
      @snapshot_date, @total_endpoints, @verified_endpoints, @total_providers, @verified_providers,
      @healthy_endpoints, @degraded_endpoints, @down_endpoints,
      @l402_endpoints, @l402_verified, @l402_healthy, @l402_providers,
      @x402_endpoints, @x402_verified, @x402_healthy, @x402_providers,
      @mpp_endpoints, @mpp_verified, @mpp_healthy, @mpp_providers,
      @avg_reliability_score, @median_latency_ms, @p90_latency_ms,
      @categories_json, @top_providers_json
    )
  `).run({
    snapshot_date: today,
    total_endpoints: totalEndpoints,
    verified_endpoints: verifiedEndpoints,
    total_providers: allProviderSets.total.size,
    verified_providers: providerSets.total.size,
    healthy_endpoints: healthMap.healthy,
    degraded_endpoints: healthMap.degraded,
    down_endpoints: healthMap.down,
    l402_endpoints: protocolStats.L402.total,
    l402_verified: protocolStats.L402.verified,
    l402_healthy: protocolStats.L402.healthy,
    l402_providers: providerSets.L402.size,
    x402_endpoints: protocolStats.x402.total,
    x402_verified: protocolStats.x402.verified,
    x402_healthy: protocolStats.x402.healthy,
    x402_providers: providerSets.x402.size,
    mpp_endpoints: protocolStats.MPP.total,
    mpp_verified: protocolStats.MPP.verified,
    mpp_healthy: protocolStats.MPP.healthy,
    mpp_providers: providerSets.MPP.size,
    avg_reliability_score: reliabilityRow.avg_rel != null ? Math.round(reliabilityRow.avg_rel * 10) / 10 : null,
    median_latency_ms: medianLatency,
    p90_latency_ms: p90Latency,
    categories_json: JSON.stringify(categories),
    top_providers_json: JSON.stringify(topProviders),
  })

  return { snapshot_date: today, total_endpoints: totalEndpoints }
}

/**
 * Get the last N daily snapshots, sorted by date ascending.
 */
export function getSnapshots(database = db, days = 30) {
  const maxDays = Math.min(Math.max(1, days), 365)
  return database.prepare(
    `SELECT * FROM daily_snapshots ORDER BY snapshot_date DESC LIMIT ?`
  ).all(maxDays).reverse()
}

/**
 * Query data for the reliability scoreboard (provider-level and endpoint-level).
 */
export function getScoreboardData(database = db) {
  // Health multiplier: healthy endpoints contribute full score, degraded half, down/unknown zero
  function healthMultiplier(status) {
    if (status === 'healthy') return 1.0
    if (status === 'degraded') return 0.5
    return 0.0
  }

  // Endpoint-level data — per-protocol queries to ensure balanced representation
  const endpoints = []
  for (const proto of ['L402', 'x402', 'MPP']) {
    const rows = database.prepare(
      `SELECT id, name, url, protocol, reliability_score, latency_p50_ms, health_status, price_sats, price_usd
       FROM services
       WHERE ${ACTIVE_FILTER}
         AND is_template = 0 AND is_demo = 0
         AND reliability_score IS NOT NULL
         AND protocol = ?
       ORDER BY reliability_score DESC
       LIMIT 35`
    ).all(proto)
    endpoints.push(...rows)
  }

  // Add effective_score to each endpoint and re-sort
  for (const ep of endpoints) {
    ep.effective_score = Math.round(ep.reliability_score * healthMultiplier(ep.health_status) * 10) / 10
  }
  endpoints.sort((a, b) => b.effective_score - a.effective_score)

  // Build provider-level aggregation in JS
  const providerMap = new Map()
  for (const svc of endpoints) {
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    if (!providerMap.has(host)) {
      providerMap.set(host, { provider: host, protocols: new Set(), scores: [], effectiveScores: [], latencies: [], healthyCount: 0, totalCount: 0 })
    }
    const p = providerMap.get(host)
    p.protocols.add(svc.protocol)
    p.scores.push(svc.reliability_score)
    p.effectiveScores.push(svc.effective_score)
    if (svc.latency_p50_ms != null) p.latencies.push(svc.latency_p50_ms)
    if (svc.health_status === 'healthy') p.healthyCount++
    p.totalCount++
  }

  const providers = [...providerMap.values()]
    .filter(p => p.totalCount >= 2)
    .map(p => ({
      provider: p.provider,
      protocols: [...p.protocols],
      avg_reliability: Math.round((p.scores.reduce((a, b) => a + b, 0) / p.scores.length) * 10) / 10,
      avg_effective: Math.round((p.effectiveScores.reduce((a, b) => a + b, 0) / p.effectiveScores.length) * 10) / 10,
      endpoints: p.totalCount,
      healthy_pct: Math.round((p.healthyCount / p.totalCount) * 100),
      avg_latency: p.latencies.length > 0 ? Math.round(p.latencies.reduce((a, b) => a + b, 0) / p.latencies.length) : null,
    }))
    .sort((a, b) => b.avg_effective - a.avg_effective)
    .slice(0, 50)

  return { providers, endpoints }
}

/**
 * Query data for the latency distribution histogram.
 */
export function getLatencyData(database = db) {
  const rows = database.prepare(
    `SELECT protocol, latency_p50_ms
     FROM services
     WHERE ${ACTIVE_FILTER}
       AND health_status = 'healthy'
       AND latency_p50_ms IS NOT NULL
       AND is_template = 0 AND is_demo = 0`
  ).all()

  const buckets = [
    { label: '<100ms', min: 0, max: 100 },
    { label: '100-200ms', min: 100, max: 200 },
    { label: '200-500ms', min: 200, max: 500 },
    { label: '500ms-1s', min: 500, max: 1000 },
    { label: '1-2s', min: 1000, max: 2000 },
    { label: '2-5s', min: 2000, max: 5000 },
    { label: '>5s', min: 5000, max: Infinity },
  ]

  const data = buckets.map(b => ({
    label: b.label,
    L402: 0,
    x402: 0,
    MPP: 0,
  }))

  const perProtocol = { L402: [], x402: [], MPP: [] }

  for (const row of rows) {
    const latency = row.latency_p50_ms
    if (perProtocol[row.protocol]) perProtocol[row.protocol].push(latency)
    for (let i = 0; i < buckets.length; i++) {
      if (latency >= buckets[i].min && latency < buckets[i].max) {
        if (data[i][row.protocol] !== undefined) data[i][row.protocol]++
        break
      }
    }
  }

  // Compute summary stats
  const allLatencies = rows.map(r => r.latency_p50_ms).sort((a, b) => a - b)
  const median = allLatencies.length > 0 ? allLatencies[Math.floor(allLatencies.length / 2)] : null
  const under500 = allLatencies.length > 0 ? Math.round(allLatencies.filter(l => l < 500).length / allLatencies.length * 100) : 0

  // Fastest protocol
  let fastestProtocol = null
  let fastestMedian = Infinity
  for (const [proto, latencies] of Object.entries(perProtocol)) {
    if (latencies.length === 0) continue
    latencies.sort((a, b) => a - b)
    const m = latencies[Math.floor(latencies.length / 2)]
    if (m < fastestMedian) {
      fastestMedian = m
      fastestProtocol = proto
    }
  }

  // Per-protocol summary
  const protocolSummary = {}
  for (const [proto, latencies] of Object.entries(perProtocol)) {
    if (latencies.length === 0) {
      protocolSummary[proto] = { median: null, p90: null, under500: 0 }
      continue
    }
    latencies.sort((a, b) => a - b)
    protocolSummary[proto] = {
      median: latencies[Math.floor(latencies.length / 2)],
      p90: latencies[Math.floor(latencies.length * 0.9)],
      under500: Math.round(latencies.filter(l => l < 500).length / latencies.length * 100),
    }
  }

  return { buckets: data, median, under500, fastestProtocol, fastestMedian: fastestMedian === Infinity ? null : fastestMedian, protocolSummary }
}

/**
 * Query data for the category gap map.
 */
export function getCategoryGapData(database = db) {
  const rows = database.prepare(
    `SELECT category, protocol, COUNT(*) as count
     FROM services
     WHERE ${ACTIVE_FILTER}
       AND health_status = 'healthy'
       AND category IS NOT NULL
       AND category != 'uncategorized'
       AND is_template = 0 AND is_demo = 0
     GROUP BY category, protocol
     ORDER BY count DESC`
  ).all()

  // Consolidate subcategories: "crypto/defi" → "crypto", "ai/llm" → "ai"
  const CATEGORY_SYNONYMS = {
    'real-time-data': 'data',
  }
  const categoryMap = new Map()
  for (const row of rows) {
    let parentCategory = row.category.split('/')[0]
    parentCategory = CATEGORY_SYNONYMS[parentCategory] || parentCategory
    if (!categoryMap.has(parentCategory)) {
      categoryMap.set(parentCategory, { category: parentCategory, L402: 0, x402: 0, MPP: 0, total: 0 })
    }
    const entry = categoryMap.get(parentCategory)
    if (entry[row.protocol] !== undefined) entry[row.protocol] += row.count
    entry.total += row.count
  }

  // Filter: min 10 total healthy endpoints
  const grid = [...categoryMap.values()]
    .filter(c => c.total >= 10)
    .sort((a, b) => b.total - a.total)

  // Find opportunity gaps — only for categories where at least one protocol has ≥20
  const opportunities = []
  const protocols = ['L402', 'x402', 'MPP']
  for (const cat of grid) {
    const maxProto = Math.max(cat.L402, cat.x402, cat.MPP)
    if (maxProto < 20) continue
    for (const proto of protocols) {
      if (cat[proto] === 0) {
        opportunities.push({ category: cat.category, protocol: proto, count: 0 })
      } else if (cat[proto] <= 2) {
        opportunities.push({ category: cat.category, protocol: proto, count: cat[proto] })
      }
    }
  }
  opportunities.sort((a, b) => a.count - b.count)

  return { grid, opportunities: opportunities.slice(0, 5) }
}
