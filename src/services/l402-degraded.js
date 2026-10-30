/**
 * What to say when the L402 gateway cannot mint a challenge.
 *
 * Two call sites reach this — the export.csv route and the free-tier rate limiter — and
 * before 2026-08-03 they disagreed. export.csv answered with a bare 402 telling the caller
 * to add `?l402=require`; `?l402=require` answered with `429 Rate limit exceeded, try again
 * later`. During the Boltz outage that pair formed a loop: the 402 sent the agent to the
 * 429, and the 429 told it to come back in 60 seconds, forever.
 *
 * The honest answer is 503. The paywall is not asking for payment (it cannot take any) and
 * the caller has not exhausted anything. `reason` is machine-readable so an agent can tell
 * this apart from a real rate limit without parsing prose.
 */

/**
 * Default seconds to tell a client to wait, overridable with
 * `L402_UNAVAILABLE_RETRY_AFTER_SECONDS`.
 *
 * Was 300 when this was written on 2026-08-03, sized for an outage of unknown but probably
 * short length. On 2026-08-05 Boltz said the shutdown is indefinite — no ETA, "do not expect
 * swap services to resume shortly", and the company is openly unsure whether swaps resume at
 * all. Five minutes against that is a smaller version of the lie this module exists to stop:
 * it tells a caller the problem is nearly over when nobody knows that it is.
 *
 * An hour is the floor. It is long enough to stop poll loops and short enough that a client
 * checking politely notices a replacement rail the same day. Operators can raise it from the
 * environment when there is a reason to, without shipping code.
 */
export const DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS = 3600

/** Read per-request so the env var takes effect without a restart. */
export function unavailableRetryAfterSeconds() {
  const configured = parseInt(process.env.L402_UNAVAILABLE_RETRY_AFTER_SECONDS, 10)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS
}

/**
 * Send the 503 for "the Lightning payment rail cannot issue an invoice".
 *
 * No WWW-Authenticate header: that header exists to carry a challenge, and there isn't one.
 * Emitting an empty or stale one would leave clients trying to pay an invoice we never made.
 *
 * The wording deliberately avoids "temporarily" and "shortly". We do not know when, or
 * whether, this comes back, and saying otherwise is the failure mode this module was written
 * to remove.
 *
 * @param {import('express').Response} res
 * @param {string} [detail] Optional operator-facing hint appended to the message.
 */
export function sendGatewayUnavailable(res, detail) {
  const retryAfter = unavailableRetryAfterSeconds()

  const message =
    'The Lightning payment rail is unavailable, so no invoice can be issued. ' +
    'This is an upstream failure with no estimated restoration time, not a rate limit — ' +
    'retrying will not clear it. Unpaid free-tier endpoints are unaffected.'

  return res
    .status(503)
    .set('Retry-After', String(retryAfter))
    .json({
      error: 'Service Unavailable',
      reason: 'l402_gateway_unavailable',
      message: detail ? `${message} (${detail})` : message,
      retry_after: retryAfter,
    })
}
