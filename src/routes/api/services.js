import { Router } from 'express'
import db, { logQuery } from '../../db.js'
import { queryServicesHybrid, buildServiceQuery, API_COLUMNS } from '../../queries/services.js'
import { getCachedBtcUsdRate } from '../../services/btc-price.js'
import { getProvider } from '../../services/l402-provider.js'
import { sendGatewayUnavailable } from '../../services/l402-degraded.js'

const router = Router()

router.get('/services', async (req, res) => {
  const startTime = Date.now()
  try {
    const { limit: rawLimit, offset: rawOffset, ...filters } = req.query
    const result = await queryServicesHybrid(db, { ...filters, rawLimit, rawOffset }, API_COLUMNS)

    // Set degraded header if semantic path failed
    const { degradedReason, semantic_cap, ...responseBody } = result
    if (degradedReason) {
      res.set('X-402index-Search-Degraded', degradedReason)
    }
    res.set('X-402index-Semantic-Cap', String(semantic_cap ?? false))
    res.json(responseBody)

    const { q, ...filterParams } = filters
    logQuery({
      queryText: q || null,
      filters: JSON.stringify(filterParams),
      resultCount: result.total,
      responseTimeMs: Date.now() - startTime,
      userAgent: req.get('User-Agent') || null,
      degradedReason: degradedReason || null,
    })
    if (degradedReason) {
      console.log(`[search] degraded: reason=${degradedReason} q=${q} time=${Date.now() - startTime}ms`)
    }
  } catch (err) {
    console.error('GET /api/v1/services error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// GET /api/v1/services/:id
router.get('/services/:id', (req, res) => {
  try {
    const service = db.prepare("SELECT * FROM services WHERE id = ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)").get(req.params.id)
    if (!service) {
      return res.status(404).json({ error: 'Service not found' })
    }

    const health_checks = db.prepare(
      'SELECT id, checked_at, status, response_time_ms, http_status, error_message FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 20'
    ).all(req.params.id)

    const related_services = db.prepare(
      `SELECT id, protocol, health_status, price_sats, price_usd, payment_asset, payment_network, reliability_score, uptime_30d, latency_p50_ms
       FROM services
       WHERE url = ? AND id != ? AND (status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)`
    ).all(service.url, service.id)

    res.json({ ...service, health_checks, related_services })
  } catch (err) {
    console.error('GET /api/v1/services/:id error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

// CSV export (L402-gated)
const CSV_COLUMNS = 'id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, health_status, uptime_30d, latency_p50_ms, last_checked, http_method, reliability_score'

function escapeCsvField(value) {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

router.get('/export.csv', async (req, res) => {
  if (!req.l402Verified) {
    const priceSats = parseInt(process.env.L402_PRICE_SATS) || 500
    const durationHours = parseInt(process.env.L402_DURATION_HOURS) || 24
    try {
      const provider = getProvider()
      const challenge = await provider.createChallenge(priceSats, durationHours)
      if (challenge) {
        const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`
        return res.status(402).set('WWW-Authenticate', wwwAuth).json({
          error: 'Payment Required',
          message: 'CSV export requires L402 payment. Pay the Lightning invoice to download.',
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          payment_hash: challenge.paymentHash,
          price_sats: priceSats,
          duration_hours: durationHours,
        })
      }
    } catch (err) {
      // The gateway answered with an error, or not at all. Either way there is no invoice
      // to hand over, and "Payment Required" without one strands the caller — on
      // 2026-08-03 this branch ran for hours while Boltz had swap creation disabled, and
      // the old bare 402 sent agents to `?l402=require`, which answered 429. Say what is
      // actually true instead.
      console.error('[export.csv] L402 challenge creation failed:', err.message)
      return sendGatewayUnavailable(res)
    }
    // No challenge and no error: the provider is the stub, meaning this deployment has no
    // payment gateway wired at all. That is a configuration state, not an outage, so it
    // stays a 402 — but it must not point at `?l402=require`, which needs the same absent
    // gateway and would only bounce the caller between two dead ends.
    return res.status(402).json({
      error: 'Payment Required',
      message: 'CSV export requires L402 payment. Include an L402 token in the Authorization header. This deployment has no Lightning payment gateway configured.',
    })
  }

  const { limit: _limit, offset: _offset, ...filters } = req.query
  const { where, params, orderBy } = buildServiceQuery({ ...filters, rawLimit: 10000, rawOffset: 0 })
  const services = db.prepare(`SELECT ${CSV_COLUMNS} FROM services ${where} ${orderBy}`).all(params)

  const btcUsdRate = getCachedBtcUsdRate()
  const headers = CSV_COLUMNS.split(', ')
  const csvRows = [headers.join(',')]

  for (const svc of services) {
    // Convert sats-only to USD
    if (svc.price_usd == null && svc.price_sats != null && btcUsdRate) {
      svc.price_usd = (svc.price_sats / 100_000_000) * btcUsdRate
    }
    csvRows.push(headers.map(h => escapeCsvField(svc[h])).join(','))
  }

  const date = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="402index-export-${date}.csv"`)
  res.send(csvRows.join('\n'))
})


export default router
