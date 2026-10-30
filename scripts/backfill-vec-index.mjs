#!/usr/bin/env node

// Retired 2026-10-27. This script copied float32 vectors from service_embeddings into the
// sqlite-vec index. service_embeddings no longer holds vectors — it was a 1.7 GB duplicate
// that nothing in production read — so there is nothing left to copy from.
//
// To fill gaps in the index, re-embed with scripts/backfill-embeddings.mjs, which writes the
// vec index directly. A full re-embed of ~215k services is ~7.4M tokens (~$0.15).

console.error('backfill-vec-index is retired: service_embeddings no longer stores vectors.')
console.error('Fill index gaps with: node scripts/backfill-embeddings.mjs --yes [--dry-run]')
process.exit(1)
