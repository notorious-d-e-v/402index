import crypto from 'crypto'
import { DEPRECATED_ENV_URL, DEPRECATED_ENV_API_KEY, DEPRECATED_GATEWAY } from './partner-gateway-aliases.js'

class StubL402Provider {
  async createChallenge() { return null }
  async verifyToken() { return { valid: false } }
  async getStatus() { return null }
}

class MockL402Provider {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MockL402Provider cannot be used in production')
    }
  }

  async createChallenge(priceSats, durationHours) {
    const macaroon = crypto.randomBytes(32).toString('base64')
    const paymentHash = crypto.randomBytes(32).toString('hex')
    return {
      macaroon,
      invoice: `lnbc${priceSats}n1mock_invoice_for_testing`,
      paymentHash,
    }
  }

  async verifyToken(authorization) {
    // Accept any well-formed L402 token: base64:hex64
    const match = authorization.match(/^L402\s+(\S+):([a-f0-9]{64})$/i)
    if (!match) return { valid: false }
    return {
      valid: true,
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    }
  }

  async getStatus() {
    return {
      healthy: true,
      activeMacaroons: 0,
      paidMacaroons: 0,
      unpaidMacaroons: 0,
      satsEarnedTotal: 0,
    }
  }
}

class PartnerGatewayL402Provider {
  constructor() {
    this.baseUrl = process.env.PARTNER_GATEWAY_URL
    if (!this.baseUrl && process.env[DEPRECATED_ENV_URL]) {
      console.warn('[l402-provider] GOLEM_INTERNAL_URL is deprecated, use PARTNER_GATEWAY_URL')
      this.baseUrl = process.env[DEPRECATED_ENV_URL]
    }
    if (!this.baseUrl) this.baseUrl = 'http://partner.railway.internal:8402'

    this.apiKey = process.env.PARTNER_GATEWAY_API_KEY
    if (!this.apiKey && process.env[DEPRECATED_ENV_API_KEY]) {
      console.warn('[l402-provider] GOLEM_API_KEY is deprecated, use PARTNER_GATEWAY_API_KEY')
      this.apiKey = process.env[DEPRECATED_ENV_API_KEY]
    }
    if (!this.apiKey) {
      throw new Error('PARTNER_GATEWAY_API_KEY is required (set PARTNER_GATEWAY_API_KEY or deprecated GOLEM_API_KEY)')
    }
  }

  async createChallenge(priceSats, durationHours) {
    const res = await fetch(`${this.baseUrl}/l402/challenge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.apiKey,
      },
      body: JSON.stringify({ price_sats: priceSats, duration_hours: durationHours }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`Partner gateway challenge returned ${res.status}`)
    return await res.json()
  }

  async verifyToken(authorization) {
    const res = await fetch(`${this.baseUrl}/l402/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.apiKey,
      },
      body: JSON.stringify({ authorization }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`Partner gateway verify returned ${res.status}`)
    return await res.json()
  }

  /**
   * Read the gateway's own payment counters. This is the only source of truth for whether
   * anything has ever been paid for — the index keeps no macaroon or token table — so the
   * digest cites it rather than inferring revenue from traffic rank.
   *
   * Short timeout and no retry: this feeds a reporting block, and a slow gateway must not
   * hold the digest open. Callers are expected to treat a throw as "unknown", not "zero".
   */
  async getStatus() {
    const res = await fetch(`${this.baseUrl}/l402/status`, {
      headers: { 'Authorization': 'Bearer ' + this.apiKey },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`Partner gateway status returned ${res.status}`)
    return await res.json()
  }
}

let provider = null

/** Reset the cached singleton (for testing). */
export function resetProvider() { provider = null }

export function getProvider() {
  if (provider) return provider

  const gateway = (process.env.L402_GATEWAY || 'none').toLowerCase()

  switch (gateway) {
    case 'mock':
      provider = new MockL402Provider()
      break
    case 'partner':
      provider = new PartnerGatewayL402Provider()
      break
    case DEPRECATED_GATEWAY:
      console.warn(`[l402-provider] L402_GATEWAY='${DEPRECATED_GATEWAY}' is deprecated, use 'partner'`)
      provider = new PartnerGatewayL402Provider()
      break
    default:
      provider = new StubL402Provider()
      break
  }

  return provider
}
