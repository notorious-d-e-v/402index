export function escapeHtml(str) {
  if (str == null) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function safeJsonEmbed(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

export function safeHref(url) {
  if (!url) return '#'
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') return escapeHtml(url)
  } catch { /* invalid URL */ }
  return '#'
}

export function escapeXml(str) {
  if (str == null) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function healthDot(status, probeStatus) {
  if (probeStatus === 'unprobeable') {
    return '<span class="health-dot health-unprobeable"></span>unprobeable'
  }
  const s = escapeHtml(status)
  return `<span class="health-dot health-${s}"></span>${s}`
}

export function protocolBadge(protocol) {
  const cls = protocol === 'x402' ? 'badge-x402' : protocol === 'L402' ? 'badge-l402' : protocol === 'MPP' ? 'badge-mpp' : 'badge-both'
  return `<span class="badge ${cls}">${escapeHtml(protocol)}</span>`
}

export function verifiedBadge(service) {
  if (service.domain_verified === 1) {
    return '<span class="badge badge-verified-domain" title="Domain Verified — provider proved ownership via .well-known challenge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 16l-4-4 1.41-1.41L11 14.17l6.59-6.59L19 9l-8 8z"/></svg></span>'
  }
  if (service.x402_payment_valid === 1 || service.health_status === 'healthy') {
    return '<span class="badge badge-verified-payment" title="402 header parsed — the endpoint answers with a well-formed payment challenge. No payment has been made."><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg></span>'
  }
  return ''
}

export function formatPrice(service, btcUsdRate) {
  if (service.price_usd != null) return `$${service.price_usd.toFixed(service.price_usd < 0.01 ? 4 : 2)}`
  if (service.price_sats != null && btcUsdRate) {
    const usd = (service.price_sats / 100_000_000) * btcUsdRate
    return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
  }
  if (service.price_sats != null) return `${service.price_sats} sats`
  return '—'
}

const SOURCE_URLS = {
  satring: 'https://satring.com',
  bazaar: 'https://x402.org',
  l402apps: 'https://l402apps.com',
  sponge: 'https://paysponge.com',
  payai: 'https://payai.network',
  mpp: 'https://mpp.dev',
}

export function sourceLink(source) {
  const url = SOURCE_URLS[source]
  if (url) {
    return `<a href="${url}" target="_blank" rel="noopener" class="source-link">${escapeHtml(source)}</a>`
  }
  return escapeHtml(source)
}

export function formatSchema(json) {
  if (!json) return null
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
