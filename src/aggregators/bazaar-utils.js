import { randomUUID } from 'crypto'
import { normalizeUrl } from '../services/url-normalize.js'

/**
 * @param {string} network - Bazaar network name (e.g. 'base', 'ethereum')
 * @returns {string} CAIP-2 chain ID or original value if unmapped
 */
export function mapNetworkToPaymentNetwork(network) {
  const map = {
    'base': 'Base',
    'base-sepolia': 'Base Sepolia',
    'ethereum': 'Ethereum',
    'arbitrum': 'Arbitrum',
    'optimism': 'Optimism',
    'polygon': 'Polygon',
  }
  return map[network] || network
}

/**
 * @param {string} url - Service endpoint URL
 * @returns {string|null} Provider name extracted from hostname, or null if URL is invalid
 */
export function extractProviderFromUrl(url) {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^(www|api|public)\./, '').split('.')[0]
  } catch {
    return null
  }
}

/**
 * @param {string|null} description - Service description text
 * @returns {string|null} Category slug inferred from keywords, or null if no match
 */
export function categorizeFromDescription(description) {
  if (!description) return null
  const d = description.toLowerCase()

  if (d.includes('nft')) return 'crypto/nft'
  if (d.includes('token balance') || d.includes('token holding')) return 'crypto/balances'
  if (d.includes('token price') || d.includes('market cap')) return 'crypto/prices'
  if (d.includes('defi') || d.includes('liquidity') || d.includes('swap')) return 'crypto/defi'
  if (d.includes('transaction') || d.includes('transfer')) return 'crypto/transactions'
  if (d.includes('wallet') || d.includes('portfolio')) return 'crypto/wallet'
  if (d.includes('weather') || d.includes('forecast')) return 'real-time-data/weather'
  if (d.includes('news')) return 'real-time-data/news'
  if (d.includes('search')) return 'tools/search'
  if (d.includes('image') || d.includes('photo')) return 'media/images'
  return null
}

/**
 * Normalize a Bazaar API item into the internal service schema.
 * @param {object} item - Raw Bazaar API item with accepts array and resource URL
 * @returns {object} Normalized service object matching the internal schema
 * @throws {Error} If the item has neither an accepts array nor a resource URL.
 */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])

/**
 * The HTTP method a Bazaar declaration names, upper-cased, or null when it
 * names none we recognise. x402 v2 declares it at
 * `extensions.bazaar.info.input.method`; v1 at `accepts[0].outputSchema.input`.
 * @param {object|undefined} input - The declared input object
 * @returns {string|null}
 */
function declaredMethod(input) {
  const method = typeof input?.method === 'string' ? input.method.toUpperCase() : null
  return method && HTTP_METHODS.has(method) ? method : null
}

export function normalizeItem(item) {
  const accept = item.accepts?.[0]

  // Graceful fallback: if accepts is missing but resource URL is present,
  // ingest with null price/schema rather than throwing.
  if (!accept) {
    if (!item.resource) throw new Error('missing accepts array')
    const url = normalizeUrl(item.resource)
    if (!url) throw new Error('missing resource URL')
    return {
      id: randomUUID(),
      name: url,
      description: null,
      url,
      price_usd: null,
      payment_asset: 'USDC',
      payment_network: 'Base',
      category: 'uncategorized',
      input_schema: null,
      output_schema: null,
      http_method: null,
      provider: extractProviderFromUrl(url),
      source_id: url,
    }
  }

  const rawUrl = item.resource || accept.resource
  if (!rawUrl) throw new Error('missing resource URL')
  const url = normalizeUrl(rawUrl)

  // x402 v2 items (#353) moved these fields: the price is `amount`, the
  // description and service name sit on the item, and the Bazaar declaration
  // is `extensions.bazaar.info`. v2 first, v1 as the fallback.
  const maxAmount = accept.amount ?? accept.maxAmountRequired
  const priceUsd = maxAmount ? parseFloat(maxAmount) / 1e6 : null

  const paymentAsset = accept.extra?.name || 'USDC'

  const description = item.description || accept.description || null
  const provider = item.serviceName || extractProviderFromUrl(url)
  const declared = item.extensions?.bazaar?.info
  const input = declared?.input ?? accept.outputSchema?.input
  const output = declared?.output ?? accept.outputSchema?.output
  const name = description
    ? description.substring(0, 80) + (description.length > 80 ? '...' : '')
    : url

  const sourceId = url

  return {
    id: randomUUID(),
    name,
    description,
    url,
    price_usd: priceUsd,
    payment_asset: paymentAsset,
    payment_network: mapNetworkToPaymentNetwork(accept.network || 'base'),
    category: categorizeFromDescription(description) || 'uncategorized',
    input_schema: input ? JSON.stringify(input) : null,
    output_schema: output ? JSON.stringify(output) : null,
    http_method: declaredMethod(input),
    provider,
    source_id: sourceId,
  }
}
