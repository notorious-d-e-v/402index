import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapNetworkToPaymentNetwork,
  extractProviderFromUrl,
  categorizeFromDescription,
  normalizeItem,
} from '../src/aggregators/bazaar-utils.js'

describe('mapNetworkToPaymentNetwork', () => {
  it('maps known networks to friendly names', () => {
    assert.equal(mapNetworkToPaymentNetwork('base'), 'Base')
    assert.equal(mapNetworkToPaymentNetwork('base-sepolia'), 'Base Sepolia')
    assert.equal(mapNetworkToPaymentNetwork('ethereum'), 'Ethereum')
    assert.equal(mapNetworkToPaymentNetwork('arbitrum'), 'Arbitrum')
    assert.equal(mapNetworkToPaymentNetwork('optimism'), 'Optimism')
    assert.equal(mapNetworkToPaymentNetwork('polygon'), 'Polygon')
  })

  it('passes through unknown networks unchanged', () => {
    assert.equal(mapNetworkToPaymentNetwork('solana'), 'solana')
    assert.equal(mapNetworkToPaymentNetwork('unknown'), 'unknown')
  })
})

describe('extractProviderFromUrl', () => {
  it('extracts provider name from hostname', () => {
    assert.equal(extractProviderFromUrl('https://example.com/api'), 'example')
    assert.equal(extractProviderFromUrl('https://myservice.io/v1'), 'myservice')
  })

  it('strips common prefixes (www, api, public)', () => {
    assert.equal(extractProviderFromUrl('https://api.example.com/v1'), 'example')
    assert.equal(extractProviderFromUrl('https://www.example.com'), 'example')
    assert.equal(extractProviderFromUrl('https://public.example.com'), 'example')
  })

  it('returns null for invalid URLs', () => {
    assert.equal(extractProviderFromUrl('not-a-url'), null)
    assert.equal(extractProviderFromUrl(''), null)
  })
})

describe('categorizeFromDescription', () => {
  it('categorizes crypto-related descriptions', () => {
    assert.equal(categorizeFromDescription('Get NFT metadata'), 'crypto/nft')
    assert.equal(categorizeFromDescription('Check token balance'), 'crypto/balances')
    assert.equal(categorizeFromDescription('Token holding details'), 'crypto/balances')
    assert.equal(categorizeFromDescription('Get token price data'), 'crypto/prices')
    assert.equal(categorizeFromDescription('Market cap tracker'), 'crypto/prices')
    assert.equal(categorizeFromDescription('DeFi liquidity pools'), 'crypto/defi')
    assert.equal(categorizeFromDescription('Swap tokens easily'), 'crypto/defi')
    assert.equal(categorizeFromDescription('Transaction history'), 'crypto/transactions')
    assert.equal(categorizeFromDescription('Wallet portfolio view'), 'crypto/wallet')
  })

  it('categorizes other descriptions', () => {
    assert.equal(categorizeFromDescription('Weather forecast API'), 'real-time-data/weather')
    assert.equal(categorizeFromDescription('News aggregator'), 'real-time-data/news')
    assert.equal(categorizeFromDescription('Web search API'), 'tools/search')
    assert.equal(categorizeFromDescription('Image processing'), 'media/images')
  })

  it('returns null for null/undefined/unmatched descriptions', () => {
    assert.equal(categorizeFromDescription(null), null)
    assert.equal(categorizeFromDescription(undefined), null)
    assert.equal(categorizeFromDescription('some random API'), null)
  })
})

describe('normalizeItem', () => {
  it('normalizes a valid Bazaar item', () => {
    const item = {
      resource: 'http://api.example.com/weather',
      accepts: [{
        resource: 'http://api.example.com/weather',
        maxAmountRequired: '1000000',
        network: 'base',
        description: 'Weather forecast API',
      }],
    }

    const result = normalizeItem(item)
    assert.ok(result)
    assert.ok(result.id)
    assert.equal(result.url, 'https://api.example.com/weather')
    assert.equal(result.price_usd, 1.0)
    assert.equal(result.payment_asset, 'USDC')
    assert.equal(result.payment_network, 'Base')
    assert.equal(result.category, 'real-time-data/weather')
    assert.equal(result.provider, 'example')
  })

  it('throws when no accepts array', () => {
    assert.throws(() => normalizeItem({}), /missing accepts/)
    assert.throws(() => normalizeItem({ accepts: [] }), /missing accepts/)
  })

  it('throws when no resource URL', () => {
    const item = { accepts: [{ maxAmountRequired: '1000' }] }
    assert.throws(() => normalizeItem(item), /missing resource URL/)
  })

  it('truncates long descriptions for name field', () => {
    const longDesc = 'A'.repeat(100)
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        description: longDesc,
      }],
    }
    const result = normalizeItem(item)
    assert.ok(result.name.length <= 83)
    assert.ok(result.name.endsWith('...'))
  })

  it('uses URL as name when no description', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.name, 'https://example.com/api')
  })

  it('handles custom payment asset names', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        extra: { name: 'WETH' },
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.payment_asset, 'WETH')
  })

  it('defaults to USDC when no asset name', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.payment_asset, 'USDC')
  })

  it('serializes input and output schemas', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        outputSchema: {
          input: { type: 'string' },
          output: { type: 'number' },
        },
      }],
    }
    const result = normalizeItem(item)
    assert.equal(result.input_schema, '{"type":"string"}')
    assert.equal(result.output_schema, '{"type":"number"}')
  })
})

// ─── x402 v2 discovery items (#353) ──────────────────────────────────────────
// CDP's /discovery/resources serves v2 items: the description, service name,
// price and Bazaar declaration live in different places than in v1, and every
// field read only from its v1 location came back empty.

function makeV2Item(overrides = {}) {
  return {
    resource: 'https://api.example.com/v1/lookup',
    type: 'http',
    x402Version: 2,
    description: 'Company lookup by domain: legal name, industry and headcount.',
    serviceName: 'Example Data',
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    }],
    extensions: {
      bazaar: {
        info: {
          input: { type: 'http', method: 'POST', bodyType: 'json', body: { domain: 'example.com' } },
          output: { type: 'json', example: { name: 'Example Inc.' } },
        },
      },
    },
    ...overrides,
  }
}

describe('normalizeItem — x402 v2 items (#353)', () => {
  it('reads the description from the item, not the accept entry', () => {
    const result = normalizeItem(makeV2Item())
    assert.equal(result.description, 'Company lookup by domain: legal name, industry and headcount.')
    assert.equal(result.name, 'Company lookup by domain: legal name, industry and headcount.')
  })

  it('prices from accepts[0].amount', () => {
    assert.equal(normalizeItem(makeV2Item()).price_usd, 0.005)
  })

  it('takes the provider from serviceName', () => {
    assert.equal(normalizeItem(makeV2Item()).provider, 'Example Data')
  })

  it('reads the input and output schema from the Bazaar declaration', () => {
    const item = makeV2Item()
    const result = normalizeItem(item)
    assert.equal(result.input_schema, JSON.stringify(item.extensions.bazaar.info.input))
    assert.equal(result.output_schema, JSON.stringify(item.extensions.bazaar.info.output))
  })

  it('reads the HTTP method from the Bazaar declaration', () => {
    assert.equal(normalizeItem(makeV2Item()).http_method, 'POST')
  })

  it('normalizes the method and ignores one it does not recognise', () => {
    const lower = makeV2Item()
    lower.extensions.bazaar.info.input.method = 'post'
    assert.equal(normalizeItem(lower).http_method, 'POST')

    const unknown = makeV2Item()
    unknown.extensions.bazaar.info.input.method = 'FETCH'
    assert.equal(normalizeItem(unknown).http_method, null)
  })

  it('leaves the method unset when nothing declares one', () => {
    const item = makeV2Item({ extensions: undefined })
    assert.equal(normalizeItem(item).http_method, null)
  })

  it('still reads a v1 item’s method from outputSchema.input', () => {
    const item = {
      accepts: [{
        resource: 'https://example.com/api',
        outputSchema: { input: { type: 'http', method: 'POST' } },
      }],
    }
    assert.equal(normalizeItem(item).http_method, 'POST')
  })
})
