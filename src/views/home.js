import { layout } from './layout.js'
import { escapeHtml, healthDot, protocolBadge, formatPrice, sourceLink, verifiedBadge } from './helpers.js'

export function homePage({ services, total, limit, offset, filters, stats, categories, btcUsdRate }) {
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)

  const rows = services.map(s => `
    <tr onclick="location.href='/service/${escapeHtml(s.id)}'">
      <td>
        <span class="svc-name">${escapeHtml(s.name)}${verifiedBadge(s)}</span>
        <span class="svc-url">${escapeHtml(s.url)}</span>
      </td>
      <td>${protocolBadge(s.protocol)}</td>
      <td class="price">${formatPrice(s, btcUsdRate)}</td>
      <td>${s.category ? `<span class="category-tag">${escapeHtml(s.category)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${healthDot(s.health_status, s.probe_status)}</td>
      <td class="latency">${s.latency_p50_ms != null ? s.latency_p50_ms + 'ms' : '—'}</td>
      <td><span class="source-tag">${sourceLink(s.source)}</span></td>
    </tr>
  `).join('')

  const catOptions = categories.map(c =>
    `<option value="${escapeHtml(c.category)}"${filters.category === c.category ? ' selected' : ''}>${escapeHtml(c.category)} (${c.count})</option>`
  ).join('')

  const hasFilters = filters.protocol || filters.category || filters.health || filters.source || filters.q || filters.featured || filters.sort || filters.payment_valid

  const prevOffset = Math.max(0, offset - limit)
  const nextOffset = offset + limit

  return layout('Directory', `
    <div class="container">
      <div style="padding: 16px 0 8px">
        <a href="/" style="color:var(--text-muted);font-size:13px">&larr; Back to overview</a>
      </div>
      <div class="filters">
        <form method="get" action="/directory"${hasFilters ? ' class="filters-open"' : ''}>
          <select name="protocol" onchange="this.form.submit()">
            <option value="">All protocols</option>
            <option value="x402"${filters.protocol === 'x402' ? ' selected' : ''}>x402</option>
            <option value="L402"${filters.protocol === 'L402' ? ' selected' : ''}>L402</option>
            <option value="MPP"${filters.protocol === 'MPP' ? ' selected' : ''}>MPP</option>
          </select>
          <select name="category" onchange="this.form.submit()">
            <option value="">All categories</option>
            ${catOptions}
          </select>
          <select name="health" onchange="this.form.submit()">
            <option value="">All health</option>
            <option value="healthy"${filters.health === 'healthy' ? ' selected' : ''}>Healthy</option>
            <option value="degraded"${filters.health === 'degraded' ? ' selected' : ''}>Degraded</option>
            <option value="down"${filters.health === 'down' ? ' selected' : ''}>Down</option>
            <option value="unknown"${filters.health === 'unknown' ? ' selected' : ''}>Unknown</option>
          </select>
          <select name="source" onchange="this.form.submit()">
            <option value="">All sources</option>
            <option value="exclusive"${filters.source === 'exclusive' ? ' selected' : ''}>Exclusive</option>
            <option value="satring"${filters.source === 'satring' ? ' selected' : ''}>Satring</option>
            <option value="bazaar"${filters.source === 'bazaar' ? ' selected' : ''}>Bazaar</option>
            <option value="l402apps"${filters.source === 'l402apps' ? ' selected' : ''}>L402 Apps</option>
            <option value="sponge"${filters.source === 'sponge' ? ' selected' : ''}>Sponge</option>
            <option value="payai"${filters.source === 'payai' ? ' selected' : ''}>PayAI</option>
            <option value="well-known"${filters.source === 'well-known' ? ' selected' : ''}>Well-Known</option>
            <option value="discovery"${filters.source === 'discovery' ? ' selected' : ''}>Discovery</option>
            <option value="mpp"${filters.source === 'mpp' ? ' selected' : ''}>MPP</option>
          </select>
          <select name="sort" onchange="this.form.submit()">
            <option value="">Default sort</option>
            <option value="reliability"${filters.sort === 'reliability' ? ' selected' : ''}>Reliability</option>
            <option value="uptime"${filters.sort === 'uptime' ? ' selected' : ''}>Uptime</option>
            <option value="latency"${filters.sort === 'latency' ? ' selected' : ''}>Latency</option>
            <option value="price"${filters.sort === 'price' ? ' selected' : ''}>Price</option>
            <option value="name"${filters.sort === 'name' ? ' selected' : ''}>Name</option>
          </select>
          <input type="text" name="q" placeholder="Search name, description, or URL..." value="${escapeHtml(filters.q || '')}">
          <button type="button" class="filter-toggle" onclick="this.form.classList.toggle('filters-open')">Filters ▾</button>
          <label><input type="checkbox" name="featured" value="true"${filters.featured ? ' checked' : ''} onchange="this.form.submit()"> Featured only</label>
          <label><input type="checkbox" name="payment_valid" value="true"${filters.payment_valid ? ' checked' : ''} onchange="this.form.submit()"> 402 header parsed</label>
          <button type="submit" class="filter-btn">Filter</button>
          ${hasFilters ? '<a href="/directory" class="filter-clear">Clear</a>' : ''}
        </form>
      </div>
      <div class="table-wrap">
      <table class="services-table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Protocol</th>
            <th scope="col">Price</th>
            <th scope="col">Category</th>
            <th scope="col">Health</th>
            <th scope="col">Latency</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          ${services.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">No services found</td></tr>' : rows}
        </tbody>
      </table>
      </div>
      <div class="pagination">
        <span>Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span>
        <span>
          ${offset > 0 ? `<a href="/directory?${buildQuery(filters, { offset: prevOffset, limit })}">Prev</a>` : ''}
          Page ${currentPage} of ${totalPages}
          ${nextOffset < total ? `<a href="/directory?${buildQuery(filters, { offset: nextOffset, limit })}">Next</a>` : ''}
        </span>
      </div>
    </div>
  `)
}

function buildQuery(filters, pagination) {
  const params = new URLSearchParams()
  if (filters.protocol) params.set('protocol', filters.protocol)
  if (filters.category) params.set('category', filters.category)
  if (filters.health) params.set('health', filters.health)
  if (filters.source) params.set('source', filters.source)
  if (filters.q) params.set('q', filters.q)
  if (filters.featured) params.set('featured', 'true')
  if (filters.sort) params.set('sort', filters.sort)
  if (filters.payment_valid) params.set('payment_valid', 'true')
  params.set('offset', pagination.offset)
  params.set('limit', pagination.limit)
  return params.toString()
}
