import { Router } from 'express'
import db, { getVecIndexStats } from '../../db.js'
import { extractHostname } from '../../services/url-normalize.js'
import { getSnapshots } from '../../services/daily-snapshot.js'
import { getQueueDepth, getCircuitState, getQueryEmbeddingCacheStats } from '../../services/embeddings.js'
import { LISTED, countQuarantined } from '../../services/visibility.js'
import { bazaarDrift } from '../../aggregators/bazaar-presence.js'

const router = Router()

router.get('/health', (req, res) => {
  try {
    const ACTIVE_FILTER = `WHERE ${LISTED}`

    const total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER}`).get().c

    const byProtocol = {}
    db.prepare(`SELECT protocol, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY protocol`).all()
      .forEach(r => { byProtocol[r.protocol] = r.c })

    const byHealth = {}
    db.prepare(`SELECT health_status, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY health_status`).all()
      .forEach(r => { byHealth[r.health_status] = r.c })

    const bySource = {}
    db.prepare(`SELECT source, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY source`).all()
      .forEach(r => { bySource[r.source] = r.c })

    // Distinct services (by hostname) and providers — computed in JS since SQLite
    // lacks a reliable URL hostname extractor. Hostname = provider key.
    const allServices = db.prepare(`SELECT url, protocol, is_template, is_demo FROM services ${ACTIVE_FILTER}`).all()
    const hostnameSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
    const rawProviders = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
    const filteredProviders = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }

    for (const svc of allServices) {
      const host = extractHostname(svc.url)
      hostnameSets.total.add(host)
      hostnameSets[svc.protocol]?.add(host)

      rawProviders.total.add(host)
      rawProviders[svc.protocol]?.add(host)

      if (!svc.is_template && !svc.is_demo) {
        filteredProviders.total.add(host)
        filteredProviders[svc.protocol]?.add(host)
      }
    }

    const excludedTemplates = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_template = 1').get().c
    const excludedDemos = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_demo = 1').get().c
    const excludedQuarantined = countQuarantined(db)
    const drift = bazaarDrift(db)

    const lastBazaarSync = db.prepare(
      "SELECT MAX(updated_at) as t FROM services WHERE source = 'bazaar'"
    ).get()?.t || null

    const lastSatringSync = db.prepare(
      "SELECT MAX(updated_at) as t FROM services WHERE source = 'satring'"
    ).get()?.t || null

    const lastL402AppsSync = db.prepare(
      "SELECT MAX(updated_at) as t FROM services WHERE source LIKE '%l402apps%'"
    ).get()?.t || null

    const lastMppSync = db.prepare(
      "SELECT MAX(updated_at) as t FROM services WHERE source = 'mpp'"
    ).get()?.t || null

    const lastHealthCheck = db.prepare(
      'SELECT MAX(checked_at) as t FROM health_checks'
    ).get()?.t || null

    res.json({
      status: 'ok',
      total_endpoints: total,
      distinct_services: hostnameSets.total.size,
      distinct_providers_raw: rawProviders.total.size,
      distinct_providers: filteredProviders.total.size,
      excluded_templates: excludedTemplates,
      excluded_demos: excludedDemos,
      excluded_quarantined: excludedQuarantined,
      excluded_retired: drift.retired,
      bazaar: { upstream_total: drift.upstream_total, upstream_missing: drift.upstream_missing, last_complete_pass: drift.last_complete_pass, last_complete_pass_at: drift.last_complete_pass_at },
      by_protocol: Object.fromEntries(
        Object.entries(byProtocol).map(([proto, endpoints]) => [proto, {
          endpoints,
          services: hostnameSets[proto]?.size || 0,
          providers_raw: rawProviders[proto]?.size || 0,
          providers: filteredProviders[proto]?.size || 0,
        }])
      ),
      by_health: byHealth,
      by_source: bySource,
      last_bazaar_sync: lastBazaarSync,
      last_satring_sync: lastSatringSync,
      last_l402apps_sync: lastL402AppsSync,
      last_mpp_sync: lastMppSync,
      last_health_check_run: lastHealthCheck,
      embedding_queue_depth: getQueueDepth(),
      ...(() => {
        const cs = getCircuitState()
        return {
          embedding_circuit: cs.circuit,
          embedding_circuit_failures: cs.failures,
          embedding_circuit_opened_at: cs.openedAt ? new Date(cs.openedAt).toISOString() : null,
          embedding_half_open_trial: cs.halfOpenTrialInFlight,
        }
      })(),
      // Index coverage, so a backfill can be confirmed from outside the container.
      // vec_indexed well below vec_embeddings means semantic search is running blind.
      ...(() => {
        const vs = getVecIndexStats()
        const qc = getQueryEmbeddingCacheStats()
        return {
          vec_available: vs.available,
          vec_embeddings: vs.embeddings,
          vec_indexed: vs.indexed,
          query_embedding_cache: { size: qc.size, hits: qc.hits, misses: qc.misses },
        }
      })(),
    })
  } catch (err) {
    console.error('GET /api/v1/health error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/stats/snapshots
router.get('/stats/snapshots', (req, res) => {
  try {
    const days = Math.min(Math.max(1, parseInt(req.query.days) || 30), 365)
    const snapshots = getSnapshots(db, days)
    res.json({ snapshots, count: snapshots.length })
  } catch (err) {
    console.error('GET /api/v1/stats/snapshots error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/categories
router.get('/categories', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT category, protocol, COUNT(*) as count
       FROM services
       WHERE ${LISTED}
         AND category IS NOT NULL
         AND is_template = 0 AND is_demo = 0
       GROUP BY category, protocol
       ORDER BY count DESC`
    ).all()

    // Build tree: { "crypto": { L402: 5, x402: 200, MPP: 10, total: 215, subcategories: { "defi": {...} } } }
    const tree = {}
    for (const row of rows) {
      const parts = row.category.split('/')
      const top = parts[0]
      const sub = parts.length > 1 ? parts.slice(1).join('/') : null

      if (!tree[top]) tree[top] = { L402: 0, x402: 0, MPP: 0, total: 0, subcategories: {} }
      tree[top][row.protocol] = (tree[top][row.protocol] || 0) + row.count
      tree[top].total += row.count

      if (sub) {
        if (!tree[top].subcategories[sub]) tree[top].subcategories[sub] = { L402: 0, x402: 0, MPP: 0, total: 0 }
        tree[top].subcategories[sub][row.protocol] = (tree[top].subcategories[sub][row.protocol] || 0) + row.count
        tree[top].subcategories[sub].total += row.count
      }
    }

    res.json({ categories: tree })
  } catch (err) {
    console.error('GET /api/v1/categories error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

export default router
