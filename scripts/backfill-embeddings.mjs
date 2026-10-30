#!/usr/bin/env node

// Operator-invoked backfill for the vector index (vec_service_embeddings), the only vector
// store since 2026-10-27. Requires sqlite-vec.
// NOT wired into boot, cron, or CI. Run manually:
//   node scripts/backfill-embeddings.mjs --yes [--dry-run] [--force] [--batch-size N] [--rate-limit N]

const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536

// ─── Usage ───────────────────────────────────────────────────────────────────

function printUsage() {
  console.log('Usage: node scripts/backfill-embeddings.mjs --yes [--dry-run] [--force] [--batch-size N] [--rate-limit N]')
  console.log('')
  console.log('Flags:')
  console.log('  --help, -h     Show this help message')
  console.log('  --yes          Required to proceed (safety gate)')
  console.log('  --dry-run      Print counts and exit without calling OpenAI')
  console.log('  --force        Re-embed rows that already have embeddings')
  console.log('  --batch-size N Rows per batch (default 50)')
  console.log('  --rate-limit N Milliseconds between batches (default 3000)')
}

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    help: false,
    yes: false,
    dryRun: false,
    force: false,
    batchSize: 50,
    rateLimit: 3000,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--yes') args.yes = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--force') args.force = true
    else if (arg === '--batch-size' && argv[i + 1]) args.batchSize = parseInt(argv[++i], 10)
    else if (arg === '--rate-limit' && argv[i + 1]) args.rateLimit = parseInt(argv[++i], 10)
  }
  return args
}

// ─── OpenAI caller with retries ──────────────────────────────────────────────

async function callOpenAIWithRetry(text, apiKey, url) {
  const delays = [1000, 2000, 4000]
  let lastErr

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, input: text }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`OpenAI ${res.status}: ${body?.error?.message || 'unknown'}`)
      }

      const body = await res.json()
      const values = body.data?.[0]?.embedding
      if (!values || values.length !== DIMENSIONS) {
        throw new Error('unexpected response shape from OpenAI')
      }

      return new Float32Array(values)
    } catch (err) {
      lastErr = err
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, delays[attempt]))
      }
    }
  }

  throw lastErr
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  if (!args.yes) {
    printUsage()
    process.exit(1)
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is not set')
    process.exit(1)
  }

  // Dynamic imports — inside main() so the outer try/catch handles init errors
  const { default: db, SQLITE_VEC_AVAILABLE, ensureVecIndex, syncVecEmbedding } = await import('../src/db.js')
  const { composeEmbeddingInput, OPENAI_EMBEDDINGS_URL } = await import('../src/services/embeddings.js')

  if (!SQLITE_VEC_AVAILABLE || !ensureVecIndex(db)) {
    console.error('Error: sqlite-vec is not available — the vec index is the only place vectors are stored')
    process.exit(1)
  }

  // Query for services needing embeddings
  const query = args.force
    ? 'SELECT id, name, description, category FROM services ORDER BY id ASC'
    : `SELECT s.id, s.name, s.description, s.category
       FROM services s
       WHERE NOT EXISTS (SELECT 1 FROM vec_service_embeddings v WHERE v.service_id = s.id)
       ORDER BY s.id ASC`

  const services = db.prepare(query).all()

  // Count orphans
  // vec0 is a virtual table and cannot carry a foreign key, so orphans are found by hand.
  const findOrphans = db.prepare(
    'SELECT service_id FROM vec_service_embeddings WHERE service_id NOT IN (SELECT id FROM services)'
  )
  const orphanCount = findOrphans.all().length

  if (args.dryRun) {
    console.log(JSON.stringify({ would_embed: services.length, would_delete_orphans: orphanCount }))
    process.exit(0)
  }

  const startTime = Date.now()
  let embedded = 0
  let failed = 0

  // Process in batches
  for (let i = 0; i < services.length; i += args.batchSize) {
    const batch = services.slice(i, i + args.batchSize)

    for (const service of batch) {
      const inputText = composeEmbeddingInput(service)

      try {
        const embedding = await callOpenAIWithRetry(inputText, apiKey, OPENAI_EMBEDDINGS_URL)
        if (!syncVecEmbedding(service.id, Buffer.from(embedding.buffer), db)) {
          throw new Error('vec index write failed')
        }
        embedded++
      } catch (err) {
        console.error(`[backfill] failed service_id=${service.id}: ${err.message}`)
        failed++
      }
    }

    // Rate limit between batches (not after the last one)
    if (args.rateLimit > 0 && i + args.batchSize < services.length) {
      await new Promise(r => setTimeout(r, args.rateLimit))
    }
  }

  // Orphan cleanup pass
  const deleteOrphan = db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?')
  let orphansDeleted = 0
  for (const { service_id } of findOrphans.all()) orphansDeleted += deleteOrphan.run(service_id).changes

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
  const summary = { total: services.length, embedded, failed, orphans_deleted: orphansDeleted, elapsed_seconds: elapsedSeconds }
  console.log(JSON.stringify(summary))

  process.exit(failed > 0 ? 2 : 0)
}

try {
  await main()
} catch (err) {
  console.error(`[backfill] Fatal: ${err.message}`)
  process.exit(1)
}
