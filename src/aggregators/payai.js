import db from '../db.js'
import { normalizeItem } from './bazaar-utils.js'
import { extractHostname } from '../services/url-normalize.js'
import { generateEmbedding } from '../services/embeddings.js'
import { eligiblePayaiItem } from './payai-policy.js'
import { completePayaiPass, getPayaiState, setPayaiState, startPayaiPass } from './payai-presence.js'

// PayAI facilitator's discovery catalog: same response shape as the CDP Bazaar
// (items[] + pagination.total, offset-paginated, public, no key).
const PAYAI_URL = 'https://facilitator.payai.network/discovery/resources'
const PAGE_SIZE = 100
const MAX_RETRIES = 5
const PAGE_DELAY_MS = 1000
const PAYAI_FULL_PASS_TIMEOUT_HOURS = parseInt(process.env.PAYAI_FULL_PASS_TIMEOUT_HOURS) || 24

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

// Update only PayAI-owned rows and preserve provider deletion. A relisting
// reverses our own automatic retirement, never an operator's retirement.
const upsert = () => stmt('payaiUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id, hostname, http_method, payai_seen_pass)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'payai', @source_id, @hostname, COALESCE(@http_method, 'GET'), @payai_seen_pass)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE excluded.description END,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE excluded.category END,
    input_schema = excluded.input_schema,
    output_schema = excluded.output_schema,
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE excluded.provider END,
    source_id = excluded.source_id,
    hostname = COALESCE(excluded.hostname, services.hostname),
    http_method = COALESCE(@http_method, services.http_method),
    payai_seen_pass = excluded.payai_seen_pass,
    upstream_missing_since = NULL,
    status = CASE WHEN services.retired_batch GLOB 'payai-auto-pass-*' THEN 'active' ELSE services.status END,
    retired_at = CASE WHEN services.retired_batch GLOB 'payai-auto-pass-*' THEN NULL ELSE services.retired_at END,
    retired_batch = CASE WHEN services.retired_batch GLOB 'payai-auto-pass-*' THEN NULL ELSE services.retired_batch END,
    updated_at = datetime('now')
  WHERE services.source = 'payai' AND COALESCE(services.provider_deleted, 0) = 0
  RETURNING *
`)

// Presence is independent of source ownership: Bazaar retirement relies on
// source = 'bazaar', so never append a token to a shared row's source.
const stampShared = () => stmt('payaiStampShared', `
  UPDATE services SET payai_seen_pass = ?
  WHERE url = ? AND protocol = 'x402' AND COALESCE(provider_deleted, 0) = 0
`)
const findExisting = () => stmt('payaiFindExisting',
  "SELECT id, source, provider_deleted FROM services WHERE url = ? AND protocol = 'x402'"
)
const quarantined = () => stmt('payaiQuarantined',
  "SELECT 1 FROM quarantined_hosts WHERE hostname = ? AND state IN ('quarantined', 'held')"
)

export async function pollPayai() {
  console.log('[payai] Starting poll...')
  const { passId, offset: initialOffset } = startPayaiPass(db, PAYAI_FULL_PASS_TIMEOUT_HOURS * 3_600_000)
  let offset = initialOffset
  const configuredMax = Number(process.env.PAYAI_MAX_PAGES)
  const maxPages = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? Math.min(configuredMax, 1000) : 100
  let newCount = 0, updatedCount = 0, sharedCount = 0, errorCount = 0, skippedCount = 0

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const url = `${PAYAI_URL}?limit=${PAGE_SIZE}&offset=${offset}`
    let data
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (res.status === 429) {
          if (attempt < MAX_RETRIES - 1) await sleep(2 ** (attempt + 1) * 1000)
          continue
        }
        if (!res.ok) {
          console.error(`[payai] API returned ${res.status} at offset ${offset}`)
          break
        }
        data = await res.json()
        break
      } catch (err) {
        console.error(`[payai] Fetch error at offset ${offset}:`, err.message)
        if (attempt < MAX_RETRIES - 1) await sleep(2000)
      }
    }
    if (!data) break // Keep this pass and offset for a later run.
    const total = data.pagination?.total
    if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(data.items) || data.items.length > PAGE_SIZE ||
        (data.pagination.offset !== undefined && data.pagination.offset !== offset)) {
      console.error(`[payai] Invalid page at offset ${offset}; not advancing the pass`)
      errorCount++
      break
    }
    if (data.items.length === 0 && offset < total) break

    let pageErrors = 0
    const embeddingIds = []
    // Keep row stamps, coverage, and offset atomic so retries do not double-count
    // a page or let a crash advance beyond uncommitted catalog writes.
    db.transaction(() => {
      for (const item of data.items) {
        try {
          const eligible = eligiblePayaiItem(item)
          if (!eligible) { skippedCount++; continue }
          const normalized = normalizeItem(eligible)
          normalized.hostname = extractHostname(normalized.url)
          normalized.payai_seen_pass = passId
          if (quarantined().get(normalized.hostname)) { skippedCount++; continue }
          const existing = findExisting().get(normalized.url)
          if (existing?.provider_deleted) { skippedCount++; continue }
          if (existing && existing.source !== 'payai') {
            stampShared().run(passId, normalized.url)
            sharedCount++
            continue
          }
          const row = upsert().get(normalized)
          if (existing) updatedCount++
          else {
            newCount++
            if (row) embeddingIds.push(row.id)
          }
        } catch (err) {
          errorCount++
          pageErrors++
          console.error(`[payai] Error normalizing ${item?.resource ?? 'unknown'}:`, err.message)
        }
      }
      setPayaiState(db, 'offset', offset + PAGE_SIZE)
      setPayaiState(db, 'pass_seen', Number(getPayaiState(db, 'pass_seen') || 0) + data.items.length)
      setPayaiState(db, 'pass_errors', Number(getPayaiState(db, 'pass_errors') || 0) + pageErrors)
      setPayaiState(db, 'pass_total', Math.max(Number(getPayaiState(db, 'pass_total') || 0), total))
    }).immediate()
    for (const id of embeddingIds) setImmediate(() => generateEmbedding(id).catch(() => {}))
    offset += PAGE_SIZE
    if (offset >= total) {
      const pass = completePayaiPass(db, passId)
      console.log(`[payai] Finished pass ${pass.passId}: seen=${pass.seen} total=${pass.upstreamTotal} complete=${pass.complete} retired=${pass.retired}`)
      break
    }
    if (pageNumber + 1 < maxPages) await sleep(PAGE_DELAY_MS)
  }
  console.log(`[payai] Synced ${newCount + updatedCount + sharedCount} resources (${skippedCount} skipped, ${errorCount} errors)`)
  return { new: newCount, updated: updatedCount, shared: sharedCount, errors: errorCount }
}
