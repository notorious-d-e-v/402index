/**
 * Ecosystem gap analysis for developer recruitment.
 * Identifies categories with poor coverage, missing protocols,
 * single-provider dependencies, and failing services.
 */

import { LISTED } from './visibility.js'

const ACTIVE_FILTER = LISTED

/**
 * Find ecosystem opportunities (gaps) for developers.
 * @param {Database} db
 * @param {{ protocol?: string }} opts
 * @returns {Array<object>} Array of opportunity objects
 */
export function findOpportunities(db, { protocol } = {}) {
  const protocolClause = protocol ? ` AND protocol = '${protocol === 'L402' ? 'L402' : 'x402'}'` : ''
  const opportunities = []

  // 1. Category gaps: categories with <=2 healthy endpoints but >0 total
  const gaps = db.prepare(`
    SELECT category,
      COUNT(*) as total,
      SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy,
      SUM(CASE WHEN protocol = 'L402' THEN 1 ELSE 0 END) as l402_count,
      SUM(CASE WHEN protocol = 'x402' THEN 1 ELSE 0 END) as x402_count
    FROM services
    WHERE ${ACTIVE_FILTER} AND category IS NOT NULL${protocolClause}
    GROUP BY category
    HAVING healthy <= 2 AND total >= 3
    ORDER BY total DESC
  `).all()

  for (const row of gaps) {
    const providers = getProviders(db, row.category, protocolClause)
    opportunities.push({
      type: 'gap',
      category: row.category,
      total_endpoints: row.total,
      healthy_endpoints: row.healthy,
      protocol_coverage: { L402: row.l402_count, x402: row.x402_count },
      provider_count: providers.size,
      providers: [...providers],
      suggestion: `Only ${row.healthy} of ${row.total} endpoints are healthy in ${row.category}. Opportunity for a reliable provider.`,
    })
  }

  // 2. Protocol gaps: categories with only one protocol
  if (!protocol) {
    const protocolGaps = db.prepare(`
      SELECT category,
        COUNT(*) as total,
        SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy,
        SUM(CASE WHEN protocol = 'L402' THEN 1 ELSE 0 END) as l402_count,
        SUM(CASE WHEN protocol = 'x402' THEN 1 ELSE 0 END) as x402_count
      FROM services
      WHERE ${ACTIVE_FILTER} AND category IS NOT NULL
      GROUP BY category
      HAVING (l402_count = 0 OR x402_count = 0) AND total >= 2
      ORDER BY total DESC
    `).all()

    for (const row of protocolGaps) {
      // Skip if already flagged as gap
      if (opportunities.some(o => o.category === row.category && o.type === 'gap')) continue

      const missing = row.l402_count === 0 ? 'L402' : 'x402'
      const present = row.l402_count === 0 ? 'x402' : 'L402'
      const providers = getProviders(db, row.category, '')
      opportunities.push({
        type: 'protocol_gap',
        category: row.category,
        total_endpoints: row.total,
        healthy_endpoints: row.healthy,
        protocol_coverage: { L402: row.l402_count, x402: row.x402_count },
        provider_count: providers.size,
        providers: [...providers],
        suggestion: `${row.category} has ${row[missing === 'L402' ? 'x402_count' : 'l402_count']} ${present} but no ${missing} endpoints. ${missing} provider needed.`,
      })
    }
  }

  // 3. Single-provider categories (>=2 endpoints, all same host)
  const allCategories = db.prepare(`
    SELECT category, url
    FROM services
    WHERE ${ACTIVE_FILTER} AND category IS NOT NULL${protocolClause}
  `).all()

  const categoryHosts = new Map()
  for (const row of allCategories) {
    let host
    try { host = new URL(row.url).hostname } catch { continue }
    if (!categoryHosts.has(row.category)) categoryHosts.set(row.category, new Set())
    categoryHosts.get(row.category).add(host)
  }

  for (const [category, hosts] of categoryHosts) {
    if (hosts.size === 1) {
      // Get count for this category
      const countRow = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy,
          SUM(CASE WHEN protocol = 'L402' THEN 1 ELSE 0 END) as l402_count,
          SUM(CASE WHEN protocol = 'x402' THEN 1 ELSE 0 END) as x402_count
        FROM services
        WHERE ${ACTIVE_FILTER} AND category = ?${protocolClause}
      `).get(category)

      if (countRow.total < 2) continue // Not interesting for single-endpoint categories
      if (opportunities.some(o => o.category === category && o.type === 'single_provider')) continue

      opportunities.push({
        type: 'single_provider',
        category,
        total_endpoints: countRow.total,
        healthy_endpoints: countRow.healthy,
        protocol_coverage: { L402: countRow.l402_count, x402: countRow.x402_count },
        provider_count: 1,
        providers: [...hosts],
        suggestion: `All ${countRow.total} endpoints in ${category} are from ${[...hosts][0]}. Diversity opportunity.`,
      })
    }
  }

  // 4. Failing services: categories with >=2 down endpoints
  const failing = db.prepare(`
    SELECT category,
      COUNT(*) as total,
      SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy,
      SUM(CASE WHEN health_status = 'down' THEN 1 ELSE 0 END) as down_count,
      SUM(CASE WHEN protocol = 'L402' THEN 1 ELSE 0 END) as l402_count,
      SUM(CASE WHEN protocol = 'x402' THEN 1 ELSE 0 END) as x402_count
    FROM services
    WHERE ${ACTIVE_FILTER} AND category IS NOT NULL${protocolClause}
    GROUP BY category
    HAVING down_count >= 2
    ORDER BY down_count DESC
  `).all()

  for (const row of failing) {
    if (opportunities.some(o => o.category === row.category && o.type === 'failing')) continue

    const providers = getProviders(db, row.category, protocolClause)
    opportunities.push({
      type: 'failing',
      category: row.category,
      total_endpoints: row.total,
      healthy_endpoints: row.healthy,
      protocol_coverage: { L402: row.l402_count, x402: row.x402_count },
      provider_count: providers.size,
      providers: [...providers],
      suggestion: `${row.down_count} endpoints in ${row.category} are down. Replacement opportunity.`,
    })
  }

  return opportunities
}

function getProviders(db, category, protocolClause) {
  const rows = db.prepare(`
    SELECT url FROM services
    WHERE ${ACTIVE_FILTER} AND category = ?${protocolClause}
  `).all(category)

  const hosts = new Set()
  for (const row of rows) {
    try { hosts.add(new URL(row.url).hostname) } catch { /* skip */ }
  }
  return hosts
}
