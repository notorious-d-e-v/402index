import rateLimit from 'express-rate-limit'
import { getProvider } from '../services/l402-provider.js'
import { sendGatewayUnavailable } from '../services/l402-degraded.js'

const L402_ENABLED = () => process.env.L402_ENABLED === 'true'
const L402_PRICE_SATS = () => parseInt(process.env.L402_PRICE_SATS) || 500
const L402_DURATION_HOURS = () => parseInt(process.env.L402_DURATION_HOURS) || 24

async function sendL402Challenge(req, res) {
  try {
    const provider = getProvider()
    const challenge = await provider.createChallenge(L402_PRICE_SATS(), L402_DURATION_HOURS())

    if (challenge) {
      const wwwAuth = `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`
      return res.status(402).set('WWW-Authenticate', wwwAuth).json({
        error: 'Payment Required',
        message: 'Rate limit exceeded. Pay the Lightning invoice to continue.',
        invoice: challenge.invoice,
        macaroon: challenge.macaroon,
        payment_hash: challenge.paymentHash,
        price_sats: L402_PRICE_SATS(),
        duration_hours: L402_DURATION_HOURS(),
      })
    }
  } catch (err) {
    // The gateway could not mint a challenge. Answering 429 here is a lie with teeth:
    // `?l402=require` sets the free limit to 0 on purpose, so the "rate limit" the client
    // hit is one we manufactured in order to sell it something. On 2026-08-03 an agent
    // followed export.csv's own advice to add `?l402=require` and got
    // "Rate limit exceeded. Try again later." every 70 minutes for a Boltz outage that
    // retrying would never clear.
    console.error('[l402] Challenge creation failed:', err.message)
    return sendGatewayUnavailable(res)
  }

  // No challenge, no error — no gateway is configured, so there is nothing to sell and the
  // client really did exhaust the free tier. 429 is the truth in this branch.
  return res.status(429).set('Retry-After', '60').json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Try again later.',
    retry_after: 60,
  })
}

/**
 * Free tier rate limiter: 100 req/min, skipped if L402 verified.
 * Responds with L402 challenge (if enabled) or 429 when limit is exceeded.
 * @type {import('express').RequestHandler}
 */
export const freeLimiter = rateLimit({
  windowMs: 60_000,
  limit: (req) => req.query.l402 === 'require' ? 0 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: { keyGeneratorIpFallback: false },
  skip: (req) => req.l402Verified === true,
  handler: async (req, res) => {
    if (L402_ENABLED()) {
      return sendL402Challenge(req, res)
    }
    res.status(429).set('Retry-After', '60').json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Try again later.',
      retry_after: 60,
    })
  },
})

/**
 * Digest API rate limiter: 10 req/hour.
 * @type {import('express').RequestHandler}
 */
export const digestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Digest rate limit exceeded. Limit: 10 per hour.',
      retry_after: 3600,
    })
  },
})

/**
 * Query rate limiters: guard the ?q= semantic-search path against OpenAI cost abuse.
 * Both limiters skip when ?q= is absent or '*' (no OpenAI call) and when the
 * request is L402-verified (already paid, passes through l402Limiter instead).
 *
 * Env vars: QUERY_RATE_LIMIT_PER_MIN (default 30), QUERY_RATE_LIMIT_PER_HOUR (default 500).
 * Both limits are arrow functions evaluated per-request so the env vars take effect
 * immediately without a server restart (e.g. in tests that set them after module import).
 */
function isQueryRequest(req) {
  return Boolean(req.query.q) && req.query.q !== '*' && req.l402Verified !== true
}

export const queryRateLimiterMin = rateLimit({
  windowMs: 60_000,
  limit: () => parseInt(process.env.QUERY_RATE_LIMIT_PER_MIN) || 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: { keyGeneratorIpFallback: false },
  skip: (req) => !isQueryRequest(req),
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '60').json({
      error: 'Too Many Requests',
      message: `Query rate limit exceeded. Limit: ${parseInt(process.env.QUERY_RATE_LIMIT_PER_MIN) || 30} per minute.`,
      retry_after: 60,
    })
  },
})

export const queryRateLimiterHour = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => parseInt(process.env.QUERY_RATE_LIMIT_PER_HOUR) || 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: { keyGeneratorIpFallback: false },
  skip: (req) => !isQueryRequest(req),
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '3600').json({
      error: 'Too Many Requests',
      message: `Query rate limit exceeded. Limit: ${parseInt(process.env.QUERY_RATE_LIMIT_PER_HOUR) || 500} per hour.`,
      retry_after: 3600,
    })
  },
})

/**
 * L402 tier rate limiter: 1000 req/min, only applies to L402-verified requests.
 * @type {import('express').RequestHandler}
 */
export const l402Limiter = rateLimit({
  windowMs: 60_000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: { keyGeneratorIpFallback: false },
  skip: (req) => req.l402Verified !== true,
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '60').json({
      error: 'Too Many Requests',
      message: 'L402 rate limit exceeded. Try again later.',
      retry_after: 60,
    })
  },
})
