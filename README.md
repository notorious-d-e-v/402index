# 402 Index

Protocol-agnostic directory of paid APIs for AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm: @402index/mcp-server](https://img.shields.io/npm/v/@402index/mcp-server.svg)](https://www.npmjs.com/package/@402index/mcp-server)
[![Live: 402index.io](https://img.shields.io/badge/live-402index.io-green.svg)](https://402index.io)

**What it is:** a registry of HTTP 402–priced APIs across every major machine-payment protocol — [L402](https://github.com/lightninglabs/L402) (Lightning), [x402](https://github.com/coinbase/x402) (stablecoins), and [MPP](https://mpp.dev/) (Stripe/Tempo) — surfaced to AI agents via HTTP, RSS, Nostr, and MCP.

**Who it's for:** AI-agent developers looking for services to call, and API providers looking to get discovered by agents. The directory is community-owned: open source, MIT-licensed, no captive protocol.

**Where it lives:** [402index.io](https://402index.io) (production) · [@402index](https://twitter.com/402index) (digest) · [GitHub Issues](https://github.com/ryanthegentry/402index/issues) (roadmap).

---

## Quickstart

### For agents (MCP)

One command adds 402 Index discovery + payment to any MCP host (Claude Desktop, Cursor, Cline, Windsurf):

```bash
npm install -g @402index/mcp-server
```

Then register it with your MCP host — see [`mcp-server/README.md`](mcp-server/README.md) for per-client instructions.

### For agents (HTTP)

```bash
# Semantic search
curl "https://402index.io/api/v1/services?q=weather&verified=true&limit=10"

# Filter by protocol
curl "https://402index.io/api/v1/services?protocol=L402&health=healthy"
```

Full API reference at [402index.io/api-docs](https://402index.io/api-docs).

### For API providers

Register your endpoint so agents can find it:

- **Self-serve:** `POST https://402index.io/api/v1/register` with your endpoint URL. The probe validates the 402 challenge, detects L402 and/or x402 support, and lists automatically.
- **Pull request:** add a YAML file under `listings/` — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Already on Bazaar, PayAI, Satring, or l402apps?** You're already indexed — no action needed.

### For contributors

```bash
git clone https://github.com/ryanthegentry/402index.git
cd 402index
npm install
npm test                # Run tests (node:test)
npm run dev             # Start dev server (nodemon)
npm run poll            # Pull from Bazaar + Satring manually
npm run healthcheck     # Run health checks manually
```

---

## What's in the registry

Tens of thousands of endpoints across hundreds of verified providers, aggregated from the [x402 Bazaar](https://x402.org/bazaar), the [PayAI](https://payai.network) facilitator's discovery catalog, [Satring](https://satring.com), [l402apps.com](https://www.l402apps.com), MPP's OpenAPI directory, and direct self-submissions — no gatekeeping by protocol.

Live numbers at [402index.io/api/v1/health](https://402index.io/api/v1/health).

---

## Architecture

- **Node.js + Express**, SQLite via `better-sqlite3`, static HTML via template literals (no framework).
- **Aggregators** (`src/aggregators/`) poll Bazaar / Satring / l402apps on a schedule and upsert normalized listings.
- **Health checker** (`src/health/checker.js`) probes listings on a configurable interval, defaulting to 60 minutes (`HEALTH_CHECK_INTERVAL_MS`), with SSRF-safe fetch, records status, emits events.
- **Semantic search** via [`sqlite-vec`](https://github.com/asg017/sqlite-vec) + hybrid LIKE/vector re-rank, with circuit-breaker fallback to LIKE-only when the embeddings service is down.
- **Distribution:** HTTP API, MCP server, RSS, Nostr (NIP-99), webhooks (HMAC-SHA256).
- **Verifier** handles BOLT11 invoices (L402) and ERC-20 stablecoin challenges (x402), including x402-over-Lightning.

Deeper notes in [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs/).

---

## Project layout

```
402index/
├── src/               # Application code (routes, aggregators, services, views)
├── mcp-server/        # @402index/mcp-server (published to npm)
├── listings/          # YAML listings for manually curated / exclusive providers
├── test/              # Tests (node:test)
├── scripts/           # Ops scripts (poll, healthcheck, backfills)
├── docs/              # Specs, API docs, protocol notes
└── .github/workflows/ # CI
```

---

## Contributing

PRs welcome for listings, code, and docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for the fork-branch-PR flow and [CLAUDE.md](CLAUDE.md) for code style and the bug-fix protocol (failing-test-first).

Roadmap is the [open issues list](https://github.com/ryanthegentry/402index/issues). Good starter tasks have the `good-first-issue` label.

## Security

Please do **not** open a public issue for suspected vulnerabilities. See [SECURITY.md](SECURITY.md) for responsible-disclosure contacts and the threat model summary.

## License

[MIT](LICENSE). Use it, fork it, ship it.

---

Built by [@ryanthegentry](https://github.com/ryanthegentry) and the community. Questions → [hello@402index.io](mailto:hello@402index.io) or [GitHub Discussions](https://github.com/ryanthegentry/402index/discussions).
