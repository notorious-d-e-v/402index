import { layout } from './layout.js'
import { escapeHtml } from './helpers.js'

export function apiDocsPage() {
  return layout('API Documentation', `
    <div class="container">
      <div class="docs-content">
        <h1>402 Index API</h1>
        <p class="docs-subtitle">Programmatic access to the paid API directory. Free tier available, L402 payments for higher limits.</p>

        <div class="api-machine-readable">
          <h4>Machine-Readable API Docs</h4>
          <p>
            <a href="/api/v1/openapi.json">OpenAPI 3.1 Spec (JSON)</a> &middot;
            <a href="/api/v1/docs.md">API Docs (Markdown)</a>
          </p>
        </div>

        <h2>Base URL</h2>
        <div class="base-url">https://402index.io/api/v1</div>

        <h2>Endpoints</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/services</span>
          </div>
          <p>List and search services with filtering, sorting, and pagination.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>protocol</td><td>string</td><td>Filter by protocol: <code>l402</code> or <code>x402</code></td></tr>
              <tr><td>category</td><td>string</td><td>Filter by category (prefix match — <code>crypto</code> matches <code>crypto/nft</code>)</td></tr>
              <tr><td>health</td><td>string</td><td>Filter by health: <code>healthy</code>, <code>degraded</code>, <code>down</code>, <code>unknown</code></td></tr>
              <tr><td>source</td><td>string</td><td>Filter by source: <code>bazaar</code>, <code>satring</code>, <code>l402apps</code>, <code>sponge</code>, <code>payai</code>, <code>well-known</code>, <code>exclusive</code>, <code>self-registered</code>, <code>discovery</code></td></tr>
              <tr><td>probe_status</td><td>string</td><td>Filter by probe status: <code>probeable</code> or <code>unprobeable</code>. Unprobeable services have gateways that validate request parameters before presenting payment challenges, so generic health probes cannot elicit a 402.</td></tr>
              <tr><td>featured</td><td>boolean</td><td>Only featured services: <code>true</code></td></tr>
              <tr><td>q</td><td>string</td><td>Hybrid semantic + LIKE search (see below)</td></tr>
              <tr><td>max_price_usd</td><td>number</td><td>Maximum price in USD</td></tr>
              <tr><td>payment_asset</td><td>string</td><td>Filter by payment asset (e.g. <code>BTC</code>, <code>USDC</code>)</td></tr>
              <tr><td>payment_valid</td><td>boolean</td><td>Only x402 services with verified payment requirements: <code>true</code></td></tr>
              <tr><td>verified</td><td>boolean</td><td>Only services whose 402 header parsed (not proof a payment settles). x402: valid payment headers. L402/MPP: healthy endpoint. Domain-verified services ranked first. Recommended for agents. Example: <code>?verified=true</code></td></tr>
              <tr><td>l402_format</td><td>string</td><td>Filter L402 endpoints by macaroon format: <code>v2_tlv</code>, <code>v1_binary</code>, <code>v0_text</code>, <code>json</code>, <code>unknown</code></td></tr>
              <tr><td>lnget_compatible</td><td>boolean</td><td>Filter L402 endpoints by <code>lnget</code> client compatibility: <code>true</code> or <code>false</code></td></tr>
              <tr><td>sort</td><td>string</td><td>Sort by: <code>name</code>, <code>price</code>, <code>latency</code>, <code>uptime</code>, <code>reliability</code></td></tr>
              <tr><td>order</td><td>string</td><td>Sort order: <code>asc</code> or <code>desc</code></td></tr>
              <tr><td>limit</td><td>integer</td><td>Results per page (default 50, max 200)</td></tr>
              <tr><td>offset</td><td>integer</td><td>Pagination offset</td></tr>
            </tbody>
          </table>
          <h4>Verification Tiers</h4>
          <p>The <code>verified</code> filter uses a tiered system:</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Tier</th><th scope="col">Condition</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td>Domain Verified</td><td><code>domain_verified=1</code></td><td>Provider proved ownership via .well-known DNS challenge. Ranked first in results.</td></tr>
              <tr><td>402 header parsed (x402)</td><td><code>x402_payment_valid=1</code></td><td>Endpoint returns spec-compliant 402 headers with valid payment requirements.</td></tr>
              <tr><td>402 header parsed (L402/MPP)</td><td><code>health_status='healthy'</code></td><td>Endpoint responds with valid payment challenge.</td></tr>
            </tbody>
          </table>
          <p>Example: <code>GET /api/v1/services?q=weather&amp;verified=true</code></p>

          <h4>How <code>?q=</code> works</h4>
          <p>When <code>q</code> is present and no explicit <code>sort</code> is specified, results use a hybrid semantic + LIKE search with 5-tier composite re-rank:</p>
          <ol>
            <li><strong>Tier A:</strong> Exact name match (case-insensitive)</li>
            <li><strong>Tier B:</strong> LIKE match on name</li>
            <li><strong>Tier C:</strong> LIKE match on description</li>
            <li><strong>Tier D:</strong> Cosine similarity from embeddings (intent matching)</li>
            <li><strong>Tier E:</strong> Default order (featured, verified, category, health, name)</li>
          </ol>
          <p>If the embedding service is unavailable, results fall back to LIKE-only and the response includes an <code>X-402index-Search-Degraded</code> header with a reason code: <code>no-api-key</code>, <code>embed-timeout</code>, <code>embed-error</code>, <code>circuit-open</code>, <code>vec-deadline</code>, or <code>vec-unavailable</code>.</p>

          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/services?protocol=l402&amp;health=healthy</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/services/:id</span>
          </div>
          <p>Get full details for a single service, including recent health check history and <code>related_services</code> (other protocol listings for the same URL with their health, pricing, and reliability data).</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/services/1</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/categories</span>
          </div>
          <p>List all categories with service counts, organized as a tree with subcategories.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/categories</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/health</span>
          </div>
          <p>System health and sync status. Returns endpoint counts, distinct service/provider counts by protocol, health status breakdowns, source counts, and last sync timestamps.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/health</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/register</span>
          </div>
          <p>Register a paid API endpoint (L402, x402, or MPP). The URL is probed to verify protocol compliance. Registrations are reviewed before appearing in the directory. Rate limited to 10 registrations per hour per IP.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>url</td><td>string</td><td><strong>Required.</strong> The endpoint URL to register</td></tr>
              <tr><td>name</td><td>string</td><td><strong>Required.</strong> Display name for the service</td></tr>
              <tr><td>protocol</td><td>string</td><td><strong>Required.</strong> One of <code>L402</code>, <code>x402</code>, or <code>MPP</code> (case-insensitive)</td></tr>
              <tr><td>http_method</td><td>string</td><td>HTTP method that triggers the paywall. Default: <code>GET</code>. Allowed: <code>GET</code>, <code>POST</code>, <code>PUT</code>, <code>DELETE</code></td></tr>
              <tr><td>probe_body</td><td>string</td><td>JSON body to send during health checks and verification probes. Required for endpoints that validate the request body before issuing the payment challenge. Must be valid JSON.</td></tr>
              <tr><td>description</td><td>string</td><td>Description of what the service does</td></tr>
              <tr><td>price_sats</td><td>integer</td><td>Price per request in satoshis</td></tr>
              <tr><td>price_usd</td><td>number</td><td>Price per request in USD</td></tr>
              <tr><td>payment_asset</td><td>string</td><td>Payment asset (e.g. <code>BTC</code>, <code>USDC</code>)</td></tr>
              <tr><td>payment_network</td><td>string</td><td>Payment network (e.g. <code>Lightning</code>, <code>Base</code>, <code>Solana</code>)</td></tr>
              <tr><td>category</td><td>string</td><td>Category (e.g. <code>bitcoin</code>). Defaults to <code>uncategorized</code></td></tr>
              <tr><td>provider</td><td>string</td><td>Organization or developer name</td></tr>
              <tr><td>contact_email</td><td>string</td><td>Contact email (not displayed publicly)</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/register \\
  -H 'Content-Type: application/json' \\
  -d '{
  "url": "https://api.example.com/resource",
  "name": "My L402 API",
  "protocol": "L402",
  "provider": "My Org"
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>201</code></td><td>Registered and pending review. Returns the service record (with <code>status: "pending"</code>), verification details, and <code>also_registered</code> (array of bonus listings auto-created when dual-protocol support is detected). Re-registering an existing URL+protocol updates the record.</td></tr>
              <tr><td><code>400</code></td><td>Missing required fields, invalid protocol, invalid URL, or field exceeds max length.</td></tr>
              <tr><td><code>422</code></td><td>Protocol verification failed. The response includes a diagnostic <code>probe</code> object with <code>httpStatus</code>, <code>headersPresent</code>, <code>bodySnippet</code>, and <code>detectedProtocols</code>. If a different protocol was detected than requested, a top-level <code>suggestedProtocol</code> field is included.</td></tr>
              <tr><td><code>429</code></td><td>Rate limit exceeded (10 registrations per hour per IP).</td></tr>
            </tbody>
          </table>
          <div class="info-callout" style="margin-top:16px">
            <h3>.well-known Auto-Discovery</h3>
            <p>If your endpoint returns 400 or 406 during verification and you haven't provided a
            <code>probe_body</code>, we'll check <code>https://your-host/.well-known/l402-services</code>
            for probe configuration. If your discovery document lists the endpoint with a
            <code>request_schema</code>, we'll construct a minimal probe body automatically.
            <a href="/about#wellknown">Learn more about .well-known discovery.</a></p>
          </div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/export.csv</span>
            <span style="background:rgba(240,165,0,0.15);color:#f0a500;padding:2px 8px;border-radius:4px;font-size:12px;margin-left:8px">L402 Required</span>
          </div>
          <p>Export the full directory as CSV. Requires L402 payment — no free tier. Supports the same filters as <code>/api/v1/services</code>.</p>
          <p><strong>CSV columns:</strong> id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, health_status, probe_status, uptime_30d, latency_p50_ms, last_checked, http_method, reliability_score</p>
          <p>Sats-only prices are automatically converted to USD using the current BTC/USD rate.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -H 'Authorization: L402 &lt;macaroon&gt;:&lt;preimage&gt;' \\
  'https://402index.io/api/v1/export.csv?protocol=l402'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>CSV file download (<code>Content-Type: text/csv</code>)</td></tr>
              <tr><td><code>402</code></td><td>L402 payment required. Add <code>?l402=require</code> to get a Lightning invoice challenge.</td></tr>
            </tbody>
          </table>
        </div>

        <h2>Distribution</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/feed.xml</span>
          </div>
          <p>RSS 2.0 feed of indexed services with a custom <code>l402:service</code> XML namespace. Each item includes <code>&lt;l402:endpoint&gt;</code>, <code>&lt;l402:protocol&gt;</code>, and <code>&lt;l402:price&gt;</code> tags.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>protocol</td><td>string</td><td>Filter: <code>L402</code> or <code>x402</code></td></tr>
              <tr><td>health</td><td>string</td><td>Filter: <code>healthy</code>, <code>degraded</code>, <code>down</code></td></tr>
              <tr><td>type</td><td>string</td><td><code>new</code> for services added in the last 7 days</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /feed.xml?protocol=L402&amp;health=healthy</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/opportunities</span>
          </div>
          <p>Ecosystem gap analysis — identifies categories with poor coverage, missing protocols, single-provider dependencies, and failing services. Useful for developers looking for underserved niches.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>protocol</td><td>string</td><td>Filter opportunities by protocol: <code>L402</code> or <code>x402</code></td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/opportunities</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/webhooks</span>
          </div>
          <p>Register a webhook to receive real-time notifications when services are added, change health, or go down. Deliveries are signed with HMAC-SHA256 (<code>X-402Index-Signature</code> header). Rate limited to 5 registrations per hour per IP.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>url</td><td>string</td><td><strong>Required.</strong> HTTPS callback URL</td></tr>
              <tr><td>secret</td><td>string</td><td><strong>Required.</strong> Shared secret for HMAC signing (min 16 chars)</td></tr>
              <tr><td>events</td><td>string</td><td>Comma-separated events: <code>service.new</code>, <code>service.health_changed</code>, <code>service.down</code>. Default: <code>service.new</code></td></tr>
              <tr><td>protocol_filter</td><td>string</td><td>Only deliver for: <code>L402</code> or <code>x402</code></td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/webhooks \\
  -H 'Content-Type: application/json' \\
  -d '{
  "url": "https://example.com/webhook",
  "secret": "your-secret-min-16-chars",
  "events": "service.new,service.down"
}'</div>
          <p style="margin-top:12px"><strong>Management:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td><code>GET</code></td><td><code>/api/v1/webhooks/:id</code></td><td>Check webhook status. Requires <code>X-Webhook-Secret</code> header.</td></tr>
              <tr><td><code>DELETE</code></td><td><code>/api/v1/webhooks/:id</code></td><td>Remove webhook. Requires <code>X-Webhook-Secret</code> header.</td></tr>
            </tbody>
          </table>
          <p style="margin-top:8px">Webhooks are auto-deactivated after 10 consecutive delivery failures.</p>
        </div>

        <h2>Response Format</h2>
        <p>The services list endpoint returns JSON with the following structure:</p>
        <div class="response-sample">${escapeHtml(JSON.stringify({
          services: [
            {
              id: 1,
              name: 'Example Weather API',
              description: 'Real-time weather data from NOAA',
              url: 'https://api.example.com/weather',
              protocol: 'L402',
              price_sats: 5,
              price_usd: 0.002,
              payment_asset: 'BTC',
              payment_network: 'Lightning',
              category: 'real-time-data/weather',
              provider: 'Example Corp',
              source: 'exclusive',
              featured: 1,
              health_status: 'healthy',
              probe_status: 'probeable',
              uptime_30d: 0.997,
              latency_p50_ms: 245,
              last_checked: '2025-02-28T12:00:00Z',
              registered_at: '2025-01-15T08:30:00Z',
              http_method: 'GET',
              reliability_score: 92.5,
              x402_payment_valid: null,
              x402_facilitator_reachable: null,
              x402_asset_known: null,
              domain_verified: 1,
              l402_format: 'v2_tlv',
              lnget_compatible: 1,
              related_protocols: ['x402']
            }
          ],
          total: 7595,
          limit: 50,
          offset: 0
        }, null, 2))}</div>

        <h2>Upcoming Fields</h2>
        <p>The following fields are present in the schema but currently <code>null</code> for all services. They will be populated as providers adopt these standards.</p>
        <table class="params-table">
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Description</th></tr>
          </thead>
          <tbody>
            <tr><td>l402_version</td><td>string</td><td>Protocol version (bLIP-0026)</td></tr>
            <tr><td>agent_spec_url</td><td>string</td><td>URL to agent-spec.md for this endpoint (bLIP-0026)</td></tr>
            <tr><td>capabilities</td><td>string</td><td>JSON array of declared agent capabilities (bLIP-0026)</td></tr>
            <tr><td>token_format</td><td>string</td><td>Token format: <code>macaroon</code>, <code>opaque</code>, or <code>jwt</code></td></tr>
            <tr><td>invoice_type</td><td>string</td><td>Invoice type: <code>bolt11</code>, <code>bolt12</code>, or <code>taproot_asset</code></td></tr>
            <tr><td>pricing_model</td><td>string</td><td>Pricing model: <code>per-request</code>, <code>time-bounded</code>, or <code>token-bucket</code></td></tr>
            <tr><td>content_domain</td><td>string</td><td>Knowledge domain for AI/media endpoints (e.g. <code>bitcoin-media</code>, <code>ai-inference</code>)</td></tr>
          </tbody>
        </table>

        <h2>Rate Limits &amp; L402 Payments</h2>
        <p>API endpoints are rate-limited to ensure fair usage. Pay via Lightning Network to unlock higher limits.</p>
        <table class="params-table">
          <thead>
            <tr><th scope="col">Tier</th><th scope="col">Limit</th><th scope="col">How</th></tr>
          </thead>
          <tbody>
            <tr><td>Free</td><td>100 req/min per IP</td><td>No auth needed</td></tr>
            <tr><td>L402</td><td>1,000 req/min per IP</td><td><code>Authorization: L402 &lt;macaroon&gt;:&lt;preimage&gt;</code></td></tr>
          </tbody>
        </table>
        <p>When you exceed the free tier, the API returns <code>402 Payment Required</code> with a Lightning invoice in the <code>WWW-Authenticate</code> header. Pay the invoice, then include the L402 token in subsequent requests.</p>
        <p>Exempt from rate limiting: <code>/</code>, <code>/about</code>, <code>/api-docs</code>, <code>/service/*</code>, <code>/api/v1/health</code>, <code>/feed.xml</code>, <code>/opportunities</code></p>
        <p><em>402 Index is the first service listed in its own directory — the CSV export endpoint is L402-gated, so we eat our own dog food.</em></p>

        <h2>Domain Verification</h2>
        <p>Providers can claim their domain to edit listings directly. See the <a href="/verify">step-by-step guide</a> for the full flow.</p>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/claim</span>
          </div>
          <p>Initiate a domain claim. Returns a verification token (keep secret for API auth) and a verification hash (post publicly at <code>.well-known</code>).</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Hostname to claim (e.g. <code>api.example.com</code>). No protocol, path, or port.</td></tr>
              <tr><td>contact_email</td><td>string</td><td>Optional contact email for the provider</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/claim \\
  -H 'Content-Type: application/json' \\
  -d '{"domain": "api.example.com"}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>201</code></td><td>New claim created. Returns <code>verification_token</code>, <code>verification_hash</code>, <code>verification_url</code>, and <code>instructions</code>.</td></tr>
              <tr><td><code>200</code></td><td>Existing pending claim updated with a new token.</td></tr>
              <tr><td><code>400</code></td><td>Invalid domain format (includes protocol, path, port, or IP address).</td></tr>
              <tr><td><code>409</code></td><td>Domain already verified by another provider.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/claim/verify</span>
          </div>
          <p>Verify a pending domain claim. Fetches the <code>.well-known/402index-verify.txt</code> file from the domain and compares the SHA-256 hash.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Domain to verify</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/claim/verify \\
  -H 'Content-Type: application/json' \\
  -d '{"domain": "api.example.com"}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Domain verified. Returns <code>domain</code>, <code>status: "verified"</code>, and <code>services_count</code>.</td></tr>
              <tr><td><code>400</code></td><td>Invalid domain format.</td></tr>
              <tr><td><code>404</code></td><td>No pending claim found for this domain.</td></tr>
              <tr><td><code>409</code></td><td>Domain already verified.</td></tr>
              <tr><td><code>410</code></td><td>Claim expired (72-hour window). Initiate a new claim.</td></tr>
              <tr><td><code>422</code></td><td>Verification failed (token mismatch, redirect, unreachable, file too large, or SSRF blocked).</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/claim/revoke</span>
          </div>
          <p>Revoke a verified domain claim. Invalidates the token immediately. Re-initiate the claim flow to get a new token.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Verified domain to revoke</td></tr>
              <tr><td>verification_token</td><td>string</td><td><strong>Required.</strong> Current token (proves you own the claim)</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/claim/revoke \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4..."
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Claim revoked. Returns <code>status: "revoked"</code> and next-steps message.</td></tr>
              <tr><td><code>400</code></td><td>Missing domain or token.</td></tr>
              <tr><td><code>403</code></td><td>Invalid token, or no verified claim for this domain.</td></tr>
              <tr><td><code>404</code></td><td>No claim found for this domain.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/admin/domains/:domain/reset</span>
            <span style="background:rgba(255,90,90,0.15);color:var(--red);padding:2px 8px;border-radius:4px;font-size:12px;margin-left:8px">Admin Only</span>
          </div>
          <p>Reset a domain's verification token. Generates a new token, reverts status to <code>pending</code>, and sets a new 72-hour expiry. Does NOT clear <code>domain_verified</code> on services (grace period).</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string (path)</td><td><strong>Required.</strong> Domain to reset</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/admin/domains/api.example.com/reset \\
  -H 'Authorization: Bearer YOUR_ADMIN_SECRET'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Domain reset. Returns <code>verification_token</code>, <code>verification_hash</code>, <code>verification_url</code>, <code>expires_at</code>, and <code>instructions</code>.</td></tr>
              <tr><td><code>401</code></td><td>Missing or invalid admin authorization.</td></tr>
              <tr><td><code>404</code></td><td>No claim found for this domain.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/admin/services/:id/probe-status</span>
            <span style="background:rgba(255,90,90,0.15);color:var(--red);padding:2px 8px;border-radius:4px;font-size:12px;margin-left:8px">Admin Only</span>
          </div>
          <p>Toggle a service's probe status. When marking <code>unprobeable</code>, resets health metrics (<code>health_status</code> → <code>unknown</code>, <code>consecutive_failures</code> → 0, <code>uptime_30d</code> → NULL, <code>latency_p50_ms</code> → NULL, <code>reliability_score</code> → NULL).</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>id</td><td>string (path)</td><td><strong>Required.</strong> Service ID</td></tr>
              <tr><td>probe_status</td><td>string</td><td><strong>Required.</strong> One of <code>probeable</code> or <code>unprobeable</code></td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/admin/services/42/probe-status \\
  -H 'Authorization: Bearer YOUR_ADMIN_SECRET' \\
  -H 'Content-Type: application/json' \\
  -d '{"probe_status": "unprobeable"}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Success. Returns <code>id</code>, <code>probe_status</code>, and <code>previous</code> probe status.</td></tr>
              <tr><td><code>400</code></td><td>Invalid <code>probe_status</code> value (must be <code>probeable</code> or <code>unprobeable</code>).</td></tr>
              <tr><td><code>401</code></td><td>Missing or invalid admin authorization.</td></tr>
              <tr><td><code>404</code></td><td>Service not found.</td></tr>
            </tbody>
          </table>
        </div>

        <h3 style="margin-top:28px">Protocol Change Detection</h3>
        <p>
          During regular health checks, 402 Index detects when endpoints support additional protocols
          beyond what is registered (e.g., an L402 endpoint that also responds with x402 headers).
          Detected changes are reviewed by admins and, when approved, create new sibling listings
          automatically. This ensures your multi-protocol endpoints are fully represented in the directory.
        </p>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#4dabf7;background:rgba(77,171,247,0.1)">PATCH</span>
            <span class="endpoint-path">/api/v1/services/:id</span>
          </div>
          <p>Edit a listing by verified domain owner. The service URL hostname must match the claimed domain.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Your verified domain</td></tr>
              <tr><td>verification_token</td><td>string</td><td><strong>Required.</strong> Token from your domain claim</td></tr>
              <tr><td>name</td><td>string</td><td>Display name (max 200 chars)</td></tr>
              <tr><td>description</td><td>string</td><td>Description (max 2000 chars)</td></tr>
              <tr><td>category</td><td>string</td><td>Category (max 100 chars)</td></tr>
              <tr><td>price_usd</td><td>number</td><td>Price in USD (non-negative)</td></tr>
              <tr><td>price_sats</td><td>integer</td><td>Price in satoshis (non-negative integer)</td></tr>
              <tr><td>payment_asset</td><td>string</td><td>Payment asset (e.g. BTC, USDC)</td></tr>
              <tr><td>payment_network</td><td>string</td><td>Payment network (e.g. Lightning, Base)</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X PATCH https://402index.io/api/v1/services/SERVICE_ID \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4...",
  "description": "Updated description",
  "category": "ai/text"
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Service updated. Returns the full updated service record.</td></tr>
              <tr><td><code>400</code></td><td>Missing domain/token, no valid fields, field exceeds max length, or invalid price value.</td></tr>
              <tr><td><code>403</code></td><td>Invalid token, unverified domain, or service URL doesn't match claimed domain.</td></tr>
              <tr><td><code>404</code></td><td>Service not found.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#e03131;background:rgba(224,49,49,0.1)">DELETE</span>
            <span class="endpoint-path">/api/v1/services/:id</span>
          </div>
          <p>Soft-delete a listing by verified domain owner. The service is hidden from all queries, health checks, and pollers. Permanently purged after 30 days. Idempotent &mdash; deleting an already-deleted service returns 200.</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Your verified domain</td></tr>
              <tr><td>verification_token</td><td>string</td><td><strong>Required.</strong> Token from your domain claim</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X DELETE https://402index.io/api/v1/services/SERVICE_ID \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4..."
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Service soft-deleted (or already deleted). Returns <code>id</code> and confirmation message.</td></tr>
              <tr><td><code>400</code></td><td>Missing domain or verification_token.</td></tr>
              <tr><td><code>403</code></td><td>Invalid token, unverified domain, or service URL doesn't match claimed domain.</td></tr>
              <tr><td><code>404</code></td><td>Service not found.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="color:#f0a500;background:rgba(240,165,0,0.1)">POST</span>
            <span class="endpoint-path">/api/v1/services/bulk-delete</span>
          </div>
          <p>Bulk soft-delete up to 25 listings at once. Same auth as single delete. Services whose URL doesn't match the claimed domain are skipped (not rejected).</p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Parameter</th><th scope="col">Type</th><th scope="col">Description</th></tr>
            </thead>
            <tbody>
              <tr><td>ids</td><td>array</td><td><strong>Required.</strong> Array of service IDs to delete (max 25)</td></tr>
              <tr><td>domain</td><td>string</td><td><strong>Required.</strong> Your verified domain</td></tr>
              <tr><td>verification_token</td><td>string</td><td><strong>Required.</strong> Token from your domain claim</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/services/bulk-delete \\
  -H 'Content-Type: application/json' \\
  -d '{
  "ids": [101, 102, 103],
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4..."
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>200</code></td><td>Returns <code>deleted</code> (array of IDs), <code>skipped</code> (array of IDs), and <code>reasons</code> (object with skip reasons).</td></tr>
              <tr><td><code>400</code></td><td>Missing fields, ids not an array, empty, or exceeds 25.</td></tr>
              <tr><td><code>403</code></td><td>Invalid token or unverified domain.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="info-callout">
          <h3>MCP Server</h3>
          <p>Query the 402 Index directory directly from Claude, GPT, Cursor, or any MCP-compatible AI assistant.</p>

          <h4>Quick Start</h4>
          <div class="example-block">npx @402index/mcp-server</div>

          <h4>Claude Desktop</h4>
          <p>Add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>:</p>
          <div class="example-block">{
  "mcpServers": {
    "402index": {
      "command": "npx",
      "args": ["@402index/mcp-server"]
    }
  }
}</div>

          <h4>Claude Code</h4>
          <div class="example-block">claude mcp add 402index -- npx @402index/mcp-server</div>

          <h4>Cursor</h4>
          <p>Add to <code>.cursor/mcp.json</code>:</p>
          <div class="example-block">{
  "mcpServers": {
    "402index": {
      "command": "npx",
      "args": ["@402index/mcp-server"]
    }
  }
}</div>

          <h4>Available Tools</h4>
          <table class="params-table">
            <thead><tr><th scope="col">Tool</th><th scope="col">Description</th></tr></thead>
            <tbody>
              <tr><td><code>search_services</code></td><td>Search/filter paid APIs by protocol, category, health, price</td></tr>
              <tr><td><code>get_service_detail</code></td><td>Full details + health check history for a service</td></tr>
              <tr><td><code>list_categories</code></td><td>All categories with endpoint counts</td></tr>
              <tr><td><code>get_directory_stats</code></td><td>Ecosystem health, totals, sync timestamps</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `)
}
