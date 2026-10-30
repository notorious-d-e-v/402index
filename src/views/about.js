import { layout } from './layout.js'

export function aboutPage() {
  return layout('About', `
    <div class="container">
      <div class="about-content">
        <h1>What is 402 Index?</h1>
        <p>
          402 Index is a protocol-agnostic directory of paid APIs designed for AI agents.
          We index services that use <strong>L402</strong> (Lightning Network paywalls),
          <strong>x402</strong> (crypto micropayments via Base/Solana), and
          <strong>MPP</strong> (Machine Payments Protocol via Stripe/Tempo).
        </p>
        <p>
          AI agents need to discover, evaluate, and pay for API services autonomously.
          402 Index provides the discovery layer — a searchable directory with real-time
          health monitoring, pricing information, and schema documentation.
        </p>

        <h2>How it works</h2>
        <p>
          We aggregate services from multiple sources:
        </p>
        <p>
          <strong><a href="https://x402.org" target="_blank" rel="noopener">x402 Bazaar</a></strong> — Coinbase's auto-registration directory for x402-enabled endpoints.
          We poll this hourly and normalize the data into our schema.
        </p>
        <p>
          <strong><a href="https://satring.com" target="_blank" rel="noopener">Satring</a></strong> — A Paid API Directory for AI Agents: Discover paid APIs for your AI agents, via Lightning and USDC.
        </p>
        <p>
          <strong>Exclusive listings</strong> — Manually curated services submitted via YAML files.
          These are the highest-quality listings, reviewed by the 402 Index team.
        </p>
        <p>
          <strong><a href="https://l402apps.com" target="_blank" rel="noopener">L402 Apps</a></strong> — A community directory of L402-enabled apps and APIs, scraped daily.
        </p>
        <p>
          <strong><a href="https://paysponge.com" target="_blank" rel="noopener">Sponge</a></strong> — x402 services cataloged by PaySponge.
        </p>
        <p>
          <strong><a href="https://payai.network" target="_blank" rel="noopener">PayAI</a></strong> — x402 services listed in the PayAI facilitator's discovery catalog (Bazaar-compatible). Endpoints already indexed from the Bazaar keep their Bazaar data.
        </p>
        <p>
          <strong>Well-Known</strong> — Endpoints discovered via providers' <code>/.well-known/l402-services</code> JSON documents.
        </p>
        <p>
          <strong><a href="https://mpp.dev" target="_blank" rel="noopener">MPP (Tempo)</a></strong> — Machine Payments Protocol services from Tempo's aggregation API.
          These are services that accept Stripe/Tempo machine payments, including major AI platforms
          like OpenAI, Anthropic, and Google Gemini.
        </p>
        <p>
          <strong>Self-registered</strong> — Endpoints registered programmatically via our <a href="/api-docs">registration API</a>,
          verified automatically and reviewed before going live.
        </p>
        <p>
          Every service is health-checked every hour. For paid API services,
          a <code>402 Payment Required</code> response means the service is healthy —
          the paywall is active and working.
        </p>

        <h2>Methodology</h2>

        <p>
          Every number on 402 Index is independently verified. We don't take any source's word
          for it — we check every endpoint ourselves, every hour.
        </p>

        <p>
          <strong>Endpoints indexed</strong> is the total count of unique paid API endpoints
          we track across all sources. This includes every service registered in x402 Bazaar,
          Satring, L402 Apps, and our exclusive listings.
        </p>

        <p>
          <strong>402 header parsed</strong> marks the subset whose payment challenge we fetched and
          parsed ourselves. Nobody pays during this check, so it shows the paywall is answering, not
          that a payment will settle. What we check depends on the protocol:
        </p>

        <p>
          For <strong>L402</strong> endpoints: we send an HTTP request and confirm the service
          returns <code>402 Payment Required</code> with a valid <code>WWW-Authenticate: L402</code>
          header containing a properly formatted macaroon/token and a BOLT11 Lightning invoice.
          If the paywall is active and the credentials parse correctly, we mark the endpoint <em>402 header parsed</em>. That means the challenge is well formed; it does not mean anyone has paid it.
          For POST-only endpoints, we send the configured HTTP method. Some providers validate
          the request body before issuing the L402 challenge — for these, we send a per-endpoint
          probe body so the health check reaches the paywall layer.
          We also classify the token format (V2 TLV binary, V1 binary, V0 libmacaroons text, JSON, or unknown)
          and surface whether each endpoint is compatible with Lightning Labs' <code>lnget</code> client.
          Format is informational metadata per
          <a href="https://github.com/lightningnetwork/lnd/blob/master/docs/blip-0026.md">BLIP-0026</a>'s
          token-agnostic design — it does not affect health status. Only payment hash mismatch
          (token doesn't commit to the invoice payment hash) degrades health.
        </p>

        <p>
          For <strong>x402</strong> endpoints: we send an HTTP request and check for a
          <code>PAYMENT-REQUIRED</code> response header containing a valid base64-encoded JSON
          payload. We validate that the <code>accepts[]</code> array includes a recognized payment
          scheme, a known asset contract address (e.g., USDC on Base), a valid <code>payTo</code>
          address, and a reachable facilitator URL. If any of these checks fail, the endpoint is
          indexed but not marked 402 header parsed.
        </p>

        <p>
          For <strong>MPP</strong> endpoints: we send an HTTP request and confirm the service
          returns <code>402 Payment Required</code> with a valid <code>WWW-Authenticate: Payment</code>
          header. We parse the challenge for required fields: <code>id</code>, <code>realm</code>,
          <code>method</code>, and either <code>intent</code> or <code>request</code> (base64-encoded
          payment details). The <code>method</code> field indicates the payment rail (e.g.,
          <code>tempo</code>, <code>lightning</code>). If the challenge parses correctly with all
          required fields present, we mark the endpoint 402 header parsed.
        </p>

        <h3 id="wellknown">.well-known Discovery</h3>
        <p>
          Some L402 providers publish a discovery document at
          <code>/.well-known/l402-services</code> that describes their endpoints, required
          request schemas, and pricing. When a self-registration probe fails because the endpoint
          validates request bodies, we check this document automatically and retry with the
          correct configuration. This is an emerging convention — providers can publish one to
          make their endpoints instantly discoverable and self-registrable.
        </p>

        <p>
          <strong>Health status</strong> reflects whether the endpoint is reachable and responding
          correctly:
        </p>

        <p>
          <span style="color:var(--green)">&#9679;</span> <strong>Healthy</strong> — responded with
          HTTP 402 (paywall active) within the timeout window on the last check.<br>
          <span style="color:var(--yellow)">&#9679;</span> <strong>Degraded</strong> — responding, but
          with unexpected status codes, slow response times, or intermittent failures.<br>
          <span style="color:var(--red)">&#9679;</span> <strong>Down</strong> — not responding or
          returning errors on consecutive checks.
        </p>

        <p>
          <strong>Why do some sources show a large gap between "indexed" and "402 header parsed"?</strong>
          Auto-registration directories may catalog endpoints when they first process a payment,
          but don't keep checking that the paywall still answers. 402 Index re-checks endpoints
          every hour, longest-unchecked first. If an endpoint stops returning a valid challenge,
          it stays indexed but loses the 402-header-parsed mark, and a host that stops answering
          altogether is quarantined out of our counts until it answers again. A parsed challenge
          is evidence the paywall is up, not proof that a payment will settle.
        </p>

        <h2>For API providers</h2>
        <p>
          Want to list your paid API on 402 Index? There are a few ways to get started:
        </p>
        <p>
          <strong>1. Add x402 to your API.</strong> The
          <a href="https://www.x402.org/" target="_blank">x402 protocol</a> lets you add
          crypto micropayments to any HTTP endpoint. Your service will be auto-discovered
          via the Bazaar and indexed here.
        </p>
        <p>
          <strong>2. Add L402 to your API.</strong> Use
          <a href="https://l402.org/" target="_blank">L402</a> to paywall your API with
          Lightning Network micropayments.
        </p>
        <p>
          <strong>3. Add MPP to your API.</strong> Use the
          <a href="https://mpp.dev" target="_blank">Machine Payments Protocol</a> to accept
          Stripe/Tempo payments. Your service will be auto-discovered via the Tempo API
          and indexed here.
        </p>
        <p>
          <strong>4. Register via API.</strong> Agents and developers can register L402 endpoints
          programmatically. Your endpoint must return HTTP <code>402</code> with the
          appropriate payment header for your protocol (L402, x402, or MPP).
          Registrations are verified automatically and reviewed before going live.
        </p>
        <pre>curl -X POST https://402index.io/api/v1/register \\
  -H 'Content-Type: application/json' \\
  -d '{
  "url": "https://api.example.com/resource",
  "name": "My L402 API",
  "protocol": "L402",
  "http_method": "POST",
  "provider": "My Org"
}'</pre>
        <p>
          See the <a href="/api-docs">API docs</a> for the full field reference.
        </p>
        <p>
          <strong>Already listed?</strong> If your endpoints are already indexed (e.g., from Bazaar
          or Satring), you can <a href="/verify">claim your domain</a> to edit your listings
          directly &mdash; update names, descriptions, categories, and pricing.
        </p>
        <p>
          <strong>5. Email us a listing.</strong> Send a YAML file describing your service
          to <a href="mailto:hello@402index.io">hello@402index.io</a> for manual review.
        </p>
        <pre>name: "My Weather API"
url: "https://api.example.com/weather"
protocol: L402
price_sats: 5
price_usd: 0.002
payment_asset: "BTC/Lightning"
category: "real-time-data/weather"
description: "Weather forecasts from NOAA data"
provider: "Example Corp"</pre>

        <h2>For AI agent developers</h2>
        <p>
          Use our <a href="/api-docs">REST API</a> to query the directory programmatically.
          Filter by protocol, category, price, health status, and more.
        </p>
        <pre>GET /api/v1/services?health=healthy&category=real-time-data&max_price_usd=0.01</pre>
        <p>
          An MCP server is available for direct integration with Claude, GPT, and other AI assistants.
          See the <a href="/api-docs">API docs</a> for details.
        </p>

        <p style="margin-top:24px">
          402 Index is an open directory of paid APIs for AI agents.
        </p>
      </div>
    </div>
  `)
}
