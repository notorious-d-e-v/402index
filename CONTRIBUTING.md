# Contributing to 402 Index

Thanks for considering a contribution. 402 Index is a community-owned registry — PRs for listings, code, docs, and infrastructure are all welcome.

## Ways to contribute

- **Submit a new listing** (your API or one you know of) → see [Submitting a listing](#submitting-a-listing).
- **Fix a bug or add a feature** → browse [open issues](https://github.com/ryanthegentry/402index/issues), especially those labeled `good-first-issue`.
- **Improve docs** → typo fixes, clearer explanations, API examples — all appreciated.
- **Report a bug** → [open an issue](https://github.com/ryanthegentry/402index/issues/new).

Security issues should go through [SECURITY.md](SECURITY.md), not public issues.

## Submitting a listing

### Option 1: Self-serve API

```bash
curl -X POST https://402index.io/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"url": "https://api.example.com/v1/resource"}'
```

The probe will validate the 402 challenge, detect L402 and/or x402 support, and list automatically.

### Option 2: YAML pull request

1. Fork this repo
2. Create a new YAML file in `listings/` named after your service (e.g., `listings/my-api.yaml`):

```yaml
name: "My Lightning API"
description: "One-line description of what this API does"
url: "https://api.example.com/v1/resource"
protocol: "L402"          # L402 or x402
price_sats: 100           # For L402 (satoshis per request)
# price_usd: 0.001        # For x402 (USD per request)
payment_asset: "BTC"
payment_network: "Lightning"
category: "ai/ml"         # See categories below
provider: "Your Org Name"
```

3. Open a PR titled `Add listing: [Your Service Name]`.

### Option 3: Already listed elsewhere

If your endpoint is on the x402 Bazaar, PayAI's discovery catalog, Satring, l402apps, or MPP's OpenAPI directory, you're already indexed — no action needed. If you're missing, open an issue with the source and we'll investigate the aggregator.

### Listing requirements

- The URL must resolve to a real, reachable endpoint. Automated health checks run on a configurable interval, currently defaulting to 60 minutes.
- L402 services must return HTTP 402 with a valid L402 challenge when accessed without a token.
- x402 services must return HTTP 402 with a valid x402 payment challenge.
- Dedup is by `(url, protocol)`. A PR with a duplicate URL will update the existing entry.

### Categories

Use one of these (or propose a new one in your PR):

| Category | Description |
|----------|-------------|
| `ai/ml` | AI inference, LLMs, embeddings |
| `bitcoin` | Bitcoin, Lightning, on-chain data |
| `crypto/defi` | DeFi protocols, swaps, liquidity |
| `crypto/nft` | NFTs, ordinals, inscriptions |
| `crypto/prices` | Token prices, market data |
| `crypto/wallet` | Wallet services, balances |
| `crypto/payments` | Payment infrastructure |
| `identity` | Trust scores, reputation, verification |
| `real-time-data` | News, weather, market feeds |
| `social` | Messaging, social networks |
| `storage` | File storage, key-value stores |
| `tools` | General utilities, search, compute |
| `tools/moderation` | Content moderation, filtering |
| `tools/marketplace` | Job boards, task markets |

### After submission

1. PR reviewed (usually within 24 hours)
2. Once merged, the listing appears on [402index.io](https://402index.io) immediately
3. Health checks begin within the next scheduled health-check window
4. Healthy services appear with a green shield. Verified services (domain + payment) appear with a blue shield.

### Featured listings

Want your service pinned to the top of the directory? Open an issue or mention it in your PR. Featured listings must be healthy and actively maintained.

## Code contributions

### Setup

```bash
git clone https://github.com/ryanthegentry/402index.git
cd 402index
npm install
npm test
npm run dev
```

### Development flow

1. Fork the repo and create a topic branch off `master`.
2. Make your change. Keep PRs focused — one concern per PR.
3. Add or update tests. See [CLAUDE.md](CLAUDE.md) for the bug-fix protocol (failing-test-first).
4. Run `npm test` and ensure all tests pass.
5. Open a PR with a clear title and description. Link related issues.

### What CI checks on a PR

`npm test` passing locally is not enough to merge. Branch protection on `master` requires
seven status checks to report green:

| Check | What it runs | Run it locally |
|-------|--------------|----------------|
| `test (20)`, `test (24)` | The root `node:test` suite on Node 20 and Node 24. | `npm test` |
| `mcp-server-test (20)` | The `mcp-server/` suite on Node 20. | `cd mcp-server && npm test` — note this builds first and rewrites `mcp-server/dist/`, so commit or discard the result deliberately. |
| `lint` | eslint on Node 22. Only `no-undef` is enforced; the rest of the recommended set is off. Covers root `src/`, `test/`, and `scripts/` — `mcp-server/` and `public/` are ignored. | `npm run lint` |
| `e2e` | The Playwright specs in `test/e2e/` against a locally booted server: handler smoke *plus* UI regression (filter-chip overflow, getting-started modal). A UI change can break this even when handlers are fine. | Once: `npx playwright install --with-deps chromium`. Then `npm run test:e2e` — **read the caveat below before you run it.** |
| `security` | Records an `npm audit` report as a build artifact. **This check does not enforce anything** — the audit step is `continue-on-error: true`, so a vulnerability finding will not turn it red. Only an infrastructure failure — a broken `npm ci`, or a failed checkout/setup/artifact-upload step — can fail it. | `npm audit --audit-level=moderate` |
| `scan` | gitleaks secret scan, using `.gitleaks.toml`. On a PR it scans the commits in that PR, not the whole history. | `gitleaks detect --config .gitleaks.toml --log-opts="origin/master..HEAD"` — the `--log-opts` matters: without it gitleaks walks your entire history and reports pre-existing hits that CI never gates on. See the allowlist note below before suppressing anything. |

**Before you run `e2e` locally.** It is not inert the way `npm test` is. `npm test` pins
`DB_PATH=:memory:`; `npm run test:e2e` does not — it boots a real server that opens your
working `data/` database and starts the background scheduler, which immediately polls every
third-party aggregator from your IP address and, shortly after, health-checks every service
endpoint stored in that database (pruning old `health_checks` rows as it goes). Prefix the
run to keep it off your dev data — `DB_PATH=:memory: npm run test:e2e` — which is what CI
effectively does; the specs don't need seeded rows. Note that `:memory:` only protects your
data, not your network: the scheduler still starts, still polls the aggregators, and still
health-checks the `listings/*.yaml` endpoints, which it loads into whichever database is
open. The outbound traffic happens either way — it is just a handful of listing URLs instead
of your whole dev database. One more trap: Playwright reuses whatever is already listening
on port 3402 rather than starting your working tree, so kill any stray dev server first or
you may get a green run against stale code.

**Before you add a gitleaks allowlist entry.** Allowlist only values that are genuinely
intentional fixtures or documented placeholders. A real credential that leaks must be
rotated, never allowlisted — an allowlist entry silences the alarm, it does not un-publish
the secret. Keep new entries as narrow as the existing ones: pin `targetRules`, `paths`, and
`regexes` together under `condition = "AND"` so the exemption cannot quietly cover an
unrelated hit later.

Three things that regularly confuse contributors:

- **`e2e` and `security` declare `needs: test`.** If either `test` job fails, neither one
  ever starts, and the PR shows "Expected — waiting for status" on both indefinitely.
  That is not a stuck check — fix the failing `test` job and they will run.
- **Branch protection is strict.** Your branch must be up to date with `master` before it
  can merge, and the `test` job independently fails a PR whose head is not a descendant of
  `origin/master`. Rebase: `git pull --rebase origin master && git push --force-with-lease`.
- **Seven required is not everything that runs.** A PR touching `mcp-server/**` also
  triggers `drift-check`, which is not in the required set but does fail on stale committed
  build output, version-string drift, or a tarball that diverges from
  `mcp-server/.tarball-allowlist.txt`. Don't merge over a red `drift-check` just because it
  isn't required.

### Commit messages

Conventional commits are preferred (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`), but not strictly enforced.

### Assertion guardrail

This project has a structural check that detects when an existing test assertion is modified — specifically, when an assertion is removed and a new one is added within the same diff hunk. This prevents accidentally rewriting tests to match buggy behavior instead of catching it.

When you intentionally modify an existing test assertion, add one of these keywords to the **body** of your commit message (not the subject line):

- **`BEHAVIOR-CHANGE: <summary>`** — use when the user-facing behavior is intentionally changing.
- **`ASSERTION-REFACTOR: <summary>`** — use for cosmetic changes that don't alter behavioral contracts (variable renames, switching assertion methods, reformatting).

Example:

```
fix: add auth gate to admin dashboard

The admin page now requires authentication instead of being publicly
accessible.

BEHAVIOR-CHANGE: admin page now requires server-side auth gate
```

The check triggers only when a hunk in `test/**/*.test.js` contains both a removed (`-`) and added (`+`) line matching common assertion methods (`assert.equal`, `assert.ok`, `assert.deepEqual`, `assert.strictEqual`, etc.). It does NOT trigger for adding new assertions, deleting without replacement, or changes in separate hunks.

## Security tests

Some security-relevant tests (constant-time comparison timing gates) are
sensitive to CPU contention and are disabled by default. To run them:

    RUN_TIMING_TESTS=1 npm test -- test/constant-time.test.js

## Code of conduct

Be kind, be specific, be patient. Disagree technically, not personally. Maintainers and contributors are volunteers.

## Questions?

- [Open a discussion](https://github.com/ryanthegentry/402index/discussions)
- [Open an issue](https://github.com/ryanthegentry/402index/issues/new)
- Email: hello@402index.io
