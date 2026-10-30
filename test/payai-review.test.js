import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import db from '../src/db.js'
import { pollPayai } from '../src/aggregators/payai.js'
import { queryServices } from '../src/queries/services.js'

const originalFetch = globalThis.fetch
const url = n => `https://payai-review.example.com/${n}`
const offer = (network = 'eip155:8453') => ({ network, scheme: 'exact', amount: '10000' })
const item = (n, accepts = [offer()]) => ({
  resource: url(n), type: 'http', x402Version: 2, description: 'Review fixture', accepts,
  extensions: { bazaar: { info: { input: { type: 'http', method: 'POST' } } } },
})
const row = n => db.prepare('SELECT * FROM services WHERE url = ?').get(url(n))
const passes = () => db.prepare('SELECT * FROM payai_passes ORDER BY pass_id').all()
function seed(n, source = 'payai') {
  db.prepare('INSERT INTO services (id, url, protocol, name, source, hostname) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), url(n), 'x402', 'Original', source, new URL(url(n)).hostname)
}
function serve(pages, total = pages.flat().length) {
  const calls = []
  globalThis.fetch = async raw => {
    const offset = Number(new URL(raw).searchParams.get('offset'))
    calls.push(offset)
    const items = pages[offset / 100]
    return items === undefined
      ? { ok: false, status: 500 }
      : { ok: true, status: 200, json: async () => ({ items, pagination: { total, limit: 100, offset } }) }
  }
  return calls
}

beforeEach(() => {
  db.exec('DELETE FROM services; DELETE FROM sync_state; DELETE FROM quarantined_hosts;')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'payai_passes'").get()) db.exec('DELETE FROM payai_passes')
  delete process.env.PAYAI_MAX_PAGES
})
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.PAYAI_MAX_PAGES })

describe('PayAI review regressions', () => {
  it('rejects tunnels and IP hosts before insertion, with domain boundaries', async () => {
    const hosts = ['a.srv.us', 'rewards-144-91-97-140.sslip.io', '1.2.3.4.nip.io',
      'a.trycloudflare.com', 'a.ngrok.io', 'a.ngrok-free.app', 'a.ngrok.app', 'a.ts.net',
      'a.lhr.life', '8.8.8.8', '[2606:4700::1111]', 'SELLER.SRV.US.']
    serve([[...hosts.map(host => ({ ...item(1), resource: `https://${host}/pay` })),
      { ...item(1), resource: 'https://srv.us.example.com/pay' }]])
    const result = await pollPayai()
    assert.equal(result.new, 1)
    assert.equal(db.prepare('SELECT url FROM services').get().url, 'https://srv.us.example.com/pay')
  })

  it('skips testnet-only offers and uses a mainnet offer from a mixed resource', async () => {
    const networks = ['eip155:84532', 'base-sepolia', 'solana-devnet', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'eip155:97', 'bsc-testnet', 'eip155:43113', 'avalanche-fuji', 'eip155:713715', 'sei-testnet',
      'eip155:80002', 'polygon-amoy', 'eip155:1952', 'xlayer-testnet',
      'eip155:324705682', 'skale-base-sepolia', 'eip155:421614', 'arbitrum-sepolia']
    serve([[...networks.map((network, i) => item(i, [offer(network)])),
      item('mixed', [{ ...offer('eip155:84532'), amount: '9990000' }, offer()])]])
    await pollPayai()
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 1)
    assert.equal(row('mixed').payment_network, 'eip155:8453')
    assert.equal(row('mixed').price_usd, 0.01)
  })

  it('records separate presence without changing shared ownership or moderation', async () => {
    seed('shared', 'bazaar')
    seed('deleted')
    db.prepare('UPDATE services SET provider_deleted = 1 WHERE url = ?').run(url('deleted'))
    serve([[item('shared'), item('deleted')]])
    await pollPayai()
    assert.equal(row('shared').source, 'bazaar')
    assert.equal(row('shared').name, 'Original')
    assert.ok(row('shared').payai_seen_pass)
    assert.equal(row('deleted').provider_deleted, 1)
    assert.equal(row('deleted').name, 'Original')
  })

  it('skips quarantined and held hosts but permits released hosts', async () => {
    for (const state of ['quarantined', 'held', 'released']) {
      db.prepare('INSERT INTO quarantined_hosts (hostname, state) VALUES (?, ?)').run(`${state}.example.com`, state)
    }
    serve([['quarantined', 'held', 'released'].map(state => ({ ...item(state), resource: `https://${state}.example.com/pay` }))])
    const result = await pollPayai()
    assert.equal(result.new, 1)
    assert.equal(db.prepare('SELECT hostname FROM services').get().hostname, 'released.example.com')
  })

  it('caps work and resumes its first pass without retiring anything early', async () => {
    process.env.PAYAI_MAX_PAGES = '1'
    seed('absent')
    const pages = [Array.from({ length: 100 }, (_, i) => item(i)), [item(100)]]
    const calls = serve(pages)
    await pollPayai()
    assert.deepEqual(calls, [0])
    assert.equal(passes().length, 0)
    assert.equal(row('absent').upstream_missing_since, null)
    await pollPayai()
    assert.deepEqual(calls, [0, 100])
    assert.equal(passes()[0].complete, 1)
    assert.equal(passes()[0].seen, 101)
    assert.ok(row('absent').upstream_missing_since)
  })

  it('retires only PayAI-owned rows after seven complete absences and restores churn relists', async () => {
    serve([[item('kept'), item('missing')]])
    await pollPayai()
    seed('shared', 'bazaar')
    serve([[item('kept')]])
    for (let i = 0; i < 6; i++) await pollPayai()
    assert.equal(row('missing').status, 'active')
    await pollPayai()
    assert.equal(row('missing').status, 'retired')
    assert.match(row('missing').retired_batch, /^payai-auto-pass-/)
    assert.equal(row('shared').status, 'active')
    assert.equal(row('shared').upstream_missing_since, null)
    serve([[item('missing')]])
    await pollPayai()
    for (const key of ['upstream_missing_since', 'retired_batch', 'retired_at']) assert.equal(row('missing')[key], null)
    assert.equal(row('missing').status, 'active')
  })

  it('does not undo a manual retirement', async () => {
    seed('manual')
    db.prepare("UPDATE services SET status = 'retired', retired_batch = 'operator-review' WHERE url = ?").run(url('manual'))
    serve([[item('manual')]])
    await pollPayai()
    assert.equal(row('manual').status, 'retired')
    assert.equal(row('manual').retired_batch, 'operator-review')
  })

  it('keeps incomplete and malformed responses out of retirement evidence', async () => {
    seed('absent')
    serve([[item('kept')]], 50)
    await pollPayai()
    assert.equal(passes()[0].complete, 0)
    assert.equal(row('absent').upstream_missing_since, null)
    serve([[item('bad')]], 'not-a-total')
    await pollPayai()
    assert.equal(row('bad'), undefined)
    assert.equal(passes().length, 1)
  })

  it('counts deliberately filtered rows toward coverage of the raw catalog', async () => {
    seed('absent')
    serve([[...Array.from({ length: 99 }, (_, i) => item(i, [offer('base-sepolia')])), item('kept')]])
    await pollPayai()
    assert.equal(passes()[0].seen, 100)
    assert.equal(passes()[0].complete, 1)
    assert.ok(row('absent').upstream_missing_since)
  })

  it('does not treat malformed items as intentional policy exclusions', async () => {
    seed('absent')
    serve([[null, { resource: url('malformed'), accepts: 'invalid' }]])
    const result = await pollPayai()
    assert.equal(result.errors, 2)
    assert.equal(passes()[0].complete, 0)
    assert.equal(row('absent').upstream_missing_since, null)
  })

  it('resumes after an HTTP failure without double-counting committed pages', async () => {
    const first = Array.from({ length: 100 }, (_, i) => item(i))
    const calls = serve([first], 101)
    await pollPayai()
    assert.deepEqual(calls, [0, 100])
    assert.equal(passes().length, 0)
    const resumed = serve([first, [item(100)]], 101)
    await pollPayai()
    assert.deepEqual(resumed, [100])
    assert.equal(passes()[0].seen, 101)
    assert.equal(passes()[0].complete, 1)
  })

  it('uses a new pass id when an unfinished pass expires', async () => {
    process.env.PAYAI_MAX_PAGES = '1'
    serve([Array.from({ length: 100 }, (_, i) => item(i))], 101)
    await pollPayai()
    const abandoned = row(1).payai_seen_pass
    db.prepare("UPDATE sync_state SET value = '2000-01-01T00:00:00Z' WHERE key = 'payai_pass_started_at'").run()
    const calls = serve([[item('new')]])
    await pollPayai()
    assert.deepEqual(calls, [0])
    assert.ok(row('new').payai_seen_pass > abandoned)
    assert.ok(row(1).upstream_missing_since)
    assert.equal(passes().length, 1)
  })

  it('executes the public payai source filter against SQLite', async () => {
    seed('other', 'bazaar')
    serve([[item('owned')]])
    await pollPayai()
    const result = queryServices(db, { source: 'payai' })
    assert.equal(result.total, 1)
    assert.equal(result.services[0].url, url('owned'))
  })

  it('preserves v2 POST and keeps it when a later declaration omits a method', async () => {
    serve([[item('post')]])
    await pollPayai()
    assert.equal(row('post').http_method, 'POST')
    serve([[{ ...item('post'), extensions: undefined }]])
    await pollPayai()
    assert.equal(row('post').http_method, 'POST')
  })
})
