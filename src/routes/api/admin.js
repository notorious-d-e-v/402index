import { Router } from 'express'
import { randomUUID, randomBytes, createHash } from 'crypto'
import { mcpAllTime } from '../../services/query-log-rollup.js'
import db from '../../db.js'
import { extractHostname } from '../../services/url-normalize.js'
import { generateEmbedding } from '../../services/embeddings.js'
import { registerUpsert } from '../../services/service-registration.js'

const router = Router()

const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

const ADMIN_COLUMNS = `id, name, url, status, protocol, provider, category,
  price_sats, payment_asset, payment_network, contact_email,
  health_status, verified, domain_verified, approval_reason, registered_at`

const getPending = () => stmt('getPending', "SELECT * FROM services WHERE status = 'pending' ORDER BY registered_at DESC")

const getRecent = () => stmt('getRecent', `
  SELECT ${ADMIN_COLUMNS} FROM services ORDER BY registered_at DESC LIMIT @limit
`)

const searchServices = () => stmt('searchServices', `
  SELECT ${ADMIN_COLUMNS} FROM services
  WHERE (name LIKE @q ESCAPE '\\' OR url LIKE @q ESCAPE '\\' OR provider LIKE @q ESCAPE '\\' OR category LIKE @q ESCAPE '\\')
  ORDER BY registered_at DESC
  LIMIT @limit
`)

const deleteServiceTxn = db.transaction((id) => {
  db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
  return db.prepare('DELETE FROM services WHERE id = ?').run(id)
})

const approveService = () => stmt('approveService', `
  UPDATE services SET status = 'active', approval_reason = 'admin-manual', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

const rejectService = () => stmt('rejectService', `
  UPDATE services SET status = 'rejected', updated_at = datetime('now') WHERE id = @id AND status = 'pending'
`)

router.get('/admin/pending', (req, res) => {
  const services = getPending().all()
  res.json({ services, total: services.length })
})

router.get('/admin/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const services = getRecent().all({ limit })
  res.json({ services, total: services.length })
})

router.get('/admin/search', (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) {
    return res.status(400).json({ error: 'q param is required' })
  }
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const escaped = q.replace(/[%_\\]/g, '\\$&')
  const services = searchServices().all({ q: `%${escaped}%`, limit })
  res.json({ services, total: services.length })
})

router.delete('/admin/services/:id', (req, res) => {
  try {
    const result = deleteServiceTxn(req.params.id)
    if (result.changes === 0) {
      return res.status(404).json({ error: 'No service with that ID' })
    }
    res.json({ deleted: true, id: req.params.id })
  } catch (err) {
    console.error('[admin] Delete failed:', err.message)
    res.status(500).json({ error: 'Failed to delete service' })
  }
})

router.post('/admin/approve/:id', (req, res) => {
  const result = approveService().run({ id: req.params.id })
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending service with that ID' })
  }
  res.json({ message: 'Service approved', id: req.params.id })
})

router.post('/admin/reject/:id', (req, res) => {
  const result = rejectService().run({ id: req.params.id })
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending service with that ID' })
  }
  res.json({ message: 'Service rejected', id: req.params.id })
})

// POST /admin/services/:id/restore — Restore a soft-deleted service (admin only)
router.post('/admin/services/:id/restore', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND provider_deleted = 1').get(req.params.id)
  if (!service) {
    return res.status(404).json({ error: 'No soft-deleted service with that ID' })
  }
  db.prepare(
    "UPDATE services SET provider_deleted = 0, deleted_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id)
  console.log(`[admin/restore] RESTORED: service=${req.params.id} name=${service.name}`)
  res.json({ restored: true, id: req.params.id, name: service.name })
})

// POST /admin/services/:id/probe-status — Toggle probe_status for unprobeable gateways (#236)
router.post('/admin/services/:id/probe-status', (req, res) => {
  const { probe_status } = req.body || {}
  if (!probe_status || !['probeable', 'unprobeable'].includes(probe_status)) {
    return res.status(400).json({ error: "probe_status must be 'probeable' or 'unprobeable'" })
  }
  const service = db.prepare('SELECT id, name, probe_status FROM services WHERE id = ?').get(req.params.id)
  if (!service) {
    return res.status(404).json({ error: 'Service not found' })
  }
  const oldStatus = service.probe_status || 'probeable'
  if (probe_status === 'unprobeable') {
    // Reset stale health metrics when marking unprobeable
    db.prepare(`
      UPDATE services SET
        probe_status = 'unprobeable',
        health_status = 'unknown',
        consecutive_failures = 0,
        uptime_30d = NULL,
        latency_p50_ms = NULL,
        reliability_score = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id)
  } else {
    db.prepare("UPDATE services SET probe_status = 'probeable', updated_at = datetime('now') WHERE id = ?").run(req.params.id)
  }
  console.log(`[admin/probe-status] ${service.name}: ${oldStatus} → ${probe_status}`)
  res.json({ id: req.params.id, probe_status, previous: oldStatus })
})

// ─── Admin Domain Verification Funnel ─────────────────────────────────────

router.get('/admin/domains', (req, res) => {
  const domains = db.prepare(`
    SELECT dc.*,
      (SELECT COUNT(*) FROM services s
       WHERE s.hostname = dc.domain
         AND (s.status = 'active' OR s.status IS NULL)
         AND (s.provider_deleted = 0 OR s.provider_deleted IS NULL)) as endpoint_count
    FROM domain_claims dc
    ORDER BY COALESCE(dc.verified_at, dc.claimed_at) DESC
  `).all()
  res.json({ domains, total: domains.length })
})

// ─── Admin Domain Token Reset ─────────────────────────────────────────────

router.post('/admin/domains/:domain/reset', (req, res) => {
  const domain = (req.params.domain || '').trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain param is required' })

  const claim = db.prepare('SELECT * FROM domain_claims WHERE domain = ?').get(domain)
  if (!claim) return res.status(404).json({ error: 'No claim found for this domain' })

  const token = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  db.prepare(
    `UPDATE domain_claims SET verification_token = ?, token_hashed = 1, status = 'pending',
     expires_at = ?, verified_at = NULL WHERE domain = ?`
  ).run(hash, expiresAt, domain)

  console.log(`[admin/domain-reset] RESET: domain=${domain} old_status=${claim.status}`)

  res.json({
    reset: true,
    domain,
    new_status: 'pending',
    expires_at: expiresAt,
    verification_token: token,
    verification_hash: hash,
    verification_url: `https://${domain}/.well-known/402index-verify.txt`,
    instructions: 'Send the token to the provider. They must place the hash at the verification URL, then call POST /api/v1/claim/verify.',
  })
})

// ─── Admin Failed Registrations ──────────────────────────────────────────

router.get('/admin/failed-registrations', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const attempts = db.prepare(
    'SELECT * FROM registration_attempts ORDER BY attempted_at DESC LIMIT ?'
  ).all(limit)
  const total = db.prepare('SELECT COUNT(*) as c FROM registration_attempts').get().c
  res.json({ attempts, total })
})

// ─── Admin Traffic Dashboard ──────────────────────────────────────────────

router.get('/admin/traffic', (req, res) => {
  const today = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now')`
  ).get().c

  const week = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > datetime('now', '-7 days')`
  ).get().c

  const uniqueAgentsToday = db.prepare(
    `SELECT COUNT(DISTINCT user_agent) as c FROM query_log WHERE timestamp > date('now')`
  ).get().c

  const mcpToday = db.prepare(
    `SELECT COUNT(*) as c FROM query_log WHERE timestamp > date('now') AND user_agent LIKE '%402index-mcp%'`
  ).get().c

  const hourly = db.prepare(
    `SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour,
            COUNT(*) as total,
            SUM(CASE WHEN user_agent LIKE '%402index-mcp%' THEN 1 ELSE 0 END) as mcp_count
     FROM query_log
     WHERE timestamp > datetime('now', '-24 hours')
     GROUP BY hour
     ORDER BY hour`
  ).all()

  const topSearches = db.prepare(
    `SELECT query_text, COUNT(*) as count
     FROM query_log
     WHERE query_text IS NOT NULL AND query_text != ''
       AND timestamp > datetime('now', '-7 days')
     GROUP BY query_text
     ORDER BY count DESC
     LIMIT 20`
  ).all()

  const topAgents = db.prepare(
    `SELECT user_agent, COUNT(*) as count
     FROM query_log
     WHERE timestamp > datetime('now', '-7 days')
     GROUP BY user_agent
     ORDER BY count DESC
     LIMIT 15`
  ).all()

  const zeroResults = db.prepare(
    `SELECT query_text, filters, COUNT(*) as count
     FROM query_log
     WHERE result_count = 0
       AND query_text IS NOT NULL AND query_text != ''
       AND timestamp > datetime('now', '-7 days')
     GROUP BY query_text
     ORDER BY count DESC
     LIMIT 10`
  ).all()

  // Raw rows are kept 30 days; older ones live in query_log_daily (see query-log-rollup.js).
  const mcpSummary = mcpAllTime(db)

  res.json({
    summary: { today, week, uniqueAgentsToday, mcpToday },
    hourly,
    topSearches,
    topAgents,
    zeroResults,
    mcpSummary,
  })
})

// ─── Protocol Changes ──────────────────────────────────────────────────────

const getProtocolChanges = () => stmt('getProtocolChanges',
  'SELECT * FROM protocol_changes WHERE status = @status ORDER BY last_detected_at DESC'
)

const getAllProtocolChanges = () => stmt('getAllProtocolChanges',
  'SELECT * FROM protocol_changes ORDER BY last_detected_at DESC'
)

router.get('/admin/protocol-changes', (req, res) => {
  const status = req.query.status
  if (status === 'all') {
    const changes = getAllProtocolChanges().all()
    return res.json({ changes, total: changes.length })
  }
  const changes = getProtocolChanges().all({ status: status || 'pending' })
  res.json({ changes, total: changes.length })
})

router.post('/admin/protocol-changes/:id/approve', (req, res) => {
  const pc = db.prepare('SELECT * FROM protocol_changes WHERE id = ?').get(req.params.id)
  if (!pc) {
    return res.status(404).json({ error: 'Protocol change not found' })
  }
  if (pc.type !== 'addition') {
    return res.status(400).json({ error: 'Only addition type can be approved' })
  }
  if (pc.status === 'approved') {
    return res.status(409).json({ error: 'Already approved' })
  }
  if (pc.status === 'dismissed') {
    return res.status(409).json({ error: 'Already dismissed' })
  }

  // Read the triggering service to copy fields
  const originalService = db.prepare('SELECT * FROM services WHERE id = ?').get(pc.service_id)
  if (!originalService) {
    return res.status(404).json({ error: 'Triggering service not found' })
  }

  // Conflict guard: check if an active sibling already exists at (url, detected_protocol)
  const existingSibling = db.prepare(
    "SELECT id FROM services WHERE url = ? AND protocol = ? AND status = 'active' AND (provider_deleted = 0 OR provider_deleted IS NULL)"
  ).get(pc.url, pc.detected_protocol)
  if (existingSibling) {
    return res.status(409).json({ error: 'Sibling service already exists', existing_service_id: existingSibling.id })
  }

  // Create sibling via registerUpsert with null pricing
  const newId = randomUUID()
  const bonusParams = {
    id: newId,
    name: `${originalService.name} (${pc.detected_protocol})`,
    description: originalService.description || null,
    url: pc.url,
    protocol: pc.detected_protocol,
    price_sats: null,
    price_usd: null,
    payment_asset: null,
    payment_network: null,
    category: originalService.category || 'uncategorized',
    provider: originalService.provider || null,
    contact_email: originalService.contact_email || pc.contact_email || null,
    http_method: originalService.http_method || 'GET',
    probe_body: originalService.probe_body || null,
    hostname: extractHostname(pc.url),
  }

  const newService = registerUpsert().get(bonusParams)

  // Fire embedding for genuinely new protocol-change rows
  if (newService.registered_at === newService.updated_at) {
    setImmediate(() => generateEmbedding(newService.id).catch(() => {}))
  }

  // Set to active with admin-protocol-change approval reason and correct source
  db.prepare(
    "UPDATE services SET status = 'active', approval_reason = 'admin-protocol-change', source = 'protocol-change', updated_at = datetime('now') WHERE id = ?"
  ).run(newService.id)

  // Update protocol_changes row
  db.prepare(
    "UPDATE protocol_changes SET status = 'approved', reviewed_at = datetime('now'), created_service_id = ? WHERE id = ?"
  ).run(newService.id, pc.id)

  res.json({ message: 'Protocol change approved', id: pc.id, created_service_id: newService.id })
})

router.post('/admin/protocol-changes/:id/dismiss', (req, res) => {
  const result = db.prepare(
    "UPDATE protocol_changes SET status = 'dismissed', reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(req.params.id)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No pending protocol change with that ID' })
  }
  res.json({ message: 'Protocol change dismissed', id: req.params.id })
})

router.post('/admin/vacuum', (req, res) => {
  try {
    const before = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
    db.exec('VACUUM')
    const after = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })
    const freed = before - after
    res.json({
      message: 'VACUUM complete',
      before_bytes: before,
      after_bytes: after,
      freed_bytes: freed,
      freed_mb: (freed / 1024 / 1024).toFixed(1),
    })
  } catch (err) {
    res.status(500).json({ error: `VACUUM failed: ${err.message}` })
  }
})

export default router
