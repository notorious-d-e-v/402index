import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homePage } from '../src/views/home.js'
import { aboutPage } from '../src/views/about.js'

describe('directory page (formerly two-tier stats bar)', () => {
  it('does not render stats-bar or protocol-bar (moved to homepage)', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })

    assert.ok(!html.includes('class="stats-bar"'), 'stats-bar moved to homepage')
    assert.ok(!html.includes('class="protocol-bar"'), 'protocol-bar moved to homepage')
  })

  it('renders services table and filters', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: { verified: 0, totalIndexed: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 },
      categories: [],
    })

    assert.ok(html.includes('services-table'), 'should have services table')
    assert.ok(html.includes('filters'), 'should have filters section')
    assert.ok(html.includes('action="/directory"'), 'form should submit to /directory')
  })
})

describe('about page methodology', () => {
  it('includes methodology section', () => {
    const html = aboutPage()
    assert.ok(html.includes('Methodology'), 'should have Methodology heading')
    assert.ok(html.includes('Endpoints indexed'), 'should explain endpoints indexed')
    assert.ok(html.includes('402 header parsed'), 'should explain the 402-header-parsed mark')
    assert.ok(html.includes('WWW-Authenticate'), 'should mention L402 header')
    assert.ok(html.includes('PAYMENT-REQUIRED'), 'should mention x402 header')
    assert.ok(html.includes('Health status'), 'should explain health status')
    assert.ok(html.includes('every hour'), 'should mention check frequency')
  })
})
