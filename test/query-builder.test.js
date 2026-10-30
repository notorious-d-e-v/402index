import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buildServiceQuery, PAGE_COLUMNS } from '../src/queries/services.js'
import { withQuarantineSchema } from './helpers/test-db.js'

describe('buildServiceQuery', () => {
  it('returns defaults when called with no options', () => {
    const result = buildServiceQuery()
    assert.ok(result.where.includes("status = 'active' OR status IS NULL"))
    assert.deepEqual(result.params, {})
    assert.equal(result.limit, 50)
    assert.equal(result.offset, 0)
    assert.ok(result.orderBy.includes('featured DESC'))
  })

  it('handles limit=0 correctly (clamps to 1, not default 50)', () => {
    const result = buildServiceQuery({ rawLimit: '0' })
    assert.equal(result.limit, 1)
  })

  it('clamps limit to range [1, 200]', () => {
    assert.equal(buildServiceQuery({ rawLimit: '-5' }).limit, 1)
    assert.equal(buildServiceQuery({ rawLimit: '500' }).limit, 200)
    assert.equal(buildServiceQuery({ rawLimit: '100' }).limit, 100)
  })

  it('defaults limit to 50 for non-numeric input', () => {
    assert.equal(buildServiceQuery({ rawLimit: 'abc' }).limit, 50)
    assert.equal(buildServiceQuery({ rawLimit: '' }).limit, 50)
  })

  it('floors offset to 0', () => {
    assert.equal(buildServiceQuery({ rawOffset: '-10' }).offset, 0)
    assert.equal(buildServiceQuery({ rawOffset: 'abc' }).offset, 0)
    assert.equal(buildServiceQuery({ rawOffset: '5' }).offset, 5)
  })

  it('builds protocol filter with COLLATE NOCASE', () => {
    const result = buildServiceQuery({ protocol: 'L402' })
    assert.ok(result.where.includes('protocol = @protocol COLLATE NOCASE'))
    assert.equal(result.params.protocol, 'L402')
  })

  it('builds category filter with prefix match', () => {
    const result = buildServiceQuery({ category: 'crypto' })
    assert.ok(result.where.includes('@category'))
    assert.ok(result.where.includes('@categoryPrefix'))
    assert.equal(result.params.category, 'crypto')
    assert.equal(result.params.categoryPrefix, 'crypto/%')
  })

  it('builds health filter for valid values', () => {
    for (const v of ['healthy', 'degraded', 'down', 'unknown']) {
      const result = buildServiceQuery({ health: v })
      assert.ok(result.where.includes('health_status = @health'))
      assert.equal(result.params.health, v)
    }
  })

  it('ignores invalid health filter values', () => {
    const result = buildServiceQuery({ health: 'bogus' })
    assert.ok(!result.where.includes('health_status'))
    assert.equal(result.params.health, undefined)
  })

  it('ignores invalid source filter values', () => {
    const result = buildServiceQuery({ source: 'invalid' })
    assert.ok(!result.where.includes('source'))
    assert.equal(result.params.source, undefined)
  })

  it('ignores max_price_usd when NaN', () => {
    const result = buildServiceQuery({ max_price_usd: 'abc' })
    assert.ok(!result.where.includes('price_usd'))
    assert.equal(result.params.max_price_usd, undefined)
  })

  it('parses valid max_price_usd', () => {
    const result = buildServiceQuery({ max_price_usd: '0.01' })
    assert.ok(result.where.includes('price_usd <= @max_price_usd'))
    assert.equal(result.params.max_price_usd, 0.01)
  })

  it('treats q=* as match-all (no text search condition)', () => {
    const result = buildServiceQuery({ q: '*', protocol: 'L402', health: 'healthy' })
    // Wildcard * should NOT add a LIKE condition — it means "give me everything"
    assert.ok(!result.where.includes('LIKE @q'), 'q=* should not add LIKE filter')
    assert.equal(result.params.q, undefined, 'q=* should not set @q param')
    // But protocol and health filters should still be present
    assert.ok(result.where.includes('protocol = @protocol'))
    assert.ok(result.where.includes('health_status = @health'))
  })

  it('builds q filter as LIKE across name, description, and url', () => {
    const result = buildServiceQuery({ q: 'weather' })
    assert.ok(result.where.includes('name LIKE @q'))
    assert.ok(result.where.includes('description LIKE @q'))
    assert.ok(result.where.includes('url LIKE @q'))
    assert.equal(result.params.q, '%weather%')
  })

  it('q filter matches URL patterns (domain search)', () => {
    const result = buildServiceQuery({ q: 'sats4ai.com' })
    assert.ok(result.where.includes('url LIKE @q'), 'WHERE should include url LIKE')
    assert.equal(result.params.q, '%sats4ai.com%')
  })

  it('q filter matches URL path fragments', () => {
    const result = buildServiceQuery({ q: '/api/l402/' })
    assert.ok(result.where.includes('url LIKE @q'), 'WHERE should include url LIKE')
    assert.equal(result.params.q, '%/api/l402/%')
  })

  it('q filter uses OR across all three fields', () => {
    const result = buildServiceQuery({ q: 'lightningenable' })
    // Should be a single OR group matching name, description, and url
    assert.ok(result.where.includes("name LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\' OR url LIKE @q ESCAPE '\\'"),
      'WHERE should OR across name, description, and url')
  })

  // String-level ESCAPE assertions: fast unit regression checks.
  // The integration tests below (line ~190+) are the authoritative correctness tests.
  it('escapes LIKE metacharacters % and _ in q parameter', () => {
    const r1 = buildServiceQuery({ q: '100%' })
    // % inside the search term must be escaped so it doesn't act as a wildcard
    assert.equal(r1.params.q, '%100\\%%')
    assert.ok(r1.where.includes("ESCAPE '\\'"), 'WHERE should include ESCAPE clause')

    const r2 = buildServiceQuery({ q: 'test_value' })
    assert.equal(r2.params.q, '%test\\_value%')
    assert.ok(r2.where.includes("ESCAPE '\\'"), 'WHERE should include ESCAPE clause')

    const r3 = buildServiceQuery({ q: '%_combo_%' })
    assert.equal(r3.params.q, '%\\%\\_combo\\_\\%%')

    // Backslash itself must be escaped (doubled) so it doesn't act as ESCAPE char
    const r4 = buildServiceQuery({ q: 'path\\file' })
    assert.equal(r4.params.q, '%path\\\\file%')
  })

  it('builds featured filter for "true" and "1"', () => {
    const r1 = buildServiceQuery({ featured: 'true' })
    assert.ok(r1.where.includes('featured = 1'))
    const r2 = buildServiceQuery({ featured: '1' })
    assert.ok(r2.where.includes('featured = 1'))
    const r3 = buildServiceQuery({ featured: 'false' })
    assert.ok(!r3.where.includes('featured'))
  })

  it('uses custom sort column when provided', () => {
    const result = buildServiceQuery({ sort: 'price', order: 'desc' })
    assert.ok(result.orderBy.includes('price_usd DESC'))
  })

  it('falls back to default order for invalid sort', () => {
    const result = buildServiceQuery({ sort: 'bogus' })
    assert.ok(result.orderBy.includes('health_status'))
  })

  it('combines multiple filters with AND', () => {
    const result = buildServiceQuery({ protocol: 'x402', health: 'healthy', source: 'bazaar' })
    assert.ok(result.where.includes('AND'))
    assert.equal(result.params.protocol, 'x402')
    assert.equal(result.params.health, 'healthy')
    assert.equal(result.params.source, 'bazaar')
  })

  it('q query executes against SQLite without syntax error', () => {
    // Integration test: the LIKE ESCAPE clause must be valid SQL
        const db = Database(':memory:')
    db.exec(`CREATE TABLE services (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, url TEXT,
      protocol TEXT, status TEXT, provider_deleted INTEGER DEFAULT 0,
      price_sats REAL, price_usd REAL, payment_asset TEXT, payment_network TEXT,
      category TEXT, provider TEXT, source TEXT, featured INTEGER DEFAULT 0,
      health_status TEXT, uptime_30d REAL, latency_p50_ms INTEGER,
      last_checked TEXT, registered_at TEXT, http_method TEXT,
      reliability_score REAL, x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER, x402_asset_known INTEGER,
      l402_compliant INTEGER, l402_degrade_reason TEXT, l402_format TEXT,
      lnget_compatible INTEGER, domain_verified INTEGER DEFAULT 0
    )`)
    withQuarantineSchema(db)
    db.exec(`INSERT INTO services (name, description, url, protocol, status, health_status)
      VALUES ('PayPerQ Image Generation', 'AI image gen', 'https://ppq.ai/api', 'MPP', 'active', 'healthy')`)
    db.exec(`INSERT INTO services (name, description, url, protocol, status, health_status)
      VALUES ('Other Service', 'unrelated', 'https://other.com', 'L402', 'active', 'healthy')`)

    const { where, params, limit, offset, orderBy } = buildServiceQuery({ q: 'image generation' })
    const rows = db.prepare(
      `SELECT name FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'PayPerQ Image Generation')
  })

  it('q query with LIKE metacharacters executes without error', () => {
        const db = Database(':memory:')
    db.exec(`CREATE TABLE services (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, url TEXT,
      protocol TEXT, status TEXT, provider_deleted INTEGER DEFAULT 0,
      price_sats REAL, price_usd REAL, payment_asset TEXT, payment_network TEXT,
      category TEXT, provider TEXT, source TEXT, featured INTEGER DEFAULT 0,
      health_status TEXT, uptime_30d REAL, latency_p50_ms INTEGER,
      last_checked TEXT, registered_at TEXT, http_method TEXT,
      reliability_score REAL, x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER, x402_asset_known INTEGER,
      l402_compliant INTEGER, l402_degrade_reason TEXT, l402_format TEXT,
      lnget_compatible INTEGER, domain_verified INTEGER DEFAULT 0
    )`)
    withQuarantineSchema(db)
    db.exec(`INSERT INTO services (name, description, url, protocol, status, health_status)
      VALUES ('100% Uptime API', 'test', 'https://example.com', 'L402', 'active', 'healthy')`)

    const { where, params, limit, offset, orderBy } = buildServiceQuery({ q: '100%' })
    const rows = db.prepare(
      `SELECT name FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, '100% Uptime API')
  })

  it('q query with backslash in service name executes correctly', () => {
    const db = Database(':memory:')
    db.exec(`CREATE TABLE services (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, url TEXT,
      protocol TEXT, status TEXT, provider_deleted INTEGER DEFAULT 0,
      price_sats REAL, price_usd REAL, payment_asset TEXT, payment_network TEXT,
      category TEXT, provider TEXT, source TEXT, featured INTEGER DEFAULT 0,
      health_status TEXT, uptime_30d REAL, latency_p50_ms INTEGER,
      last_checked TEXT, registered_at TEXT, http_method TEXT,
      reliability_score REAL, x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER, x402_asset_known INTEGER,
      l402_compliant INTEGER, l402_degrade_reason TEXT, l402_format TEXT,
      lnget_compatible INTEGER, domain_verified INTEGER DEFAULT 0
    )`)
    withQuarantineSchema(db)
    db.exec(`INSERT INTO services (name, description, url, protocol, status, health_status)
      VALUES ('foo\\bar API', 'backslash test', 'https://example.com', 'L402', 'active', 'healthy')`)
    db.exec(`INSERT INTO services (name, description, url, protocol, status, health_status)
      VALUES ('foobar API', 'no backslash', 'https://other.com', 'L402', 'active', 'healthy')`)

    const { where, params, limit, offset, orderBy } = buildServiceQuery({ q: 'foo\\bar' })
    const rows = db.prepare(
      `SELECT name FROM services ${where} ${orderBy} LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'foo\\bar API')
  })

  // ─── probe_status filter integration (issue #236) ──────────────────────
  // In-memory SQLite test: insert rows with mixed probe_status, execute the
  // generated SQL, and assert only the matching rows are returned.

  it('probe_status filter executes against in-memory SQLite', () => {
    const db = Database(':memory:')
    db.exec(`CREATE TABLE services (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, url TEXT,
      protocol TEXT, status TEXT, provider_deleted INTEGER DEFAULT 0,
      price_sats REAL, price_usd REAL, payment_asset TEXT, payment_network TEXT,
      category TEXT, provider TEXT, source TEXT, featured INTEGER DEFAULT 0,
      health_status TEXT, uptime_30d REAL, latency_p50_ms INTEGER,
      last_checked TEXT, registered_at TEXT, http_method TEXT,
      reliability_score REAL, x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER, x402_asset_known INTEGER,
      l402_compliant INTEGER, l402_degrade_reason TEXT, l402_format TEXT,
      lnget_compatible INTEGER, domain_verified INTEGER DEFAULT 0,
      probe_status TEXT DEFAULT 'probeable'
    )`)
    withQuarantineSchema(db)
    db.exec(`INSERT INTO services (name, url, protocol, status, health_status, probe_status)
      VALUES ('Probeable Svc', 'https://a.com', 'x402', 'active', 'healthy', 'probeable')`)
    db.exec(`INSERT INTO services (name, url, protocol, status, health_status, probe_status)
      VALUES ('Unprobeable Svc', 'https://b.mpp.paywithlocus.com', 'MPP', 'active', 'unknown', 'unprobeable')`)
    db.exec(`INSERT INTO services (name, url, protocol, status, health_status, probe_status)
      VALUES ('Default Svc', 'https://c.com', 'L402', 'active', 'healthy', 'probeable')`)

    // Filter for unprobeable only
    const unp = buildServiceQuery({ probe_status: 'unprobeable' })
    const unpRows = db.prepare(
      `SELECT name FROM services ${unp.where} ${unp.orderBy} LIMIT @limit OFFSET @offset`
    ).all({ ...unp.params, limit: unp.limit, offset: unp.offset })
    assert.equal(unpRows.length, 1)
    assert.equal(unpRows[0].name, 'Unprobeable Svc')

    // Filter for probeable only
    const pro = buildServiceQuery({ probe_status: 'probeable' })
    const proRows = db.prepare(
      `SELECT name FROM services ${pro.where} ${pro.orderBy} LIMIT @limit OFFSET @offset`
    ).all({ ...pro.params, limit: pro.limit, offset: pro.offset })
    assert.equal(proRows.length, 2)
    const proNames = proRows.map(r => r.name).sort()
    assert.deepEqual(proNames, ['Default Svc', 'Probeable Svc'])
  })

  // ─── Sort parameter validation (issue #234) ──────────────────────────
  // These tests document the security-critical invariant that invalid sort
  // values are blocked by the SORT_COLUMNS allowlist and fall back to
  // DEFAULT_ORDER. This is a coverage-only change — the implementation is
  // already correct.

  const DEFAULT_ORDER = `ORDER BY
    featured DESC,
    domain_verified DESC,
    CASE WHEN featured = 1 THEN 0 ELSE CASE WHEN category != 'uncategorized' THEN 0 ELSE 1 END END,
    CASE health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 WHEN 'down' THEN 2 WHEN 'unknown' THEN 3 END,
    name`

  it('valid sort=name produces ORDER BY with name column', () => {
    const result = buildServiceQuery({ sort: 'name' })
    assert.ok(result.orderBy.includes('name'), 'orderBy should contain the name column')
    assert.ok(result.orderBy.includes('featured DESC'), 'orderBy should still lead with featured DESC')
    assert.notEqual(result.orderBy, DEFAULT_ORDER, 'should not be default order')
  })

  it('valid sort values map to correct SQL columns', () => {
    const cases = {
      name: 'name',
      price: 'price_usd',
      latency: 'latency_p50_ms',
      uptime: 'uptime_30d',
      reliability: 'reliability_score',
      registered_at: 'registered_at',
    }
    for (const [key, col] of Object.entries(cases)) {
      const result = buildServiceQuery({ sort: key })
      assert.ok(result.orderBy.includes(col),
        `sort=${key} should produce ORDER BY containing ${col}`)
    }
  })

  it('SQL injection in sort falls back to DEFAULT_ORDER', () => {
    const injections = [
      'CASE WHEN 1=1 THEN name ELSE url END',
      'DROP TABLE services',
      "name; DROP TABLE services; --",
      "1 OR 1=1",
      "name' OR '1'='1",
    ]
    for (const payload of injections) {
      const result = buildServiceQuery({ sort: payload })
      assert.equal(result.orderBy, DEFAULT_ORDER,
        `sort="${payload}" must fall back to DEFAULT_ORDER`)
    }
  })

  it('arbitrary invalid sort strings fall back to DEFAULT_ORDER', () => {
    const invalids = ['bogus', '', 'Name', 'PRICE', 'unknown_col', 'id', 'status']
    for (const val of invalids) {
      const result = buildServiceQuery({ sort: val })
      assert.equal(result.orderBy, DEFAULT_ORDER,
        `sort="${val}" must fall back to DEFAULT_ORDER`)
    }
  })

  it('sort=name with order=desc produces DESC', () => {
    const result = buildServiceQuery({ sort: 'name', order: 'desc' })
    assert.ok(result.orderBy.includes('name DESC'))
  })

  it('sort=name with order=asc produces ASC', () => {
    const result = buildServiceQuery({ sort: 'name', order: 'asc' })
    assert.ok(result.orderBy.includes('name ASC'))
  })

  it('invalid order value defaults to ASC', () => {
    const invalids = ['invalid', 'DROP', '', 'ascending', "asc'; DROP TABLE --"]
    for (const val of invalids) {
      const result = buildServiceQuery({ sort: 'name', order: val })
      assert.ok(result.orderBy.includes('ASC'),
        `order="${val}" must default to ASC`)
      assert.ok(!result.orderBy.includes('DESC') || result.orderBy.indexOf('DESC') < result.orderBy.indexOf('ASC'),
        `order="${val}" must not produce DESC for the sort column`)
    }
  })

  it('undefined sort with no options uses DEFAULT_ORDER', () => {
    const result = buildServiceQuery({})
    assert.equal(result.orderBy, DEFAULT_ORDER)
  })

  it('builds payment_asset filter', () => {
    const result = buildServiceQuery({ payment_asset: 'BTC' })
    assert.ok(result.where.includes('payment_asset = @payment_asset'))
    assert.equal(result.params.payment_asset, 'BTC')
  })

  it('PAGE_COLUMNS includes payment_network', () => {
    assert.ok(PAGE_COLUMNS.includes('payment_network'), 'PAGE_COLUMNS should include payment_network')
  })
})
