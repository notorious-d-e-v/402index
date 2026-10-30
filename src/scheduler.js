import { loadListings, loadFeatured } from './listings.js'
import { pollBazaar } from './aggregators/bazaar.js'
import { pollSatring } from './aggregators/satring.js'
import { pollL402Apps } from './aggregators/l402apps.js'
import { pollSponge } from './aggregators/sponge.js'
import { pollL402Directory } from './aggregators/l402directory.js'
import { pollMPP } from './aggregators/mpp.js'
import { pollMppscan } from './aggregators/mppscan.js'
import { pollPayai } from './aggregators/payai.js'
import { runHealthChecks } from './health/checker.js'
import { classifyServices } from './services/classify.js'
import { captureSnapshot } from './services/daily-snapshot.js'
import db from './db.js'
import { recordSchedulerEvent } from './services/scheduler-events.js'

let healthCheckRunning = false
let lastSnapshotDate = null

export function isHealthCheckRunning() {
  return healthCheckRunning
}

/**
 * Refresh featured flags + template/demo classification after a poll.
 *
 * Never throws. Both calls write to SQLite, so on a full volume they raise SQLITE_FULL; when that
 * escaped an uncaught `.then()` it became an unhandled rejection and killed the process (the
 * 2026-07-22 crash loop). Poll failures are logged and skipped, per CLAUDE.md: "log and continue
 * for aggregator/health failures — never crash the server."
 *
 * @returns {boolean} true if both refreshes succeeded.
 */
export function refreshDerivedState({ featured = loadFeatured, classify = classifyServices } = {}) {
  try {
    featured()
    classify()
    return true
  } catch (err) {
    console.error('[scheduler] Derived-state refresh failed:', err.message)
    return false
  }
}

function runPolls() {
  return Promise.all([
    // PayAI runs after the Bazaar so URLs listed on both are already Bazaar rows when PayAI sees them.
    pollBazaar().catch(err => console.error('[scheduler] Bazaar poll failed:', err.message))
      .then(() => pollPayai().catch(err => console.error('[scheduler] PayAI poll failed:', err.message))),
    pollSatring().catch(err => console.error('[scheduler] Satring poll failed:', err.message)),
  ])
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] Bazaar/Satring cycle failed:', err.message))
}

function runL402AppsPoll() {
  return pollL402Apps()
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] l402apps poll failed:', err.message))
}

function runSpongePoll() {
  return pollSponge()
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] sponge poll failed:', err.message))
}

function runL402DirectoryPoll() {
  return pollL402Directory()
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] l402directory poll failed:', err.message))
}

function runMPPPoll() {
  return pollMPP()
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] MPP poll failed:', err.message))
}

function runMppscanPoll() {
  return pollMppscan()
    .then(() => refreshDerivedState())
    .catch(err => console.error('[scheduler] MPPscan poll failed:', err.message))
}

function runHealthCheckGuarded() {
  if (healthCheckRunning) {
    // A sweep longer than the interval swallows ticks; record each one so the digest shows it.
    recordSchedulerEvent(db, { job: 'health', event: 'skipped', reason: 'previous-run-active' })
    return
  }
  healthCheckRunning = true
  runHealthChecks()
    .then(() => runDailySnapshot())
    .catch(err => console.error('[scheduler] Health check failed:', err.message))
    .finally(() => { healthCheckRunning = false })
}

function runDailySnapshot() {
  const today = new Date().toISOString().slice(0, 10)
  if (lastSnapshotDate === today) return
  try {
    const result = captureSnapshot()
    lastSnapshotDate = today
    console.log(`[scheduler] Daily snapshot captured: ${result.snapshot_date} (${result.total_endpoints} endpoints)`)
  } catch (err) {
    console.error('[scheduler] Daily snapshot failed:', err.message)
  }
}

/** Call once after the HTTP server is listening. */
export function startScheduler() {
  loadListings()
  loadFeatured()
  runPolls()
  runL402AppsPoll()
  runSpongePoll()
  runL402DirectoryPoll()
  runMPPPoll()
  runMppscanPoll()

  const bazaarInterval = parseInt(process.env.BAZAAR_POLL_INTERVAL_MS) || 3600000
  setInterval(runPolls, bazaarInterval)

  // l402apps + sponge: daily poll (sites update infrequently)
  const l402appsInterval = parseInt(process.env.L402APPS_POLL_INTERVAL_MS) || 86400000
  setInterval(runL402AppsPoll, l402appsInterval)

  const spongeInterval = parseInt(process.env.SPONGE_POLL_INTERVAL_MS) || 86400000
  setInterval(runSpongePoll, spongeInterval)

  // l402directory: hourly poll (small directory, fast API, no rate limits)
  const l402dirInterval = parseInt(process.env.L402DIR_POLL_INTERVAL_MS) || 3600000
  setInterval(runL402DirectoryPoll, l402dirInterval)

  // MPP: hourly poll (simple API, no rate limits)
  const mppInterval = parseInt(process.env.MPP_POLL_INTERVAL_MS) || 3600000
  setInterval(runMPPPoll, mppInterval)

  // MPPscan: daily poll (unannounced API, avoid hammering)
  const mppscanInterval = parseInt(process.env.MPPSCAN_POLL_INTERVAL_MS) || 86400000
  setInterval(runMppscanPoll, mppscanInterval)

  // Delay health checks 30s to let polls finish first
  setTimeout(runHealthCheckGuarded, 30000)
  const healthInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 3600000
  setInterval(runHealthCheckGuarded, healthInterval)
}

export function shutdown(server, signal) {
  console.log(`[scheduler] ${signal} received, shutting down gracefully...`)
  server.close(() => {
    console.log('[scheduler] HTTP server closed')
    if (!healthCheckRunning) {
      process.exit(0)
    }
  })
  if (healthCheckRunning) {
    console.log('[scheduler] Waiting for health check batch to finish...')
    const check = setInterval(() => {
      if (!healthCheckRunning) {
        clearInterval(check)
        console.log('[scheduler] Health check complete, exiting')
        process.exit(0)
      }
    }, 500)
    setTimeout(() => {
      console.warn('[scheduler] Forced exit after 30s timeout')
      process.exit(1)
    }, 30000)
  }
}
