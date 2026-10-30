import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePaymentRequired,
  parsePaymentRequiredBody,
  validatePaymentRequirements,
  isValidAssetAddress,
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidPaymentAddress,
  isKnownUSDC,
  isKnownNativeAsset,
  isLightningEntry,
  extractFacilitatorUrl,
} from '../src/services/x402-utils.js'

// ─── parsePaymentRequired ──────────────────────────────────────────────────

describe('parsePaymentRequired', () => {
  function encode(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
  }

  it('parses valid base64-encoded JSON with accepts array', () => {
    const payload = {
      accepts: [{
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        network: 'eip155:8453',
        maxAmountRequired: '1000000',
      }],
    }
    const result = parsePaymentRequired(encode(payload))
    assert.equal(result.valid, true)
    assert.equal(result.accepts.length, 1)
    assert.equal(result.error, null)
  })

  it('returns error for null input', () => {
    const result = parsePaymentRequired(null)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('missing'))
  })

  it('returns error for empty string', () => {
    const result = parsePaymentRequired('')
    assert.equal(result.valid, false)
  })

  it('returns error for invalid base64', () => {
    const result = parsePaymentRequired('!!!not-base64!!!')
    // Buffer.from handles most strings gracefully, so this may or may not fail at base64 stage
    // It should fail at JSON parse stage
    assert.equal(result.valid, false)
  })

  it('returns error for valid base64 but invalid JSON', () => {
    const result = parsePaymentRequired(Buffer.from('not json').toString('base64'))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('JSON'))
  })

  it('returns error for JSON without accepts array', () => {
    const result = parsePaymentRequired(encode({ foo: 'bar' }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('accepts'))
  })

  it('returns error for empty accepts array', () => {
    const result = parsePaymentRequired(encode({ accepts: [] }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('empty'))
  })

  it('preserves raw parsed object', () => {
    const payload = { accepts: [{ payTo: '0x' + 'a'.repeat(40) }], version: '1.0' }
    const result = parsePaymentRequired(encode(payload))
    assert.equal(result.raw.version, '1.0')
  })
})

// ─── parsePaymentRequiredBody (V1 body parsing) ─────────────────────────────

describe('parsePaymentRequiredBody', () => {
  const v1Body = {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      resource: 'https://api.example.com/premium-data',
      description: 'Access to premium market data',
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
    }],
  }

  it('parses valid V1 body with accepts array', () => {
    const result = parsePaymentRequiredBody(JSON.stringify(v1Body))
    assert.equal(result.valid, true)
    assert.equal(result.accepts.length, 1)
    assert.equal(result.accepts[0].maxAmountRequired, '10000')
    assert.equal(result.error, null)
  })

  it('returns error for null input', () => {
    const result = parsePaymentRequiredBody(null)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('empty'))
  })

  it('returns error for empty string', () => {
    const result = parsePaymentRequiredBody('')
    assert.equal(result.valid, false)
  })

  it('returns error for non-JSON string', () => {
    const result = parsePaymentRequiredBody('<html>Not Found</html>')
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('not valid JSON'))
  })

  it('returns error for JSON without accepts array', () => {
    const result = parsePaymentRequiredBody(JSON.stringify({ error: 'payment required' }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('accepts'))
  })

  it('returns error for empty accepts array', () => {
    const result = parsePaymentRequiredBody(JSON.stringify({ accepts: [] }))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('empty'))
  })

  it('returns error for body exceeding 64KB', () => {
    const result = parsePaymentRequiredBody('x'.repeat(65537))
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('64KB'))
  })

  it('preserves raw parsed object', () => {
    const result = parsePaymentRequiredBody(JSON.stringify(v1Body))
    assert.equal(result.raw.x402Version, 1)
    assert.equal(result.raw.error, 'X-PAYMENT header is required')
  })

  it('handles V1 body with multiple accepts entries', () => {
    const multiBody = {
      ...v1Body,
      accepts: [
        v1Body.accepts[0],
        { ...v1Body.accepts[0], payTo: '0x' + 'a'.repeat(40), maxAmountRequired: '5000' },
      ],
    }
    const result = parsePaymentRequiredBody(JSON.stringify(multiBody))
    assert.equal(result.valid, true)
    assert.equal(result.accepts.length, 2)
  })

  it('works with validatePaymentRequirements for V1 fields', () => {
    const result = parsePaymentRequiredBody(JSON.stringify(v1Body))
    assert.equal(result.valid, true)
    const validation = validatePaymentRequirements(result.accepts)
    assert.equal(validation.valid, true)
    assert.equal(validation.entries[0].hasAmount, true)
    assert.equal(validation.entries[0].payToValid, true)
    assert.equal(validation.assetKnown, true) // Base Sepolia USDC
  })
})

// ─── isValidEvmAddress ──────────────────────────────────────────────────────

describe('isValidEvmAddress', () => {
  it('accepts valid EVM address', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), true)
  })

  it('accepts uppercase hex', () => {
    assert.equal(isValidEvmAddress('0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913'), true)
  })

  it('rejects null', () => {
    assert.equal(isValidEvmAddress(null), false)
  })

  it('rejects without 0x prefix', () => {
    assert.equal(isValidEvmAddress('833589fcd6edb6e08f4c7c32d4f71b54bda02913'), false)
  })

  it('rejects too short', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda0291'), false)
  })

  it('rejects too long', () => {
    assert.equal(isValidEvmAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda029130'), false)
  })

  it('rejects non-hex chars', () => {
    assert.equal(isValidEvmAddress('0xzzzz89fcd6edb6e08f4c7c32d4f71b54bda02913'), false)
  })
})

// ─── isValidSolanaAddress ───────────────────────────────────────────────────

describe('isValidSolanaAddress', () => {
  it('accepts valid Solana address', () => {
    assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  })

  it('rejects null', () => {
    assert.equal(isValidSolanaAddress(null), false)
  })

  it('rejects too short (< 32 chars)', () => {
    assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G'), false) // 31 chars
  })

  it('rejects strings with invalid base58 chars (0, O, I, l)', () => {
    assert.equal(isValidSolanaAddress('0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), false)
  })

  it('accepts 32-char base58 string', () => {
    assert.equal(isValidSolanaAddress('11111111111111111111111111111111'), true) // '1' is valid base58, 32 chars
  })
})

// ─── isValidAssetAddress ────────────────────────────────────────────────────

describe('isValidAssetAddress', () => {
  it('accepts EVM address', () => {
    assert.equal(isValidAssetAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), true)
  })

  it('accepts Solana address', () => {
    assert.equal(isValidAssetAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  })

  it('rejects garbage', () => {
    assert.equal(isValidAssetAddress('not-an-address'), false)
  })
})

// ─── isKnownUSDC ────────────────────────────────────────────────────────────

describe('isKnownUSDC', () => {
  it('recognizes Base USDC', () => {
    const result = isKnownUSDC('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base')
  })

  it('recognizes Ethereum USDC', () => {
    const result = isKnownUSDC('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Ethereum')
  })

  it('is case-insensitive', () => {
    const result = isKnownUSDC('0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base')
  })

  it('returns unknown for random address', () => {
    const result = isKnownUSDC('0x' + 'a'.repeat(40))
    assert.equal(result.known, false)
    assert.equal(result.chain, null)
  })

  it('handles null', () => {
    const result = isKnownUSDC(null)
    assert.equal(result.known, false)
  })

  it('recognizes Base Sepolia USDC', () => {
    const result = isKnownUSDC('0x036cbd53842c5426634e7929541ec2318f3dcf7e')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Base Sepolia')
  })
})

// ─── extractFacilitatorUrl ──────────────────────────────────────────────────

describe('extractFacilitatorUrl', () => {
  it('extracts from extra.facilitatorUrl', () => {
    const url = extractFacilitatorUrl({ extra: { facilitatorUrl: 'https://x402.org/facilitator' } })
    assert.equal(url, 'https://x402.org/facilitator')
  })

  it('extracts from facilitatorData.facilitatorUrl (object)', () => {
    const url = extractFacilitatorUrl({ facilitatorData: { facilitatorUrl: 'https://example.com/f' } })
    assert.equal(url, 'https://example.com/f')
  })

  it('extracts from facilitatorData (JSON string)', () => {
    const url = extractFacilitatorUrl({
      facilitatorData: JSON.stringify({ facilitatorUrl: 'https://example.com/f' }),
    })
    assert.equal(url, 'https://example.com/f')
  })

  it('extracts from facilitatorData (URL string)', () => {
    const url = extractFacilitatorUrl({ facilitatorData: 'https://example.com/f' })
    assert.equal(url, 'https://example.com/f')
  })

  it('returns null for null input', () => {
    assert.equal(extractFacilitatorUrl(null), null)
  })

  it('returns null when no facilitator data', () => {
    assert.equal(extractFacilitatorUrl({ payTo: '0x123' }), null)
  })
})

// ─── validatePaymentRequirements ────────────────────────────────────────────

describe('validatePaymentRequirements', () => {
  const validEntry = {
    payTo: '0x1234567890abcdef1234567890abcdef12345678',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    network: 'eip155:8453',
    maxAmountRequired: '1000000',
    extra: { facilitatorUrl: 'https://x402.org/facilitator' },
  }

  it('validates a complete entry', () => {
    const result = validatePaymentRequirements([validEntry])
    assert.equal(result.valid, true)
    assert.equal(result.assetKnown, true)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].valid, true)
    assert.equal(result.entries[0].payToValid, true)
    assert.equal(result.entries[0].assetValid, true)
    assert.equal(result.entries[0].assetKnown, true)
    assert.equal(result.entries[0].assetChain, 'Base')
    assert.equal(result.facilitatorUrls.length, 1)
    assert.equal(result.facilitatorUrls[0], 'https://x402.org/facilitator')
  })

  it('marks entry invalid when payTo missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, payTo: undefined }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].hasPayTo, false)
    assert.equal(result.entries[0].valid, false)
  })

  it('marks entry invalid when payTo is malformed', () => {
    const result = validatePaymentRequirements([{ ...validEntry, payTo: 'not-an-address' }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].payToValid, false)
  })

  it('marks entry invalid when asset missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, asset: undefined }])
    assert.equal(result.valid, false)
  })

  it('marks entry invalid when amount missing', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: undefined }])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].hasAmount, false)
  })

  it('marks assetKnown false for unknown contract', () => {
    const result = validatePaymentRequirements([{
      ...validEntry,
      asset: '0x' + 'b'.repeat(40),
    }])
    assert.equal(result.valid, true)
    assert.equal(result.assetKnown, false)
    assert.equal(result.entries[0].assetKnown, false)
  })

  it('valid if at least one entry is valid (multi-entry)', () => {
    const result = validatePaymentRequirements([
      { payTo: 'garbage' }, // invalid
      validEntry,           // valid
    ])
    assert.equal(result.valid, true)
    assert.equal(result.entries[0].valid, false)
    assert.equal(result.entries[1].valid, true)
  })

  it('deduplicates facilitator URLs', () => {
    const entry2 = { ...validEntry, payTo: '0x' + 'c'.repeat(40) }
    const result = validatePaymentRequirements([validEntry, entry2])
    assert.equal(result.facilitatorUrls.length, 1)
  })

  it('returns empty facilitatorUrls when none present', () => {
    const noFac = { ...validEntry, extra: undefined }
    const result = validatePaymentRequirements([noFac])
    assert.equal(result.facilitatorUrls.length, 0)
  })

  it('returns invalid for empty array', () => {
    const result = validatePaymentRequirements([])
    assert.equal(result.valid, false)
  })

  it('returns invalid for null', () => {
    const result = validatePaymentRequirements(null)
    assert.equal(result.valid, false)
  })

  it('recognizes hasNetwork when network is present', () => {
    const result = validatePaymentRequirements([validEntry])
    assert.equal(result.entries[0].hasNetwork, true)
  })

  it('handles maxAmountRequired as number', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: 1000000 }])
    assert.equal(result.entries[0].hasAmount, true)
    assert.equal(result.valid, true)
  })

  it('handles maxAmountRequired as "0" (zero is valid)', () => {
    const result = validatePaymentRequirements([{ ...validEntry, maxAmountRequired: '0' }])
    assert.equal(result.entries[0].hasAmount, true)
  })

  it('accepts V2 amount field instead of maxAmountRequired', () => {
    const v2Entry = {
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      amount: '2000',
    }
    const result = validatePaymentRequirements([v2Entry])
    assert.equal(result.entries[0].hasAmount, true)
    assert.equal(result.valid, true)
  })

  it('accepts V1 maxAmountRequired (regression check)', () => {
    const result = validatePaymentRequirements([validEntry])
    assert.equal(result.entries[0].hasAmount, true)
    assert.equal(result.valid, true)
  })

  it('fails when neither amount nor maxAmountRequired is present', () => {
    const noAmount = {
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
    }
    const result = validatePaymentRequirements([noAmount])
    assert.equal(result.entries[0].hasAmount, false)
    assert.equal(result.valid, false)
  })
})

// ─── Detail page: x402 payment validation display ──────────────────────────

describe('detailPage — x402 payment validation', () => {
  it('shows x402 payment validation section for x402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Test x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'healthy',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: 1,
      x402_asset_known: 1,
      x402_facilitator_reachable: 1,
    })
    assert.ok(html.includes('x402 Payment Validation'))
    assert.ok(html.includes('Valid'))
    assert.ok(html.includes('Known USDC'))
    assert.ok(html.includes('Reachable'))
  })

  it('shows invalid state for x402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'Bad x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'degraded',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: 0,
      x402_asset_known: 0,
      x402_facilitator_reachable: 0,
    })
    assert.ok(html.includes('Invalid'))
    assert.ok(html.includes('Unknown asset'))
    assert.ok(html.includes('Unreachable'))
  })

  it('does not show x402 section for L402 services', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'L402 API',
      url: 'https://example.com/api',
      protocol: 'L402',
      health_status: 'healthy',
      source: 'exclusive',
      consecutive_failures: 0,
      health_checks: [],
    })
    assert.ok(!html.includes('x402 Payment Validation'))
  })

  it('shows dash when x402 fields are null', async () => {
    const { detailPage } = await import('../src/views/detail.js')
    const html = detailPage({
      name: 'New x402 API',
      url: 'https://example.com/api',
      protocol: 'x402',
      health_status: 'unknown',
      source: 'bazaar',
      consecutive_failures: 0,
      health_checks: [],
      x402_payment_valid: null,
      x402_asset_known: null,
      x402_facilitator_reachable: null,
    })
    assert.ok(html.includes('x402 Payment Validation'))
    // All three should show '—' (not Valid/Invalid/Reachable/etc.)
    const section = html.split('x402 Payment Validation')[1].split('</div>').slice(0, 10).join('</div>')
    assert.ok(!section.includes('>Valid<'))
    assert.ok(!section.includes('>Invalid<'))
  })
})

// ─── Query builder: payment_valid filter ────────────────────────────────────

describe('buildServiceQuery — payment_valid filter', () => {
  it('adds protocol-aware filter when payment_valid is true', async () => {
    const { buildServiceQuery } = await import('../src/queries/services.js')
    const result = buildServiceQuery({ payment_valid: 'true' })
    assert.ok(result.where.includes('x402_payment_valid = 1'))
    assert.ok(result.where.includes("protocol = 'L402'"))
    assert.ok(result.where.includes("health_status = 'healthy'"))
  })

  it('does not filter when payment_valid is absent', async () => {
    const { buildServiceQuery } = await import('../src/queries/services.js')
    const result = buildServiceQuery({})
    assert.ok(!result.where.includes('x402_payment_valid'))
  })

  it('API_COLUMNS includes x402 validation columns', async () => {
    const { API_COLUMNS } = await import('../src/queries/services.js')
    assert.ok(API_COLUMNS.includes('x402_payment_valid'))
    assert.ok(API_COLUMNS.includes('x402_facilitator_reachable'))
    assert.ok(API_COLUMNS.includes('x402_asset_known'))
  })

  it('PAGE_COLUMNS includes x402_payment_valid', async () => {
    const { PAGE_COLUMNS } = await import('../src/queries/services.js')
    assert.ok(PAGE_COLUMNS.includes('x402_payment_valid'))
  })
})

// ─── Homepage: payment_valid checkbox ───────────────────────────────────────

describe('homePage — payment_valid filter', () => {
  it('includes payment_valid checkbox', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('name="payment_valid"'))
    assert.ok(html.includes('402 header parsed'))
  })

  it('checkbox is checked when filter is active', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: { payment_valid: true },
      stats: { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })
    assert.ok(html.includes('name="payment_valid" value="true" checked'))
  })
})

// ─── Protocol bar: removed from directory page (moved to homepage) ──────────

describe('homePage — protocol bar chain colors', () => {
  it('directory page does not render protocol bar (moved to homepage)', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 100, totalIndexed: 500, healthy: 80, degraded: 10, down: 10, unknown: 0 },
      categories: [],
    })
    assert.ok(!html.includes('<div class="protocol-bar">'), 'protocol bar moved to homepage')
    assert.ok(!html.includes('class="stats-bar"'), 'stats bar moved to homepage')
  })
})

// ─── isLightningEntry ─────────────────────────────────────────────────────────

const VALID_BOLT11 = 'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'

describe('isLightningEntry', () => {
  it('returns true for entry with asset BTC + extra.paymentMethod lightning', () => {
    const entry = { asset: 'BTC', extra: { paymentMethod: 'lightning' } }
    assert.equal(isLightningEntry(entry), true)
  })

  it('returns false for standard EVM entry', () => {
    const entry = { asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payTo: '0x' + 'a'.repeat(40) }
    assert.equal(isLightningEntry(entry), false)
  })

  it('returns false for BTC without extra.paymentMethod', () => {
    const entry = { asset: 'BTC', payTo: 'anonymous' }
    assert.equal(isLightningEntry(entry), false)
  })

  it('returns false for non-BTC asset with lightning paymentMethod', () => {
    const entry = { asset: 'ETH', extra: { paymentMethod: 'lightning' } }
    assert.equal(isLightningEntry(entry), false)
  })
})

// ─── isKnownNativeAsset ──────────────────────────────────────────────────────

describe('isKnownNativeAsset', () => {
  it('recognizes BTC → { known: true, chain: "Bitcoin" }', () => {
    const result = isKnownNativeAsset('BTC')
    assert.equal(result.known, true)
    assert.equal(result.chain, 'Bitcoin')
  })

  it('returns unknown for random string', () => {
    const result = isKnownNativeAsset('DOGE')
    assert.equal(result.known, false)
    assert.equal(result.chain, null)
  })

  it('returns unknown for null', () => {
    const result = isKnownNativeAsset(null)
    assert.equal(result.known, false)
    assert.equal(result.chain, null)
  })
})

// ─── validatePaymentRequirements — Lightning entries ─────────────────────────

describe('validatePaymentRequirements — Lightning entries', () => {
  const lightningEntry = {
    scheme: 'exact',
    network: 'bip122:000000000019d6689c085ae165831e93',
    amount: '13000',
    asset: 'BTC',
    payTo: 'anonymous',
    maxTimeoutSeconds: 300,
    extra: {
      paymentMethod: 'lightning',
      invoice: VALID_BOLT11,
    },
  }

  it('accepts entry with asset BTC, payTo anonymous, valid BOLT11 in extra.invoice', () => {
    const result = validatePaymentRequirements([lightningEntry])
    assert.equal(result.valid, true)
    assert.equal(result.entries[0].valid, true)
    assert.equal(result.entries[0].payToValid, true)
    assert.equal(result.entries[0].assetValid, true)
    assert.equal(result.entries[0].hasAmount, true)
  })

  it('rejects entry with asset BTC, payTo anonymous, but NO invoice in extra', () => {
    const noInvoice = { ...lightningEntry, extra: { paymentMethod: 'lightning' } }
    const result = validatePaymentRequirements([noInvoice])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].valid, false)
    assert.equal(result.entries[0].hasAmount, false)
  })

  it('rejects entry with asset BTC, payTo anonymous, invalid BOLT11 in extra.invoice', () => {
    const badInvoice = { ...lightningEntry, extra: { paymentMethod: 'lightning', invoice: 'not-a-bolt11' } }
    const result = validatePaymentRequirements([badInvoice])
    assert.equal(result.valid, false)
    assert.equal(result.entries[0].valid, false)
    assert.equal(result.entries[0].hasAmount, false)
  })

  it('sets assetKnown true and assetChain Bitcoin for BTC entries', () => {
    const result = validatePaymentRequirements([lightningEntry])
    assert.equal(result.entries[0].assetKnown, true)
    assert.equal(result.entries[0].assetChain, 'Bitcoin')
    assert.equal(result.assetKnown, true)
  })

  it('mixed accepts array: one EVM entry + one Lightning entry — valid if either is valid', () => {
    const evmEntry = {
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      amount: '1000000',
    }
    const result = validatePaymentRequirements([evmEntry, lightningEntry])
    assert.equal(result.valid, true)
    assert.equal(result.entries.length, 2)
    // Both should be valid
    assert.equal(result.entries[0].valid, true)
    assert.equal(result.entries[1].valid, true)
  })
})
