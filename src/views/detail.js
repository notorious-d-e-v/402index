import { layout } from './layout.js'
import { escapeHtml, safeHref, healthDot, protocolBadge, formatPrice, formatSchema, sourceLink, verifiedBadge } from './helpers.js'

export function detailPage(service) {
  const healthRows = (service.health_checks || []).map(h => `
    <tr>
      <td>${escapeHtml(h.checked_at)}</td>
      <td>${healthDot(h.status)}</td>
      <td>${h.http_status || '—'}</td>
      <td>${h.response_time_ms != null ? h.response_time_ms + 'ms' : '—'}</td>
      <td style="color:var(--text-muted)">${escapeHtml(h.error_message || '')}</td>
    </tr>
  `).join('')

  const inputSchema = formatSchema(service.input_schema)
  const outputSchema = formatSchema(service.output_schema)

  let providerName = service.provider
  if (!providerName) {
    try { providerName = new URL(service.url).hostname } catch { providerName = 'Unknown' }
  }

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebAPI',
    name: service.name,
    url: service.url,
    description: service.description || `${service.protocol} paid API endpoint`,
    provider: { '@type': 'Organization', name: providerName },
  }

  const metaDesc = `${service.protocol} paid API endpoint. Health: ${service.health_status || 'unknown'}. ${service.description || ''}`.slice(0, 160)

  return layout(escapeHtml(service.name), `
    <div class="container">
      <div class="detail-header">
        <p style="margin-bottom:12px"><a href="/">&larr; Back to directory</a></p>
        <h1>${escapeHtml(service.name)}${verifiedBadge(service)}</h1>
        <a href="${safeHref(service.url)}" class="detail-url" target="_blank">${escapeHtml(service.url)}</a>
        ${service.quarantine ? `<p class="quarantine-banner" role="status"><strong>Host quarantined</strong> since ${escapeHtml(service.quarantine.entered_at || 'seeding')}: ${escapeHtml(service.quarantine.reason || 'no paywall response from this host')}. This endpoint is hidden from counts and default listings until its host answers with a 402 again.</p>` : ''}
      </div>

      <div class="detail-grid">
        <div class="detail-section">
          <h2>Overview</h2>
          ${service.description ? `<p style="margin-bottom:16px;line-height:1.6">${escapeHtml(service.description)}</p>` : ''}
          <div class="detail-row">
            <span class="detail-label">Protocol</span>
            <span class="detail-value">${protocolBadge(service.protocol)}${service.http_method && service.http_method !== 'GET' ? ` <span style="color:var(--text-muted);font-size:0.85em">(${escapeHtml(service.http_method)})</span>` : ''}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Price</span>
            <span class="detail-value">${formatPrice(service)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Asset</span>
            <span class="detail-value">${escapeHtml(service.payment_asset) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Network</span>
            <span class="detail-value">${escapeHtml(service.payment_network) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Category</span>
            <span class="detail-value">${escapeHtml(service.category) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Provider</span>
            <span class="detail-value">${escapeHtml(service.provider) || '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Source</span>
            <span class="detail-value">${sourceLink(service.source)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Indexed</span>
            <span class="detail-value">${escapeHtml(service.registered_at) || '—'}</span>
          </div>
        </div>

        <div class="detail-section">
          <h2>Health</h2>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="detail-value">${healthDot(service.health_status, service.probe_status)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Latency (p50)</span>
            <span class="detail-value">${service.latency_p50_ms != null ? service.latency_p50_ms + 'ms' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Uptime (30d)</span>
            <span class="detail-value">${service.uptime_30d != null ? (service.uptime_30d * 100).toFixed(1) + '%' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Reliability Score</span>
            <span class="detail-value">${service.reliability_score != null ? service.reliability_score + '/100' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Checked</span>
            <span class="detail-value">${escapeHtml(service.last_checked) || 'Never'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Healthy</span>
            <span class="detail-value">${escapeHtml(service.last_seen_healthy) || 'Never'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Consecutive Failures</span>
            <span class="detail-value">${escapeHtml(String(service.consecutive_failures))}</span>
          </div>
        </div>
      </div>

      ${service.protocol === 'L402' ? `
        <div class="detail-section" style="margin-bottom:24px">
          <h2>Macaroon Format</h2>
          <div class="detail-row">
            <span class="detail-label">Format</span>
            <span class="detail-value">${
              service.l402_format === 'v2_tlv' ? 'V2 TLV Binary'
              : service.l402_format === 'v1_binary' ? 'V1 Binary'
              : service.l402_format === 'v0_text' ? 'V0 Text (libmacaroons)'
              : service.l402_format === 'json' ? 'JSON'
              : service.l402_format === 'unknown' ? 'Unknown'
              : '<span style="color:var(--text-muted)">Not yet detected</span>'
            }</span>
          </div>
          ${service.lnget_compatible !== null && service.lnget_compatible !== undefined ? `
          <div class="detail-row">
            <span class="detail-label">lnget Compatible</span>
            <span class="detail-value">
              ${service.lnget_compatible === 1
                ? '<span class="health-dot health-healthy"></span> Yes'
                : '<span class="health-dot health-degraded"></span> No — ' + (
                    service.l402_format === 'json' ? 'JSON token (not a macaroon)'
                    : service.l402_format === 'v0_text' ? 'V0 text format (parser support pending)'
                    : 'non-standard format'
                  )
              }
            </span>
          </div>
          ` : ''}
          ${service.l402_degrade_reason && service.l402_degrade_reason.includes('payment hash') ? `
          <div class="detail-row">
            <span class="detail-label">Issue</span>
            <span class="detail-value" style="color:var(--amber)">&#9888; ${escapeHtml(service.l402_degrade_reason)}</span>
          </div>
          ` : ''}
        </div>
      ` : ''}

      ${service.protocol === 'x402' ? `
        <div class="detail-section" style="margin-bottom:24px">
          <h2>x402 Payment Validation</h2>
          <div class="detail-row">
            <span class="detail-label">Payment Requirements</span>
            <span class="detail-value">${service.x402_payment_valid === 1 ? '<span style="color:var(--green)">Valid</span>' : service.x402_payment_valid === 0 ? '<span style="color:var(--red)">Invalid</span>' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Asset Verified</span>
            <span class="detail-value">${service.x402_asset_known === 1 ? '<span style="color:var(--green)">Known USDC</span>' : service.x402_asset_known === 0 ? '<span style="color:var(--yellow)">Unknown asset</span>' : '—'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Facilitator</span>
            <span class="detail-value">${service.x402_facilitator_reachable === 1 ? '<span style="color:var(--green)">Reachable</span>' : service.x402_facilitator_reachable === 0 ? '<span style="color:var(--red)">Unreachable</span>' : '—'}</span>
          </div>
        </div>
      ` : ''}

      ${inputSchema ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Input Schema</h2>
        <div class="schema-block">${escapeHtml(inputSchema)}</div>
      </div>
      ` : ''}

      ${outputSchema ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Output Schema</h2>
        <div class="schema-block">${escapeHtml(outputSchema)}</div>
      </div>
      ` : ''}

      ${service.related_services?.length > 0 ? `
      <div class="detail-section" style="margin-top:24px; margin-bottom:24px">
        <h2>Also available via</h2>
        ${service.related_services.map(rs => `
          <div style="display:flex; align-items:center; gap:12px; padding:12px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px">
            <div>${protocolBadge(rs.protocol)}</div>
            <div>${healthDot(rs.health_status, rs.probe_status)}</div>
            <div>${formatPrice(rs)}</div>
            <div style="color:var(--text-muted); font-size:0.85em">${escapeHtml(rs.payment_asset || '')} on ${escapeHtml(rs.payment_network || '')}</div>
            <a href="/service/${encodeURIComponent(rs.id)}" style="margin-left:auto">View details &rarr;</a>
          </div>
        `).join('')}
      </div>
      ` : ''}

      ${service.health_checks?.length > 0 ? `
      <div class="detail-section" style="margin-bottom:24px">
        <h2>Recent Health Checks</h2>
        <table class="health-history">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Status</th>
              <th scope="col">HTTP</th>
              <th scope="col">Latency</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>${healthRows}</tbody>
        </table>
      </div>
      ` : ''}
    </div>
  `, {
    description: metaDesc,
    canonical: `/service/${escapeHtml(service.id)}`,
    jsonLd,
    ogUrl: `https://402index.io/service/${escapeHtml(service.id)}`,
  })
}
