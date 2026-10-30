import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, unlinkSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'backfill-embeddings.mjs')

// Helper to run inline ESM code in a child process with :memory: DB
function runCode(code, { envOverrides = {}, expectFail = false } = {}) {
  const env = {
    ...process.env,
    DB_PATH: ':memory:',
    OPENAI_API_KEY: '',
    ...envOverrides,
  }
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    })
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 }
  } catch (err) {
    if (expectFail) {
      return {
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
        exitCode: err.status,
      }
    }
    throw err
  }
}

// Inline helper: generates fake embedding response + tracks fetch calls
const FAKE_FETCH = `
function makeFakeResponse() {
  const arr = new Array(1536).fill(0).map((_, i) => i * 0.001)
  return { data: [{ embedding: arr }] }
}
let fetchCallCount = 0
global.fetch = async (url, opts) => {
  fetchCallCount++
  const body = JSON.parse(opts.body)
  if (global.__failPattern && body.input.includes(global.__failPattern)) {
    throw new Error('simulated OpenAI failure')
  }
  return { ok: true, json: async () => makeFakeResponse() }
}
`

// Inline helper: intercept process.exit so post-import verification can run
const EXIT_TRAP = `
let __exitCode = null
const __realExit = process.exit.bind(process)
process.exit = (code) => { __exitCode = code ?? 0 }
`

// Inline helper: call real exit with the captured code
const EXIT_FLUSH = `__realExit(__exitCode ?? 0)`

const SEED_SERVICES = (n, prefix = 'svc') => `
import db from './src/db.js'
for (let i = 1; i <= ${n}; i++) {
  db.prepare("INSERT OR IGNORE INTO services (id, name, url, protocol, source) VALUES (?, ?, ?, 'L402', 'test')").run('${prefix}'+i, '${prefix}Svc'+i, 'http://${prefix}'+i+'.test')
}
`

describe('backfill-embeddings script (#140)', () => {

  it('a: no --yes flag exits 1 with usage message', () => {
    const code = `
      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}']
      await import('./scripts/backfill-embeddings.mjs')
    `
    const { stdout, stderr, exitCode } = runCode(code, { expectFail: true })
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`)
    const output = stdout + stderr
    assert.ok(output.includes('--yes'), `usage message should mention --yes, got: ${output}`)
  })

  it('b: --yes without OPENAI_API_KEY exits 1 with error naming the env var', () => {
    const code = `
      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes']
      await import('./scripts/backfill-embeddings.mjs')
    `
    const { stdout, stderr, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: '' },
      expectFail: true,
    })
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`)
    const output = stdout + stderr
    assert.ok(output.includes('OPENAI_API_KEY'), `should mention OPENAI_API_KEY, got: ${output}`)
  })

  it('c: --dry-run --yes prints count and exits 0 without calling OpenAI', () => {
    const code = `
      global.fetch = () => { throw new Error('fetch should not be called in dry-run') }

      ${SEED_SERVICES(2, 'dry')}

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--dry-run', '--yes']
      await import('./scripts/backfill-embeddings.mjs')
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('would_embed'), `should print would_embed, got: ${stdout}`)
  })

  it('d: seeds 3 services, embeds all, verifies fetch count and summary', () => {
    const code = `
      ${FAKE_FETCH}
      ${EXIT_TRAP}
      ${SEED_SERVICES(3)}

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--batch-size', '2', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')

      // Verify embeddings were written (db already imported by SEED_SERVICES)
      const rows = db.prepare('SELECT service_id FROM vec_service_embeddings ORDER BY service_id').all()
      if (rows.length !== 3) {
        console.error('FAIL: expected 3 embedding rows, got ' + rows.length)
        __realExit(99)
      }
      const ids = rows.map(r => r.service_id).join(',')
      if (ids !== 'svc1,svc2,svc3') {
        console.error('FAIL: wrong service_ids: ' + ids)
        __realExit(99)
      }
      if (fetchCallCount !== 3) {
        console.error('FAIL: expected 3 fetch calls, got ' + fetchCallCount)
        __realExit(99)
      }
      ${EXIT_FLUSH}
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`)
    assert.ok(stdout.includes('embedded'), `summary should include embedded, got: ${stdout}`)
    assert.ok(stdout.includes('"total":'), `summary should include total field, got: ${stdout}`)
    assert.ok(!stdout.includes('"skipped":'), `summary should not include skipped field, got: ${stdout}`)
  })

  it('e: idempotency — second run triggers zero fetches', () => {
    const tmpDb = '/tmp/backfill-test-e-' + process.pid + '-' + Date.now() + '.db'

    try {
      // First run: seed and embed 3 services
      const first = runCode(`
        ${FAKE_FETCH}
        ${EXIT_TRAP}
        ${SEED_SERVICES(3)}

        process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--rate-limit', '0']
        await import('./scripts/backfill-embeddings.mjs')

        if (fetchCallCount !== 3) {
          console.error('FAIL: first run expected 3 fetches, got ' + fetchCallCount)
          __realExit(99)
        }
        ${EXIT_FLUSH}
      `, { envOverrides: { DB_PATH: tmpDb, OPENAI_API_KEY: 'fake-key' } })
      assert.equal(first.exitCode, 0, `first run: exit ${first.exitCode}, stderr: ${first.stderr}`)

      // Second run: same DB, should make zero OpenAI calls
      const second = runCode(`
        ${FAKE_FETCH}
        ${EXIT_TRAP}

        process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--rate-limit', '0']
        await import('./scripts/backfill-embeddings.mjs')

        if (fetchCallCount !== 0) {
          console.error('FAIL: second run expected 0 fetches, got ' + fetchCallCount)
          __realExit(99)
        }

        import db from './src/db.js'
        const unembedded = db.prepare(
          'SELECT COUNT(*) as c FROM services s WHERE NOT EXISTS (SELECT 1 FROM vec_service_embeddings v WHERE v.service_id = s.id)'
        ).get().c
        if (unembedded !== 0) {
          console.error('FAIL: expected 0 unembedded, got ' + unembedded)
          __realExit(99)
        }
        ${EXIT_FLUSH}
      `, { envOverrides: { DB_PATH: tmpDb, OPENAI_API_KEY: 'fake-key' } })
      assert.equal(second.exitCode, 0, `second run: exit ${second.exitCode}, stderr: ${second.stderr}`)
      assert.ok(second.stdout.includes('"total":'), `second run summary should have total field, got: ${second.stdout}`)
    } finally {
      for (const suffix of ['', '-shm', '-wal']) {
        try { unlinkSync(tmpDb + suffix) } catch {}
      }
    }
  })

  it('f: --force re-embeds all rows (fetch called 3 times)', () => {
    const code = `
      ${FAKE_FETCH}
      ${EXIT_TRAP}
      ${SEED_SERVICES(3)}

      // Pre-populate embeddings (db already imported by SEED_SERVICES)
      const blob = Buffer.from(new Float32Array(1536).fill(0.025).buffer)
      for (let i = 1; i <= 3; i++) {
        db.prepare('INSERT INTO vec_service_embeddings (service_id, embedding) VALUES (?, ?)').run('svc'+i, blob)
      }

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--force', '--batch-size', '50', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')

      if (fetchCallCount !== 3) {
        console.error('FAIL: expected 3 fetch calls with --force, got ' + fetchCallCount)
        __realExit(99)
      }
      ${EXIT_FLUSH}
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('embedded'), `should show summary, got: ${stdout}`)
  })

  it('g: orphan cleanup — deletes embedding rows with no parent service', () => {
    const code = `
      ${FAKE_FETCH}
      ${EXIT_TRAP}

      import db from './src/db.js'
      // Seed one real service
      db.prepare("INSERT OR IGNORE INTO services (id, name, url, protocol, source) VALUES ('real1', 'Real', 'http://r.test', 'L402', 'test')").run()

      // Insert orphan vector (vec0 carries no foreign key)
      db.prepare('INSERT INTO vec_service_embeddings (service_id, embedding) VALUES (?, ?)').run('orphan1', Buffer.from(new Float32Array(1536).fill(0.025).buffer))

      const before = db.prepare("SELECT COUNT(*) as c FROM vec_service_embeddings WHERE service_id = 'orphan1'").get().c
      if (before !== 1) { console.error('FAIL: orphan not seeded'); __realExit(99) }

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--batch-size', '50', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')

      const after = db.prepare("SELECT COUNT(*) as c FROM vec_service_embeddings WHERE service_id = 'orphan1'").get().c
      if (after !== 0) { console.error('FAIL: orphan not deleted, count=' + after); __realExit(99) }
      ${EXIT_FLUSH}
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('orphans_deleted'), `should report orphans_deleted, got: ${stdout}`)
  })

  it('h: failure handling — retries 3x, 5 total fetches, exits 2', () => {
    const code = `
      ${FAKE_FETCH}
      ${EXIT_TRAP}
      global.__failPattern = 'failSvc'

      import db from './src/db.js'
      db.prepare("INSERT OR IGNORE INTO services (id, name, url, protocol, source) VALUES ('ok1', 'okSvc1', 'http://ok1.test', 'L402', 'test')").run()
      db.prepare("INSERT OR IGNORE INTO services (id, name, url, protocol, source) VALUES ('fail1', 'failSvc', 'http://fail.test', 'L402', 'test')").run()
      db.prepare("INSERT OR IGNORE INTO services (id, name, url, protocol, source) VALUES ('ok2', 'okSvc2', 'http://ok2.test', 'L402', 'test')").run()

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--batch-size', '50', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')

      // 3 retries on failSvc + 1 ok1 + 1 ok2 = 5 total fetch calls
      if (fetchCallCount !== 5) {
        console.error('FAIL: expected 5 total fetch calls, got ' + fetchCallCount)
        __realExit(99)
      }
      ${EXIT_FLUSH}
    `
    const { stdout, stderr, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
      expectFail: true,
    })
    assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`)
    const output = stdout + stderr
    assert.ok(output.includes('failed'), `should report failed count, got: ${output}`)
    assert.ok(output.includes('"total":'), `summary should include total field, got: ${output}`)
  })

  it('i: composition helper is imported, not duplicated in script', () => {
    const scriptSource = readFileSync(SCRIPT, 'utf8')
    assert.ok(
      !scriptSource.includes('${service.name}\\n${service.description'),
      'Script must NOT contain inline composition logic — should import composeEmbeddingInput'
    )
    assert.ok(
      scriptSource.includes('composeEmbeddingInput'),
      'Script must import composeEmbeddingInput from embeddings.js'
    )
  })

  it('k: fatal error — unwritable DB path exits 1 with Fatal:', () => {
    const code = `
      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes']
      await import('./scripts/backfill-embeddings.mjs')
    `
    const { stdout, stderr, exitCode } = runCode(code, {
      envOverrides: {
        DB_PATH: '/dev/null/impossible.db',
        OPENAI_API_KEY: 'fake-key',
      },
      expectFail: true,
    })
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`)
    const output = stdout + stderr
    assert.ok(output.includes('Fatal:'), `should contain Fatal:, got: ${output.slice(0, 500)}`)
  })

  it('l: batch-size and rate-limit observables', () => {
    const code = `
      function makeFakeResponse() {
        const arr = new Array(1536).fill(0).map((_, i) => i * 0.001)
        return { data: [{ embedding: arr }] }
      }
      let fetchCallCount = 0
      const fetchTimestamps = []
      global.fetch = async (url, opts) => {
        fetchCallCount++
        fetchTimestamps.push(Date.now())
        return { ok: true, json: async () => makeFakeResponse() }
      }

      ${EXIT_TRAP}
      ${SEED_SERVICES(5, 'batch')}

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--batch-size', '2', '--rate-limit', '150']
      await import('./scripts/backfill-embeddings.mjs')

      // Compute inter-call gaps
      const gaps = []
      for (let i = 1; i < fetchTimestamps.length; i++) {
        gaps.push(fetchTimestamps[i] - fetchTimestamps[i - 1])
      }

      // Batches of 2,2,1 means 2 inter-batch delays (should each be >120ms)
      const largeGaps = gaps.filter(g => g > 120)
      if (largeGaps.length < 2) {
        console.error('FAIL: expected >=2 inter-batch gaps >120ms, got ' + largeGaps.length + ', gaps: ' + JSON.stringify(gaps))
        __realExit(99)
      }

      // Intra-batch gaps at indices 0,2 should be <50ms
      const intraBatchIndices = [0, 2]
      for (const idx of intraBatchIndices) {
        if (gaps[idx] !== undefined && gaps[idx] >= 50) {
          console.error('FAIL: intra-batch gap[' + idx + '] too large: ' + gaps[idx] + 'ms, gaps: ' + JSON.stringify(gaps))
          __realExit(99)
        }
      }

      ${EXIT_FLUSH}
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`)
    assert.ok(stdout.includes('"total":'), `summary should include total field, got: ${stdout}`)
  })

  it('m: --force with mixed state re-embeds all', () => {
    const code = `
      ${FAKE_FETCH}
      ${EXIT_TRAP}
      ${SEED_SERVICES(3, 'mix')}

      // Pre-embed 2 of 3 with old model (db already imported by SEED_SERVICES)
      const blob = Buffer.from(new Float32Array(1536).fill(0.025).buffer)
      db.prepare('INSERT INTO vec_service_embeddings (service_id, embedding) VALUES (?, ?)').run('mix1', blob)
      db.prepare('INSERT INTO vec_service_embeddings (service_id, embedding) VALUES (?, ?)').run('mix2', blob)

      process.argv = ['node', '${SCRIPT.replace(/\\/g, '\\\\')}', '--yes', '--force', '--batch-size', '50', '--rate-limit', '0']
      await import('./scripts/backfill-embeddings.mjs')

      if (fetchCallCount !== 3) {
        console.error('FAIL: expected 3 fetch calls with --force, got ' + fetchCallCount)
        __realExit(99)
      }

      const rows = db.prepare('SELECT service_id, embedding FROM vec_service_embeddings ORDER BY service_id').all()
      if (rows.length !== 3) {
        console.error('FAIL: expected 3 embedding rows, got ' + rows.length)
        __realExit(99)
      }
      // The pre-seeded vectors were constant 0.025; a re-embed replaces them with the fake response.
      const allReplaced = rows.every(r => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 1536)[1] !== 0.02500000037252903)
      if (!allReplaced) {
        console.error('FAIL: not every vector was re-embedded')
        __realExit(99)
      }

      ${EXIT_FLUSH}
    `
    const { stdout, exitCode } = runCode(code, {
      envOverrides: { OPENAI_API_KEY: 'fake-key' },
    })
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`)
    assert.ok(stdout.includes('"total":'), `summary should include total field, got: ${stdout}`)
  })
})
