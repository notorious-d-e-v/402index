import db from '../db.js'
import { normalizeItem } from './bazaar-utils.js'
import { extractHostname } from '../services/url-normalize.js'
import { generateEmbedding } from '../services/embeddings.js'
import { completePass, currentPassId } from './bazaar-presence.js'

const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'
const PAGE_SIZE = 100
const MAX_RETRIES = 5
const PAGE_DELAY_MS = 1000
const BAZAAR_FULL_PASS_TIMEOUT_HOURS = parseInt(process.env.BAZAAR_FULL_PASS_TIMEOUT_HOURS) || 24

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Lazy-initialized prepared statements
const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

// Bug A fix: removed WHERE guard so re-listed soft-deleted services are reactivated.
// Added provider_deleted = 0 and conditional approval_reason to SET clause.
const upsert = () => stmt('upsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id, http_method, hostname, bazaar_seen_pass)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'bazaar', @source_id, COALESCE(@http_method, 'GET'), @hostname, @bazaar_seen_pass)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = CASE WHEN services.domain_verified = 1 THEN services.name ELSE excluded.name END,
    description = CASE WHEN services.domain_verified = 1 THEN services.description ELSE excluded.description END,
    price_usd = excluded.price_usd,
    payment_asset = excluded.payment_asset,
    payment_network = excluded.payment_network,
    category = CASE WHEN services.domain_verified = 1 THEN services.category ELSE excluded.category END,
    input_schema = excluded.input_schema,
    output_schema = excluded.output_schema,
    -- A declared method wins; an undeclared one leaves the stored method alone (#353).
    http_method = COALESCE(@http_method, services.http_method),
    provider = CASE WHEN services.domain_verified = 1 THEN services.provider ELSE excluded.provider END,
    source_id = excluded.source_id,
    hostname = COALESCE(excluded.hostname, services.hostname),
    provider_deleted = 0,
    approval_reason = CASE WHEN services.provider_deleted = 1 THEN 'bazaar-relisted' ELSE services.approval_reason END,
    -- Listed again: stamp the pass, clear the missing flag, undo a churn retirement (bazaar-presence.js).
    bazaar_seen_pass = excluded.bazaar_seen_pass,
    upstream_missing_since = NULL,
    status = CASE WHEN services.status = 'retired' THEN 'active' ELSE services.status END,
    retired_batch = CASE WHEN services.status = 'retired' THEN NULL ELSE services.retired_batch END,
    updated_at = datetime('now')
  RETURNING *
`)

// Bug A fix: exclude soft-deleted rows so stats reflect reality.
const findExisting = () => stmt('findExisting',
  'SELECT id FROM services WHERE url = ? AND protocol = ? AND (provider_deleted = 0 OR provider_deleted IS NULL)'
)

const getSyncState = () => stmt('getSyncState', 'SELECT value FROM sync_state WHERE key = ?')
const setSyncState = () => stmt('setSyncState', `
  INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`)

export async function pollBazaar() {
  console.log('[bazaar] Starting poll...')

  // Resume from last saved offset
  const savedOffset = getSyncState().get('bazaar_offset')
  let offset = savedOffset ? parseInt(savedOffset.value) || 0 : 0

  // Bug C fix: force offset reset if last full pass was >BAZAAR_FULL_PASS_TIMEOUT_HOURS ago.
  const lastFullPassRow = getSyncState().get('bazaar_last_full_pass')
  const lastFullPassMs = lastFullPassRow ? new Date(lastFullPassRow.value).getTime() : 0
  const timeoutMs = BAZAAR_FULL_PASS_TIMEOUT_HOURS * 60 * 60 * 1000
  // Guard against malformed date strings (NaN comparison always returns false)
  if (!lastFullPassRow || isNaN(lastFullPassMs) || (Date.now() - lastFullPassMs) > timeoutMs) {
    if (offset > 0) {
      console.log(`[bazaar] Forcing offset reset to 0 (last full pass >${BAZAAR_FULL_PASS_TIMEOUT_HOURS}h ago)`)
      offset = 0
      setSyncState().run('bazaar_offset', '0')
    }
  } else if (offset > 0) {
    console.log(`[bazaar] Resuming from saved offset ${offset}`)
  }

  let total = null
  const passId = currentPassId(db)
  let newCount = 0
  let updatedCount = 0
  let errorCount = 0
  let normalizedCount = 0

  // Track which URLs we've seen this poll to handle dupes within a single poll
  const seen = new Set()

  while (total === null || offset < total) {
    const url = `${BAZAAR_URL}?limit=${PAGE_SIZE}&offset=${offset}`

    let data
    let fetched = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (res.status === 429) {
          const backoff = Math.pow(2, attempt + 1) * 1000
          console.warn(`[bazaar] Rate limited at offset ${offset}, retrying in ${backoff / 1000}s...`)
          await sleep(backoff)
          continue
        }
        if (!res.ok) {
          console.error(`[bazaar] API returned ${res.status} at offset ${offset}`)
          break
        }
        data = await res.json()
        fetched = true
        break
      } catch (err) {
        console.error(`[bazaar] Fetch error at offset ${offset} (attempt ${attempt + 1}):`, err.message)
        if (attempt < MAX_RETRIES - 1) await sleep(2000)
      }
    }
    if (!fetched) {
      console.warn(`[bazaar] Stopping at offset ${offset} after failed retries. Will resume next poll.`)
      break
    }

    if (total === null) {
      total = data.pagination?.total || 0
      console.log(`[bazaar] Total resources in Bazaar: ${total}`)
    }

    const items = data.items || []
    if (items.length === 0) break

    // Per-page counters for accurate summary line (not cumulative across pages)
    let pageNormalizedCount = 0
    let pageErrorCount = 0

    for (const item of items) {
      try {
        const normalized = normalizeItem(item)

        // Skip dupes within this poll
        if (seen.has(normalized.url)) continue
        seen.add(normalized.url)

        normalized.hostname = extractHostname(normalized.url)
        normalized.bazaar_seen_pass = passId

        // Check if service already exists (excludes soft-deleted rows — Bug A fix)
        const existing = findExisting().get(normalized.url, 'x402')

        const row = upsert().get(normalized)
        normalizedCount++
        pageNormalizedCount++

        if (existing) {
          updatedCount++
        } else {
          newCount++
          if (row && row.registered_at === row.updated_at) {
            setImmediate(() => generateEmbedding(row.id).catch(() => {}))
          }
        }
      } catch (err) {
        errorCount++
        pageErrorCount++
        // Bug B fix: log ALL errors with identifying info, no gate suppressing after 5.
        const resourceHint = item?.resource || JSON.stringify(item)?.substring(0, 200) || 'unknown'
        console.error(`[bazaar] Error normalizing item (resource: ${resourceHint}):`, err.message)
      }
    }

    // Bug B fix: per-page summary line with accurate page-level counts
    if (pageErrorCount > 0 || pageNormalizedCount > 0) {
      console.log(`[bazaar] Normalization: ${pageNormalizedCount} succeeded, ${pageErrorCount} failed`)
    }

    offset += PAGE_SIZE

    // Persist offset so next poll can resume here if we get rate-limited
    setSyncState().run('bazaar_offset', String(offset))

    // Rate limit courtesy delay between pages
    if (total !== null && offset < total) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  // If we reached the end (or past it), reset offset for next full pass and record timestamp
  if (total !== null && offset >= total) {
    setSyncState().run('bazaar_offset', '0')
    setSyncState().run('bazaar_last_full_pass', new Date().toISOString())
    const pass = completePass(db, total)
    console.log(`[bazaar] Completed full catalog pass ${pass.passId}: upstream_total=${pass.upstreamTotal} seen=${pass.seen} complete=${pass.complete} marked_missing=${pass.markedMissing} retired=${pass.retired}, resetting offset to 0`)
  }

  const totalProcessed = newCount + updatedCount + errorCount

  // Alert if >50% of items failed normalization — API format may have changed
  if (totalProcessed > 0 && errorCount > 0.5 * totalProcessed) {
    console.error(`[bazaar] ALERT: >50% of Bazaar items failed to normalize (${errorCount}/${totalProcessed}). API format may have changed!`)
  }

  console.log(`[bazaar] Synced ${newCount + updatedCount} services from Bazaar (${newCount} new, ${updatedCount} updated${errorCount > 0 ? `, ${errorCount} errors` : ''}) upstream_total=${total ?? 'unknown'}`)
  return { new: newCount, updated: updatedCount, errors: errorCount }
}
