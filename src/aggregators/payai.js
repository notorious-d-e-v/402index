import db from '../db.js'
import { normalizeItem } from './bazaar-utils.js'
import { extractHostname } from '../services/url-normalize.js'
import { generateEmbedding } from '../services/embeddings.js'

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

// Same upsert as bazaar.js, with source 'payai'. Only used for rows PayAI owns
// (new URLs, or rows PayAI indexed first).
const upsert = () => stmt('payaiUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_usd, payment_asset, payment_network, category, input_schema, output_schema, provider, source, source_id, hostname)
  VALUES (@id, @name, @description, @url, 'x402', @price_usd, @payment_asset, @payment_network, @category, @input_schema, @output_schema, @provider, 'payai', @source_id, @hostname)
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
    provider_deleted = 0,
    approval_reason = CASE WHEN services.provider_deleted = 1 THEN 'payai-relisted' ELSE services.approval_reason END,
    updated_at = datetime('now')
  RETURNING *
`)

// A URL already indexed from another source (usually the Bazaar) keeps its data;
// PayAI only adds its token. Exact-token match, as in mppscan.js.
const tagSource = () => stmt('payaiTagSource', `
  UPDATE services SET
    source = services.source || ',payai',
    updated_at = datetime('now')
  WHERE url = ? AND protocol = 'x402'
    AND instr(',' || services.source || ',', ',payai,') = 0
    AND (provider_deleted = 0 OR provider_deleted IS NULL)
`)

const findExisting = () => stmt('payaiFindExisting',
  "SELECT id, source FROM services WHERE url = ? AND protocol = 'x402'"
)

const getSyncState = () => stmt('getSyncState', 'SELECT value FROM sync_state WHERE key = ?')
const setSyncState = () => stmt('setSyncState', `
  INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`)

export async function pollPayai() {
  console.log('[payai] Starting poll...')

  // Resume from last saved offset
  const savedOffset = getSyncState().get('payai_offset')
  let offset = savedOffset ? parseInt(savedOffset.value) || 0 : 0

  // Force offset reset if last full pass was >PAYAI_FULL_PASS_TIMEOUT_HOURS ago (same guard as bazaar.js).
  const lastFullPassRow = getSyncState().get('payai_last_full_pass')
  const lastFullPassMs = lastFullPassRow ? new Date(lastFullPassRow.value).getTime() : 0
  const timeoutMs = PAYAI_FULL_PASS_TIMEOUT_HOURS * 60 * 60 * 1000
  if (!lastFullPassRow || isNaN(lastFullPassMs) || (Date.now() - lastFullPassMs) > timeoutMs) {
    if (offset > 0) {
      console.log(`[payai] Forcing offset reset to 0 (last full pass >${PAYAI_FULL_PASS_TIMEOUT_HOURS}h ago)`)
      offset = 0
      setSyncState().run('payai_offset', '0')
    }
  } else if (offset > 0) {
    console.log(`[payai] Resuming from saved offset ${offset}`)
  }

  let total = null
  let newCount = 0
  let updatedCount = 0
  let sharedCount = 0
  let errorCount = 0

  // Track which URLs we've seen this poll to handle dupes within a single poll
  const seen = new Set()

  while (total === null || offset < total) {
    const url = `${PAYAI_URL}?limit=${PAGE_SIZE}&offset=${offset}`

    let data
    let fetched = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (res.status === 429) {
          const backoff = Math.pow(2, attempt + 1) * 1000
          console.warn(`[payai] Rate limited at offset ${offset}, retrying in ${backoff / 1000}s...`)
          await sleep(backoff)
          continue
        }
        if (!res.ok) {
          console.error(`[payai] API returned ${res.status} at offset ${offset}`)
          break
        }
        data = await res.json()
        fetched = true
        break
      } catch (err) {
        console.error(`[payai] Fetch error at offset ${offset} (attempt ${attempt + 1}):`, err.message)
        if (attempt < MAX_RETRIES - 1) await sleep(2000)
      }
    }
    if (!fetched) {
      console.warn(`[payai] Stopping at offset ${offset} after failed retries. Will resume next poll.`)
      break
    }

    if (total === null) {
      total = data.pagination?.total || 0
      console.log(`[payai] Total resources in PayAI catalog: ${total}`)
    }

    const items = data.items || []
    if (items.length === 0) break

    let pageNormalizedCount = 0
    let pageErrorCount = 0

    for (const item of items) {
      try {
        const normalized = normalizeItem(item)

        // Skip dupes within this poll
        if (seen.has(normalized.url)) continue
        seen.add(normalized.url)

        normalized.hostname = extractHostname(normalized.url)
        pageNormalizedCount++

        // PayAI owns a row only if it indexed it first (first source token is 'payai').
        const existing = findExisting().get(normalized.url)
        if (existing && String(existing.source).split(',')[0] !== 'payai') {
          tagSource().run(normalized.url)
          sharedCount++
          continue
        }

        const row = upsert().get(normalized)
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
        const resourceHint = item?.resource || JSON.stringify(item)?.substring(0, 200) || 'unknown'
        console.error(`[payai] Error normalizing item (resource: ${resourceHint}):`, err.message)
      }
    }

    if (pageErrorCount > 0 || pageNormalizedCount > 0) {
      console.log(`[payai] Normalization: ${pageNormalizedCount} succeeded, ${pageErrorCount} failed`)
    }

    offset += PAGE_SIZE

    // Persist offset so next poll can resume here if we get rate-limited
    setSyncState().run('payai_offset', String(offset))

    // Rate limit courtesy delay between pages
    if (total !== null && offset < total) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  // If we reached the end (or past it), reset offset for next full pass and record timestamp
  if (total !== null && offset >= total) {
    setSyncState().run('payai_offset', '0')
    setSyncState().run('payai_last_full_pass', new Date().toISOString())
    console.log('[payai] Completed full catalog pass, resetting offset to 0')
  }

  const totalProcessed = newCount + updatedCount + sharedCount + errorCount

  // Alert if >50% of items failed normalization — API format may have changed
  if (totalProcessed > 0 && errorCount > 0.5 * totalProcessed) {
    console.error(`[payai] ALERT: >50% of PayAI items failed to normalize (${errorCount}/${totalProcessed}). API format may have changed!`)
  }

  console.log(`[payai] Synced ${newCount + updatedCount + sharedCount} services from PayAI (${newCount} new, ${updatedCount} updated, ${sharedCount} already indexed from another source${errorCount > 0 ? `, ${errorCount} errors` : ''})`)
  return { new: newCount, updated: updatedCount, shared: sharedCount, errors: errorCount }
}
