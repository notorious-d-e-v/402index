import { Router } from 'express'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import db, { logQuery } from '../db.js'
import { queryServices, PAGE_COLUMNS, API_COLUMNS } from '../queries/services.js'
import { getCachedBtcUsdRate } from '../services/btc-price.js'
import { homePage } from '../views/home.js'
import { detailPage } from '../views/detail.js'
import { aboutPage } from '../views/about.js'
import { apiDocsPage } from '../views/api-docs.js'
import { adminPage } from '../views/admin.js'
import { demoPage } from '../views/demo.js'
import { feedXml } from '../views/feed.js'
import { opportunitiesPage } from '../views/opportunities.js'
import { verifyPage } from '../views/verify.js'
import { findOpportunities } from '../services/opportunities.js'
import { layout } from '../views/layout.js'
import { statsPage } from '../views/stats.js'
import { statsSimplePage } from '../views/stats-simple.js'
import { getScoreboardData, getLatencyData, getCategoryGapData } from '../services/daily-snapshot.js'
import { LISTED, NOT_QUARANTINED, isHostQuarantined } from '../services/visibility.js'

const router = Router()

// robots.txt
router.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin/*
Disallow: /stats-dev

Sitemap: https://402index.io/sitemap.xml

# AI agent discovery
# See https://402index.io/llms.txt for machine-readable directory info
# See https://402index.io/api/v1/openapi.json for OpenAPI spec
`)
})

// sitemap.xml — dynamic from database
router.get('/sitemap.xml', (req, res) => {
  const staticPages = [
    { loc: 'https://402index.io/', priority: '1.0' },
    { loc: 'https://402index.io/stats', priority: '1.0' },
    { loc: 'https://402index.io/directory', priority: '1.0' },
    { loc: 'https://402index.io/about', priority: '0.8' },
    { loc: 'https://402index.io/api-docs', priority: '0.8' },
    { loc: 'https://402index.io/verify', priority: '0.7' },
  ]

  const services = db.prepare(
    `SELECT id, updated_at FROM services
     WHERE ${LISTED}
       AND is_template = 0 AND is_demo = 0
     ORDER BY updated_at DESC
     LIMIT 1000`
  ).all()

  const urls = staticPages.map(p =>
    `  <url><loc>${p.loc}</loc><changefreq>daily</changefreq><priority>${p.priority}</priority></url>`
  )

  for (const svc of services) {
    const lastmod = svc.updated_at ? `<lastmod>${svc.updated_at.split(' ')[0]}</lastmod>` : ''
    urls.push(`  <url><loc>https://402index.io/service/${svc.id}</loc>${lastmod}<changefreq>daily</changefreq><priority>0.6</priority></url>`)
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`

  res.set('Content-Type', 'application/xml')
  res.set('Cache-Control', 'public, max-age=3600')
  res.send(xml)
})

// RSS feed — public, no auth, no rate limit
router.get('/feed.xml', (req, res) => {
  const { protocol, health, type } = req.query
  const opts = { protocol, health, sort: 'registered_at', order: 'desc', rawLimit: '100', rawOffset: '0' }
  const { services } = queryServices(db, opts, API_COLUMNS)

  let filtered = services
  if (type === 'new') {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
    filtered = services.filter(s => s.registered_at >= cutoff)
  }

  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
  const selfUrl = `https://402index.io/feed.xml${qs}`

  res.set('Content-Type', 'application/rss+xml; charset=utf-8')
  res.send(feedXml({ services: filtered, selfUrl, filters: { protocol, health, type } }))
})

// SKILL.md — agent skill for discovering and paying for APIs
router.get('/SKILL.md', (req, res) => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const skillPath = join(__dirname, '..', '..', 'SKILL.md')
  try {
    const content = readFileSync(skillPath, 'utf-8')
    res.set('Content-Type', 'text/markdown; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=3600')
    res.send(content)
  } catch {
    res.status(404).send('SKILL.md not found')
  }
})

// llms.txt — machine-readable project summary for AI agents
router.get('/llms.txt', (req, res) => {
  const ACTIVE_FILTER = LISTED
  const totalEndpoints = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER}`).get().c
  const l402Count = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = 'L402'`).get().c
  const x402Count = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = 'x402'`).get().c
  const mppCount = db.prepare(`SELECT COUNT(*) as c FROM services WHERE ${ACTIVE_FILTER} AND protocol = 'MPP'`).get().c

  res.set('Content-Type', 'text/plain; charset=utf-8')
  res.send(`# 402 Index

> Protocol-agnostic directory of paid APIs (L402 + x402 + MPP) for AI agents.

Live at: https://402index.io
Currently indexing: ${totalEndpoints} endpoints (${l402Count} L402, ${x402Count} x402, ${mppCount} MPP)

## API

Base URL: https://402index.io/api/v1
API_SPEC: https://402index.io/api/v1/openapi.json
API_DOCS_MD: https://402index.io/api/v1/docs.md

- GET /api/v1/services — Search and filter endpoints. Params: protocol, category, health, source, q, sort, limit, offset, l402_format, lnget_compatible
- GET /api/v1/services/:id — Full service details with health check history
- GET /api/v1/categories — Category tree with counts
- GET /api/v1/health — System health, sync status, provider counts
- GET /api/v1/opportunities — Ecosystem gap analysis (coverage, protocol, provider gaps)
- POST /api/v1/register — Register an L402 endpoint (verified via probe)
- GET /api/v1/export.csv — Full directory CSV export (L402 payment required)

## Distribution

- GET /feed.xml — RSS 2.0 feed with l402:service XML namespace. Params: protocol, health, type
- POST /api/v1/webhooks — Register for real-time notifications (HMAC-SHA256 signed)
- GET /api/v1/webhooks/:id — Check webhook status (X-Webhook-Secret header)
- DELETE /api/v1/webhooks/:id — Remove webhook (X-Webhook-Secret header)

## MCP Server

An MCP server is available for direct AI assistant integration.
Tools: search_services, get_service_detail, list_categories, get_directory_stats
Setup: See mcp-server/ directory or npm install @402index/mcp-server

## Protocols

- L402: Lightning-native HTTP 402 paywall. Returns WWW-Authenticate header with macaroon + invoice.
- x402: Chain-agnostic HTTP 402 paywall (Base, Solana). Returns payment requirements in structured header.
- MPP: Machine Payments Protocol (Stripe/Tempo). Returns WWW-Authenticate: Payment header with intent and method.

`)
})

// Homepage: ecosystem overview (formerly /demo)
router.get('/', (req, res) => {
  const ACTIVE_FILTER = `WHERE ${LISTED}`

  // Gather stats
  const totalIndexed = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER}`).get().c

  const verifiedCount = db.prepare(
    `SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND ((protocol = 'x402' AND x402_payment_valid = 1) OR (protocol = 'L402' AND health_status = 'healthy') OR (protocol = 'MPP' AND health_status = 'healthy'))`
  ).get().c

  const healthRows = db.prepare(`SELECT health_status, COUNT(*) as c FROM services ${ACTIVE_FILTER} GROUP BY health_status`).all()
  const healthMap = { healthy: 0, degraded: 0, down: 0, unknown: 0 }
  for (const row of healthRows) {
    healthMap[row.health_status] = row.c
  }

  // Distinct providers (excluding templates/demos)
  const allUrls = db.prepare(`SELECT url, protocol, is_template, is_demo, x402_payment_valid, health_status FROM services ${ACTIVE_FILTER}`).all()
  const providerSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
  const allProviderSets = { total: new Set(), L402: new Set(), x402: new Set(), MPP: new Set() }
  for (const svc of allUrls) {
    if (svc.is_template || svc.is_demo) continue
    let host
    try { host = new URL(svc.url).hostname } catch { continue }
    allProviderSets.total.add(host)
    allProviderSets[svc.protocol]?.add(host)
    // Verified providers: L402 healthy, x402 payment_valid=1, MPP healthy
    if ((svc.protocol === 'L402' && svc.health_status === 'healthy') ||
        (svc.protocol === 'x402' && svc.x402_payment_valid === 1) ||
        (svc.protocol === 'MPP' && svc.health_status === 'healthy')) {
      providerSets.total.add(host)
      providerSets[svc.protocol]?.add(host)
    }
  }

  // Protocol breakdowns
  const l402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402'`).get().c
  const l402Healthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'L402' AND health_status = 'healthy'`).get().c
  const x402Total = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402'`).get().c
  const x402Verified = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402' AND x402_payment_valid = 1`).get().c
  const x402Healthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'x402' AND health_status = 'healthy'`).get().c
  const mppTotal = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP'`).get().c
  const mppHealthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP' AND health_status = 'healthy'`).get().c
  const mppVerified = mppHealthy
  const mppGatewayTotal = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP' AND (hostname LIKE '%.mpp.tempo.xyz' OR hostname LIKE '%.mpp.paywithlocus.com')`).get().c
  const mppGatewayHealthy = db.prepare(`SELECT COUNT(*) as c FROM services ${ACTIVE_FILTER} AND protocol = 'MPP' AND health_status = 'healthy' AND (hostname LIKE '%.mpp.tempo.xyz' OR hostname LIKE '%.mpp.paywithlocus.com')`).get().c

  const lastHealthCheck = db.prepare('SELECT MAX(checked_at) as t FROM health_checks').get()?.t || null

  const stats = {
    totalIndexed,
    verified: verifiedCount,
    distinctProviders: allProviderSets.total.size,
    verifiedProviders: providerSets.total.size,
    ...healthMap,
    lastHealthCheck,
    l402: { endpoints: l402Total, verified: l402Healthy, healthy: l402Healthy, providers: providerSets.L402.size, allProviders: allProviderSets.L402.size },
    x402: { endpoints: x402Total, verified: x402Verified, healthy: x402Healthy, providers: providerSets.x402.size, allProviders: allProviderSets.x402.size },
    mpp: { endpoints: mppTotal, verified: mppVerified, healthy: mppHealthy, providers: providerSets.MPP.size, allProviders: allProviderSets.MPP.size, gatewayEndpoints: mppGatewayTotal, gatewayVerified: mppGatewayHealthy },
  }

  // Featured endpoints for Agent Discovery default view
  const FEATURED_IDS = [
    // L402 — 3 endpoints (Mutinynet first to showcase Lightning)
    'c2323cdb-8d35-44e1-a093-209beec8afa9', // Mutinynet Faucet (healthy, reliability 95)
    'a63c1e77-cab0-4740-8d82-5a6fe451794f', // L402 Apps: Get APIs Directory (healthy, reliability 95)
    '831e8bac-0197-426c-b826-500384f23673', // Sats4AI: File Conversion (healthy, reliability 95)
    // x402 — 4 endpoints
    '6a46b58c-8829-4e1b-adaa-fd4333f48bcf', // AgentMail: Create a draft email (healthy, reliability 95)
    '71972e33-e5c0-47df-81c9-5c74bd600554', // Nansen: Find related wallets (healthy, reliability 100)
    '9387a1ec-e775-491a-8c8a-159b76979625', // Nansen: Who bought/sold token (healthy, reliability 100)
    'c467f0c6-db53-4f61-be26-999012092691', // Firecrawl web scraper (healthy, reliability 95)
    // MPP — 3 endpoints
    'bdbf6a07-9108-4fe4-b35b-eea76b824d3e', // Anthropic: Create messages with Claude (degraded, brand recognition)
    '8464d51f-706f-4fd8-b377-acbe5075624f', // AgentMail: Create inbox (healthy, reliability 87)
    '040a83af-438a-4683-ae85-d9154edfdf33', // AgentMail: Create pod (healthy, reliability 87)
  ]
  const placeholders = FEATURED_IDS.map(() => '?').join(',')
  const featuredServices = db.prepare(
    `SELECT ${API_COLUMNS} FROM services WHERE id IN (${placeholders}) AND (status = 'active' OR status IS NULL) AND ${NOT_QUARANTINED} AND health_status != 'down'`
  ).all(...FEATURED_IDS)

  // Preserve FEATURED_IDS order (SQL WHERE IN doesn't guarantee order)
  const idOrder = new Map(FEATURED_IDS.map((id, i) => [id, i]))
  featuredServices.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999))

  // Probe sample for flow visualization
  const probeSample = buildProbeSample(db, 'L402')

  res.send(demoPage({ stats, probeSample, featuredServices, meta: {
    canonical: '/',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: '402 Index',
      url: 'https://402index.io',
      description: 'Protocol-agnostic directory of paid APIs (L402, x402, MPP) for AI agents. Indexed, verified, and searchable.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  } }))
})

// Stats page (simplified — latency table + gap map only)
router.get('/stats', (req, res) => {
  const latency = getLatencyData(db)
  const categoryGap = getCategoryGapData(db)
  res.send(statsSimplePage({ latency, categoryGap }))
})

// Stats dev page (full scoreboard + latency + gap map — hidden, not in nav)
router.get('/stats-dev', (req, res) => {
  const scoreboard = getScoreboardData(db)
  const latency = getLatencyData(db)
  const categoryGap = getCategoryGapData(db)
  res.send(statsPage({ scoreboard, latency, categoryGap }))
})

// Directory page (formerly /)
router.get('/directory', (req, res) => {
  const startTime = Date.now()
  const { protocol, category, health, source, q, featured, sort, payment_valid, limit: rawLimit, offset: rawOffset } = req.query
  const filters = { protocol, category, health, source, q, featured: featured === 'true', sort, payment_valid: payment_valid === 'true' }

  const { services, total, limit, offset } = queryServices(db, {
    protocol, category, health, source, q, featured, sort, payment_valid, order: sort ? 'desc' : undefined, rawLimit, rawOffset,
  }, PAGE_COLUMNS)

  const stats = { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 }

  // Categories for dropdown
  const categories = db.prepare(
    'SELECT category, COUNT(*) as count FROM services WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC'
  ).all()

  const btcUsdRate = getCachedBtcUsdRate()
  res.send(homePage({ services, total, limit, offset, filters, stats, categories, btcUsdRate }))

  logQuery({
    queryText: q || null,
    filters: JSON.stringify({ protocol, category, health, source, featured, sort, payment_valid }),
    resultCount: total,
    responseTimeMs: Date.now() - startTime,
    userAgent: req.get('User-Agent') || null,
  })
})

// Service detail
router.get('/service/:id', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND (provider_deleted = 0 OR provider_deleted IS NULL)').get(req.params.id)
  if (!service) {
    return res.status(404).send(layout('Not Found', '<div class="container"><h1>Service not found</h1><p><a href="/">Back to directory</a></p></div>'))
  }

  const health_checks = db.prepare(
    'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
  ).all(req.params.id)

  const related_services = db.prepare(
    `SELECT id, protocol, health_status, price_sats, price_usd, payment_asset, payment_network, reliability_score, uptime_30d, latency_p50_ms
     FROM services
     WHERE url = ? AND id != ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)`
  ).all(service.url, service.id)

  res.send(detailPage({ ...service, health_checks, related_services, quarantine: isHostQuarantined(db, service.hostname) }))
})

// About
router.get('/about', (req, res) => {
  res.send(aboutPage())
})

// API docs
router.get('/api-docs', (req, res) => {
  res.send(apiDocsPage())
})

// Domain verification guide
router.get('/verify', (req, res) => {
  res.send(verifyPage())
})

// Demo redirect (301 to homepage)
router.get('/demo', (req, res) => {
  res.redirect(301, '/')
})

// Admin dashboard — auth is client-side via API calls.
// The /api/v1/admin/* endpoints are server-side gated at src/server.js:97.
// Do NOT add Bearer-token middleware here — browsers do not send Bearer
// tokens on plain GET, and this route would be unreachable from a browser.
// See #184 / PR #28 for historical context; defense-in-depth for
// this HTML page (if ever desired) must use cookie-session or HTTP Basic
// Auth, not Bearer.
router.get('/admin', (req, res) => {
  res.send(adminPage())
})

// Opportunities page
router.get('/opportunities', (req, res) => {
  const opportunities = findOpportunities(db, { protocol: req.query.protocol })
  res.send(opportunitiesPage({ opportunities, protocol: req.query.protocol }))
})

// ─── Probe Sample Builder ─────────────────────────────────────────────────────

export function buildProbeSample(database, protocol = 'L402') {
  const proto = protocol === 'x402' ? 'x402' : protocol === 'MPP' ? 'MPP' : 'L402'

  // Find a healthy service with recent health check data
  const service = database.prepare(`
    SELECT id, name, url, protocol, price_sats, price_usd, category, provider, payment_asset, payment_network
    FROM services
    WHERE (status = 'active' OR status IS NULL) AND ${NOT_QUARANTINED}
      AND protocol = ?
      AND health_status = 'healthy'
      AND reliability_score IS NOT NULL
    ORDER BY reliability_score DESC
    LIMIT 1
  `).get(proto)

  if (!service) {
    return buildStaticProbeSample(proto)
  }

  const healthCheck = database.prepare(`
    SELECT checked_at, status, response_time_ms, http_status
    FROM health_checks
    WHERE service_id = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(service.id)

  const flow = proto === 'MPP' ? {
    request: `GET ${service.url}`,
    responseStatus: 402,
    protocolHeaders: {
      MPP: `WWW-Authenticate: Payment id="<session-id>", realm="${service.provider || 'provider'}", method="tempo", intent="session", request="<base64-payment-details>"`,
    },
    retryHeader: 'Authorization: Payment <session-token>',
    successStatus: 200,
  } : proto === 'L402' ? {
    request: `GET ${service.url}`,
    responseStatus: 402,
    protocolHeaders: {
      L402: `WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc${service.price_sats || 100}n1..."`,
    },
    retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
    successStatus: 200,
  } : {
    request: `GET ${service.url}`,
    responseStatus: 402,
    protocolHeaders: {
      x402: `PAYMENT-REQUIRED: { "accepts": [{ "asset": "${service.payment_asset || 'USDC'}", "amount": "${service.price_usd ? Math.round(service.price_usd * 1000000) : '10000'}", "facilitator": "https://x402.org/facilitator" }] }`,
    },
    retryHeader: 'X-PAYMENT: <base64-encoded-signed-payment>',
    successStatus: 200,
  }

  return {
    service: {
      name: service.name,
      url: service.url,
      protocol: service.protocol,
      price_sats: service.price_sats,
      price_usd: service.price_usd,
      category: service.category,
      provider: service.provider,
    },
    healthCheck: healthCheck || {
      checked_at: null,
      status: 'unknown',
      response_time_ms: null,
      http_status: null,
    },
    flow,
  }
}

function buildStaticProbeSample(protocol) {
  if (protocol === 'MPP') {
    return {
      service: {
        name: 'Example MPP API',
        url: 'https://api.example.com/resource',
        protocol: 'MPP',
        price_sats: null,
        price_usd: 0.002,
        category: 'ai',
        provider: 'Example',
      },
      healthCheck: { checked_at: null, status: 'unknown', response_time_ms: null, http_status: null },
      flow: {
        request: 'GET https://api.example.com/resource',
        responseStatus: 402,
        protocolHeaders: {
          MPP: 'WWW-Authenticate: Payment id="sess_abc123", realm="example", method="tempo", intent="session", request="eyJhbW91bnQiOiIxMDAwMCJ9"',
        },
        retryHeader: 'Authorization: Payment <session-token>',
        successStatus: 200,
      },
    }
  }
  if (protocol === 'x402') {
    return {
      service: {
        name: 'Example x402 API',
        url: 'https://api.example.com/data',
        protocol: 'x402',
        price_sats: null,
        price_usd: 0.01,
        category: 'data',
        provider: 'Example',
      },
      healthCheck: { checked_at: null, status: 'unknown', response_time_ms: null, http_status: null },
      flow: {
        request: 'GET https://api.example.com/data',
        responseStatus: 402,
        protocolHeaders: {
          x402: 'PAYMENT-REQUIRED: { "accepts": [{ "asset": "USDC", "amount": "10000", "facilitator": "https://x402.org/facilitator" }] }',
        },
        retryHeader: 'X-PAYMENT: <base64-encoded-signed-payment>',
        successStatus: 200,
      },
    }
  }
  return {
    service: {
      name: 'Example L402 API',
      url: 'https://api.example.com/weather',
      protocol: 'L402',
      price_sats: 10,
      price_usd: null,
      category: 'data/weather',
      provider: 'Example',
    },
    healthCheck: { checked_at: null, status: 'unknown', response_time_ms: null, http_status: null },
    flow: {
      request: 'GET https://api.example.com/weather',
      responseStatus: 402,
      protocolHeaders: {
        L402: 'WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc100n1..."',
      },
      retryHeader: 'Authorization: L402 <macaroon>:<preimage>',
      successStatus: 200,
    },
  }
}

export default router
