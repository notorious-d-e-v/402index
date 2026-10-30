import { layout } from './layout.js'
import { escapeHtml, safeJsonEmbed } from './helpers.js'

function formatNumber(n) {
  return Number(n).toLocaleString('en-US')
}

function pct(part, total) {
  if (!total) return '0%'
  return Math.round((part / total) * 100) + '%'
}

export function demoPage({ stats, probeSample, featuredServices = [], meta = {} }) {
  const s = stats
  const probe = probeSample

  const content = `
  <div class="container demo-page">
    <div class="demo-header">
      <h1>402 Index</h1>
      <p class="demo-subtitle">The paid API directory for AI agents — indexed, verified, and searchable</p>
    </div>

    <!-- ─── Panel 1: Ecosystem Dashboard ──────────────────────────────── -->
    <section class="demo-panel demo-ecosystem">
      <h2>Ecosystem Overview</h2>

      <div class="demo-stat-cards">
        <div class="demo-stat-card">
          <div class="demo-stat-number">${formatNumber(s.totalIndexed)}</div>
          <div class="demo-stat-label">Endpoints Indexed</div>
        </div>
        <div class="demo-stat-card demo-stat-verified">
          <div class="demo-stat-number">${formatNumber(s.verified)}</div>
          <div class="demo-stat-label">402 Header Parsed</div>
        </div>
        <div class="demo-stat-card">
          <div class="demo-stat-number">${formatNumber(s.distinctProviders)}</div>
          <div class="demo-stat-label">Providers Indexed</div>
        </div>
        <div class="demo-stat-card demo-stat-verified">
          <div class="demo-stat-number">${formatNumber(s.verifiedProviders)}</div>
          <div class="demo-stat-label">Providers Verified</div>
        </div>
      </div>

      <div class="demo-protocol-compare">
        <div class="demo-protocol-card demo-protocol-l402">
          <div class="demo-protocol-title"><span class="badge badge-l402">L402</span> Lightning Network</div>
          <div class="demo-protocol-stats">
            <div class="demo-protocol-row"><span>Verified</span><strong>${s.l402.verified} / ${formatNumber(s.l402.endpoints)} (${pct(s.l402.verified, s.l402.endpoints)})</strong></div>
            <div class="demo-protocol-row"><span>Providers</span><strong>${s.l402.providers} / ${s.l402.allProviders} (${pct(s.l402.providers, s.l402.allProviders)})</strong></div>
            <div class="demo-protocol-row"><span>Healthy</span><strong>${s.l402.healthy}</strong></div>
          </div>
          <div class="demo-protocol-note">Decentralized, censorship-resistant, locally verifiable</div>
        </div>
        <div class="demo-protocol-card demo-protocol-x402">
          <div class="demo-protocol-title"><span class="badge badge-x402">x402</span> Base, Solana, etc.</div>
          <div class="demo-protocol-stats">
            <div class="demo-protocol-row"><span>Verified</span><strong>${s.x402.verified} / ${formatNumber(s.x402.endpoints)} (${pct(s.x402.verified, s.x402.endpoints)})</strong></div>
            <div class="demo-protocol-row"><span>Providers</span><strong>${s.x402.providers} / ${s.x402.allProviders} (${pct(s.x402.providers, s.x402.allProviders)})</strong></div>
            <div class="demo-protocol-row"><span>Healthy</span><strong>${s.x402.healthy}</strong></div>
          </div>
          <div class="demo-protocol-note">Centralized facilitator required (4+ available), Base/Solana chains</div>
        </div>
        <div class="demo-protocol-card demo-protocol-mpp">
          <div class="demo-protocol-title"><span class="badge badge-mpp">MPP</span> Stripe / Tempo</div>
          <div class="demo-protocol-stats">
            <div class="demo-protocol-row"><span>Verified</span><strong>${s.mpp.verified} / ${formatNumber(s.mpp.endpoints)} (${pct(s.mpp.verified, s.mpp.endpoints)})</strong></div>
            <div class="demo-protocol-row"><span>Verified (gateway-backed)</span><strong>${s.mpp.gatewayVerified} / ${formatNumber(s.mpp.gatewayEndpoints)} (${pct(s.mpp.gatewayVerified, s.mpp.gatewayEndpoints)})</strong></div>
            <div class="demo-protocol-row"><span>Providers</span><strong>${s.mpp.providers} / ${s.mpp.allProviders} (${pct(s.mpp.providers, s.mpp.allProviders)})</strong></div>
            <div class="demo-protocol-row"><span>Healthy</span><strong>${s.mpp.healthy}</strong></div>
          </div>
          <div class="demo-protocol-note">Stripe/Tempo facilitated, session-based settlement</div>
        </div>
      </div>

      <div class="demo-health-bars">
        <h3>Health Breakdown</h3>
        <div class="demo-health-row">
          <span class="health-dot health-healthy"></span>
          <span class="demo-health-label">healthy</span>
          <div class="demo-health-bar"><div class="demo-health-fill demo-fill-healthy" style="width: ${s.totalIndexed ? (s.healthy / s.totalIndexed * 100).toFixed(1) : 0}%"></div></div>
          <span class="demo-health-count">${formatNumber(s.healthy)}</span>
        </div>
        <div class="demo-health-row">
          <span class="health-dot health-degraded"></span>
          <span class="demo-health-label">degraded</span>
          <div class="demo-health-bar"><div class="demo-health-fill demo-fill-degraded" style="width: ${s.totalIndexed ? (s.degraded / s.totalIndexed * 100).toFixed(1) : 0}%"></div></div>
          <span class="demo-health-count">${formatNumber(s.degraded)}</span>
        </div>
        <div class="demo-health-row">
          <span class="health-dot health-down"></span>
          <span class="demo-health-label">down</span>
          <div class="demo-health-bar"><div class="demo-health-fill demo-fill-down" style="width: ${s.totalIndexed ? (s.down / s.totalIndexed * 100).toFixed(1) : 0}%"></div></div>
          <span class="demo-health-count">${formatNumber(s.down)}</span>
        </div>
        <div class="demo-health-row">
          <span class="health-dot health-unknown"></span>
          <span class="demo-health-label">unknown</span>
          <div class="demo-health-bar"><div class="demo-health-fill demo-fill-unknown" style="width: ${s.totalIndexed ? (s.unknown / s.totalIndexed * 100).toFixed(1) : 0}%"></div></div>
          <span class="demo-health-count">${formatNumber(s.unknown)}</span>
        </div>
        <div class="demo-last-checked">Last checked: ${escapeHtml(s.lastHealthCheck || 'Never')}</div>
      </div>
    </section>

    <div class="demo-twin-panel">
    <!-- ─── Panel 2: Interactive MCP Search ───────────────────────────── -->
    <section class="demo-panel demo-search">
      <h2>Agent Discovery</h2>
      <p class="demo-panel-desc">Search the directory like an AI agent would through the MCP server</p>

      <div class="demo-search-form">
        <input type="text" class="demo-search-input" id="demo-q" placeholder="Search APIs (e.g., weather, crypto, tools)..." />
        <div class="demo-filter-chips">
          <div class="demo-filter-group">
            <label>Protocol</label>
            <select id="demo-protocol">
              <option value="">All</option>
              <option value="L402">L402</option>
              <option value="x402">x402</option>
              <option value="MPP">MPP</option>
            </select>
          </div>
          <div class="demo-filter-group">
            <label>Health</label>
            <select id="demo-health">
              <option value="">Any</option>
              <option value="healthy">Healthy</option>
              <option value="degraded">Degraded</option>
              <option value="down">Down</option>
            </select>
          </div>
          <div class="demo-filter-group">
            <label>Category</label>
            <select id="demo-category">
              <option value="">All</option>
            </select>
          </div>
          <div class="demo-filter-group">
            <label>Sort</label>
            <select id="demo-sort">
              <option value="reliability">Reliability</option>
              <option value="latency">Latency</option>
              <option value="price">Price</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
      </div>

      <div class="demo-mcp-query" id="demo-mcp-display">
        <div class="demo-mcp-header">
          <span>MCP Tool Call</span>
          <button class="copy-btn" id="demo-copy-mcp">Copy</button>
        </div>
        <pre class="demo-code-block" id="demo-mcp-json">{
  "tool": "search_services",
  "arguments": {}
}</pre>
      </div>

      <div class="demo-search-results" id="demo-search-results">
        <p class="demo-search-hint">Start typing or adjust filters to search...</p>
      </div>
    </section>

    <!-- ─── Panel 3: Live Endpoint Health Check ─────────────────────── -->
    <section class="demo-panel demo-probe">
      <h2>Live Endpoint Health Check</h2>
      <p class="demo-panel-desc">Paste any API URL to run a real-time health check — see the protocol handshake live</p>
      <div class="demo-probe-input-row">
        <input type="text" class="demo-probe-url" id="demo-probe-url" placeholder="https://api.example.com/endpoint" />
        <button class="demo-healthcheck-btn" id="demo-probe-btn">Check Endpoint Health</button>
      </div>
      <div class="demo-probe-log" id="demo-probe-log"></div>
    </section>
    </div>

    <!-- ─── Panel 4: Payment Flow Visualization ───────────────────────── -->
    <section class="demo-panel demo-flow">
      <h2>Payment Flow</h2>
      <p class="demo-panel-desc">How an agent pays for an API call — step by step</p>

      <div class="demo-flow-toggle" id="demo-flow-toggle">
        <button class="demo-toggle-btn demo-toggle-active" data-protocol="L402">L402 (Lightning)</button>
        <button class="demo-toggle-btn" data-protocol="x402">x402 (Base, Solana)</button>
        <button class="demo-toggle-btn" data-protocol="MPP">MPP (Stripe/Tempo)</button>
      </div>

      <div class="demo-flow-steps" id="demo-flow-steps">
        <div class="demo-flow-step">
          <div class="demo-flow-step-number">1</div>
          <div class="demo-flow-step-content">
            <h4>Agent Sends Request</h4>
            <p>Agent discovers endpoint via 402index and sends request</p>
            <pre class="demo-code-block">${escapeHtml(probe.flow.request)}</pre>
          </div>
        </div>

        <div class="demo-flow-step">
          <div class="demo-flow-step-number">2</div>
          <div class="demo-flow-step-content">
            <h4>Server Returns 402</h4>
            <p>Server requires payment — returns 402 with payment instructions</p>
            <pre class="demo-code-block" id="demo-flow-402-header">${escapeHtml(probe.flow.protocolHeaders.L402 || probe.flow.protocolHeaders.x402 || '')}</pre>
          </div>
        </div>

        <div class="demo-flow-step">
          <div class="demo-flow-step-number">3</div>
          <div class="demo-flow-step-content">
            <h4 id="demo-flow-pay-title">Agent Pays Invoice</h4>
            <p id="demo-flow-pay-desc">Agent pays Lightning invoice automatically via lnget or wallet</p>
            <pre class="demo-code-block" id="demo-flow-pay-detail">Lightning BOLT11 invoice
Amount: ${probe.service.price_sats || '?'} sats
Expiry: 60 seconds</pre>
          </div>
        </div>

        <div class="demo-flow-step">
          <div class="demo-flow-step-number">4</div>
          <div class="demo-flow-step-content">
            <h4>Agent Retries with Token</h4>
            <p>Agent retries request with proof of payment</p>
            <pre class="demo-code-block" id="demo-flow-retry-header">${escapeHtml(probe.flow.retryHeader)}</pre>
          </div>
        </div>

        <div class="demo-flow-step">
          <div class="demo-flow-step-number">5</div>
          <div class="demo-flow-step-content">
            <h4>Server Returns 200</h4>
            <p>Server validates payment and returns the requested data</p>
            <pre class="demo-code-block">HTTP/1.1 200 OK
Content-Type: application/json

{ "data": "..." }</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── Full Directory Link ────────────────────────────────────────── -->
    <div style="text-align:center;padding:24px 0">
      <a href="/directory" style="font-size:16px;font-weight:500">Browse full directory (${formatNumber(s.totalIndexed)} endpoints) &rarr;</a>
    </div>
  </div>

  <script>
  (function() {
    // ─── Interactive Search ────────────────────────────────────────────

    const searchInput = document.getElementById('demo-q')
    const protocolSelect = document.getElementById('demo-protocol')
    const healthSelect = document.getElementById('demo-health')
    const categorySelect = document.getElementById('demo-category')
    const sortSelect = document.getElementById('demo-sort')
    const resultsContainer = document.getElementById('demo-search-results')
    const mcpJson = document.getElementById('demo-mcp-json')
    const copyBtn = document.getElementById('demo-copy-mcp')

    let debounceTimer = null

    // Load categories
    fetch('/api/v1/categories')
      .then(r => r.json())
      .then(data => {
        for (const [cat] of Object.entries(data.categories || {}).sort((a, b) => b[1].count - a[1].count)) {
          const opt = document.createElement('option')
          opt.value = cat
          opt.textContent = cat
          categorySelect.appendChild(opt)
        }
      })
      .catch(() => {})

    function buildQuery() {
      const params = {}
      const q = searchInput.value.trim()
      if (q) params.q = q
      if (protocolSelect.value) params.protocol = protocolSelect.value
      if (healthSelect.value) params.health = healthSelect.value
      if (categorySelect.value) params.category = categorySelect.value
      if (sortSelect.value) params.sort = sortSelect.value
      params.limit = 10
      return params
    }

    function updateMcpDisplay(params) {
      const args = {}
      if (params.q) args.query = params.q
      if (params.protocol) args.protocol = params.protocol
      if (params.health) args.health = params.health
      if (params.category) args.category = params.category
      if (params.sort) args.sort = params.sort
      mcpJson.textContent = JSON.stringify({ tool: 'search_services', arguments: args }, null, 2)
    }

    function escapeHtmlClient(str) {
      if (!str) return ''
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    function healthDotHtml(svc) {
      if (svc.probe_status === 'unprobeable') {
        return '<span class="health-dot health-unprobeable"></span>unprobeable'
      }
      var s = escapeHtmlClient(svc.health_status || 'unknown')
      return '<span class="health-dot health-' + s + '"></span>' + s
    }

    function protocolBadgeHtml(protocol) {
      const safe = escapeHtmlClient(protocol)
      const cls = protocol === 'x402' ? 'badge-x402' : protocol === 'L402' ? 'badge-l402' : protocol === 'MPP' ? 'badge-mpp' : 'badge-both'
      return '<span class="badge ' + cls + '">' + safe + '</span>'
    }

    function verifiedBadgeHtml(svc) {
      if (svc.domain_verified === 1) {
        return '<span class="badge badge-verified-domain" title="Domain Verified"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 16l-4-4 1.41-1.41L11 14.17l6.59-6.59L19 9l-8 8z"/></svg></span>'
      }
      if (svc.x402_payment_valid === 1 || svc.health_status === 'healthy') {
        return '<span class="badge badge-verified-payment" title="402 header parsed"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg></span>'
      }
      return ''
    }

    function renderResults(data) {
      if (!data.services || data.services.length === 0) {
        resultsContainer.innerHTML = '<p class="demo-search-hint">No services found matching your criteria.</p>'
        return
      }

      var visible = data.services.slice(0, 15)
      let html = '<div class="demo-results-header">' + data.total + ' services found</div>'
      for (const svc of visible) {
        html += '<div class="demo-result-card" data-id="' + escapeHtmlClient(svc.id) + '">'
        html += '<div class="demo-result-summary">'
        html += '<div class="demo-result-name">' + escapeHtmlClient(svc.name) + verifiedBadgeHtml(svc) + '</div>'
        html += '<div class="demo-result-meta">'
        html += protocolBadgeHtml(svc.protocol) + ' '
        html += healthDotHtml(svc) + ' '
        if (svc.reliability_score != null) html += '<span class="demo-result-reliability">Reliability: ' + svc.reliability_score + '</span> '
        if (svc.latency_p50_ms != null) html += '<span class="demo-result-latency">' + svc.latency_p50_ms + 'ms</span> '
        if (svc.price_usd != null) html += '<span class="demo-result-price">$' + svc.price_usd + '</span>'
        else if (svc.price_sats != null) html += '<span class="demo-result-price">' + svc.price_sats + ' sats</span>'
        html += '</div>'
        html += '<div class="demo-result-url-row"><span class="demo-result-url">' + escapeHtmlClient(svc.url) + '</span><button class="demo-copy-url-btn" data-url="' + escapeHtmlClient(svc.url) + '">Copy URL</button><a href="/service/' + escapeHtmlClient(svc.id) + '" class="demo-view-details-btn" target="_blank">View Details</a></div>'
        html += '</div>'
        html += '<div class="demo-result-detail" style="display:none">'
        html += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">' + escapeHtmlClient(svc.provider || '—') + '</span></div>'
        html += '<div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">' + escapeHtmlClient(svc.category || '—') + '</span></div>'
        html += '<div class="detail-row"><span class="detail-label">Payment Asset</span><span class="detail-value">' + escapeHtmlClient(svc.payment_asset || '—') + '</span></div>'
        html += '<div class="detail-row"><span class="detail-label">Payment Network</span><span class="detail-value">' + escapeHtmlClient(svc.payment_network || '—') + '</span></div>'
        if (svc.description) html += '<div class="demo-result-desc">' + escapeHtmlClient(svc.description) + '</div>'
        html += '</div>'
        html += '</div>'
      }
      if (data.total > 15) {
        var params = []
        var q = document.getElementById('demo-q').value.trim()
        if (q) params.push('q=' + encodeURIComponent(q))
        var proto = document.getElementById('demo-protocol').value
        if (proto) params.push('protocol=' + encodeURIComponent(proto))
        var health = document.getElementById('demo-health').value
        if (health) params.push('health=' + encodeURIComponent(health))
        var cat = document.getElementById('demo-category').value
        if (cat) params.push('category=' + encodeURIComponent(cat))
        var href = '/directory?' + params.join('&')
        html += '<a href="' + escapeHtmlClient(href) + '" class="demo-view-all-link">View all ' + data.total + ' results in Directory &rarr;</a>'
      }

      resultsContainer.innerHTML = html

      // Click to expand/collapse
      resultsContainer.querySelectorAll('.demo-result-card').forEach(function(card) {
        card.addEventListener('click', function() {
          const detail = this.querySelector('.demo-result-detail')
          detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
        })
      })

      // Copy URL buttons
      resultsContainer.querySelectorAll('.demo-copy-url-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation()
          var url = this.getAttribute('data-url')
          var self = this
          navigator.clipboard.writeText(url).then(function() {
            self.textContent = 'Copied!'
            setTimeout(function() { self.textContent = 'Copy URL' }, 1500)
            // Auto-fill the probe URL input
            var probeInput = document.getElementById('demo-probe-url')
            if (probeInput) probeInput.value = url
          })
        })
      })
    }

    function doSearch() {
      const params = buildQuery()
      updateMcpDisplay(params)
      const qs = new URLSearchParams(params).toString()
      fetch('/api/v1/services?' + qs)
        .then(function(r) { return r.json() })
        .then(function(data) { renderResults(data) })
        .catch(function() {
          resultsContainer.innerHTML = '<p class="demo-search-hint">Error loading results.</p>'
        })
    }

    function debouncedSearch() {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(doSearch, 300)
    }

    searchInput.addEventListener('input', function() { showingFeatured = false; debouncedSearch() })
    protocolSelect.addEventListener('change', function() { showingFeatured = false; doSearch() })
    healthSelect.addEventListener('change', function() { showingFeatured = false; doSearch() })
    categorySelect.addEventListener('change', function() { showingFeatured = false; doSearch() })
    sortSelect.addEventListener('change', function() { showingFeatured = false; doSearch() })

    // Copy MCP query
    copyBtn.addEventListener('click', function(e) {
      e.stopPropagation()
      navigator.clipboard.writeText(mcpJson.textContent).then(function() {
        copyBtn.textContent = 'Copied!'
        setTimeout(function() { copyBtn.textContent = 'Copy' }, 1500)
      })
    })

    // Initial view: show curated featured endpoints (server-rendered data)
    var featuredData = ${safeJsonEmbed(featuredServices)}
    var showingFeatured = true

    function showFeatured() {
      if (featuredData.length >= 3) {
        renderResults({ services: featuredData, total: featuredData.length })
        var header = resultsContainer.querySelector('.demo-results-header')
        if (header) header.textContent = 'Featured endpoints across L402, x402, and MPP'
      } else {
        // Fewer than 3 featured resolved (e.g. local dev DB) — show placeholder
        resultsContainer.innerHTML = '<p class="demo-search-hint">Featured endpoints load from production data. Try searching above or <a href="/directory">browse the directory</a>.</p>'
      }
    }

    function switchToLiveSearch() {
      if (showingFeatured) {
        showingFeatured = false
        doSearch()
      }
    }

    showFeatured()

    // ─── Flow Protocol Toggle ──────────────────────────────────────────

    var flowData = ${safeJsonEmbed({
      L402: {
        header: probe.flow.protocolHeaders.L402 || 'WWW-Authenticate: L402 macaroon="<token>", invoice="lnbc..."',
        payTitle: 'Agent Pays Invoice',
        payDesc: 'Agent pays Lightning invoice automatically via lnget or wallet',
        payDetail: 'Lightning BOLT11 invoice\\nAmount: ' + (probe.service.price_sats || '?') + ' sats\\nExpiry: 60 seconds',
        retryHeader: probe.flow.retryHeader || 'Authorization: L402 <macaroon>:<preimage>',
      },
      x402: {
        header: probe.flow.protocolHeaders.x402 || 'PAYMENT-REQUIRED: { "accepts": [{ "asset": "USDC", "amount": "10000", "facilitator": "https://x402.org/facilitator" }] }',
        payTitle: 'Agent Signs Payment',
        payDesc: 'Agent signs USDC transfer via x402 facilitator',
        payDetail: 'x402 Payment Requirement\\nAsset: USDC\\nChain: Base\\nFacilitator: x402.org',
        retryHeader: 'X-PAYMENT: <base64-encoded-signed-payment>',
      },
      MPP: {
        header: probe.flow.protocolHeaders.MPP || 'WWW-Authenticate: Payment id="<session-id>", realm="<provider>", method="tempo", intent="session", request="<base64-payment-details>"',
        payTitle: 'Agent Pays via Tempo',
        payDesc: 'Agent pays through Stripe/Tempo facilitated stablecoin escrow',
        payDetail: 'Tempo Payment Session\\nMethod: tempo\\nIntent: session\\nSettlement: Stablecoin escrow on Tempo chain',
        retryHeader: 'Authorization: Payment <session-token>',
      },
    })}

    var flowToggle = document.getElementById('demo-flow-toggle')
    flowToggle.addEventListener('click', function(e) {
      var btn = e.target.closest('.demo-toggle-btn')
      if (!btn) return
      var protocol = btn.getAttribute('data-protocol')
      var data = flowData[protocol]
      if (!data) return

      // Update active toggle
      flowToggle.querySelectorAll('.demo-toggle-btn').forEach(function(b) {
        b.classList.remove('demo-toggle-active')
      })
      btn.classList.add('demo-toggle-active')

      // Update flow steps
      document.getElementById('demo-flow-402-header').textContent = data.header
      document.getElementById('demo-flow-pay-title').textContent = data.payTitle
      document.getElementById('demo-flow-pay-desc').textContent = data.payDesc
      document.getElementById('demo-flow-pay-detail').textContent = data.payDetail
      document.getElementById('demo-flow-retry-header').textContent = data.retryHeader
    })

    // ─── Live Probe ──────────────────────────────────────────────────────

    var probeInput = document.getElementById('demo-probe-url')
    var probeBtn = document.getElementById('demo-probe-btn')
    var probeLog = document.getElementById('demo-probe-log')

    function stepIcon(step) {
      if (step === 'connect') return '→'
      if (step === 'request') return '→'
      if (step === 'response') return '←'
      if (step === 'headers') return '←'
      if (step === 'l402_validation' || step === 'mpp_validation' || step === 'x402_validation') return '◆'
      if (step === 'analysis') return '◆'
      if (step === 'done') return '✓'
      if (step === 'error') return '✗'
      return '·'
    }

    function stepClass(step) {
      if (step === 'done') return 'demo-probe-step-done'
      if (step === 'error') return 'demo-probe-step-error'
      if (step === 'headers') return 'demo-probe-step-headers'
      if (step === 'response') return 'demo-probe-step-response'
      if (step === 'l402_validation' || step === 'mpp_validation' || step === 'x402_validation') return 'demo-probe-step-headers'
      return ''
    }

    probeBtn.addEventListener('click', function() {
      var url = probeInput.value.trim()
      if (!url) return

      probeLog.innerHTML = ''
      probeBtn.disabled = true
      probeBtn.textContent = 'Probing...'

      var es = new EventSource('/api/v1/demo/probe-live?url=' + encodeURIComponent(url))

      es.onmessage = function(e) {
        var data = JSON.parse(e.data)
        var line = document.createElement('div')
        line.className = 'demo-probe-step ' + stepClass(data.step)
        line.innerHTML = '<span class="demo-probe-icon">' + stepIcon(data.step) + '</span> ' + escapeHtmlClient(data.message)

        // Show raw headers if present
        if (data.headers) {
          for (var key in data.headers) {
            var headerLine = document.createElement('div')
            headerLine.className = 'demo-probe-header-detail'
            headerLine.textContent = '  ' + key + ': ' + data.headers[key]
            line.appendChild(headerLine)
          }
        }

        probeLog.appendChild(line)
        probeLog.scrollTop = probeLog.scrollHeight

        if (data.step === 'done' || data.step === 'error') {
          es.close()
          probeBtn.disabled = false
          probeBtn.textContent = 'Check Endpoint Health'
        }
      }

      es.onerror = function() {
        es.close()
        probeBtn.disabled = false
        probeBtn.textContent = 'Check Endpoint Health'
        if (probeLog.children.length === 0) {
          var errLine = document.createElement('div')
          errLine.className = 'demo-probe-step demo-probe-step-error'
          errLine.innerHTML = '<span class="demo-probe-icon">✗</span> Connection failed'
          probeLog.appendChild(errLine)
        }
      }
    })
  })()
  </script>`

  return layout('402 Index', content, meta)
}
