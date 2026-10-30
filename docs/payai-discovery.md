# PayAI discovery importer

The hourly poll reads the public PayAI catalog at
`https://facilitator.payai.network/discovery/resources`. It shares the Bazaar v1/v2
normalizer, including v2 prices, descriptions, and declared HTTP methods.

## Directory policy

The importer excludes IP literals and the tunnel/IP-alias domains requested in
[review #355](https://github.com/ryanthegentry/402index/pull/355#issuecomment-6450451729):
`trycloudflare.com`, `ngrok.io`, `ngrok-free.app`, `ngrok.app`, `ts.net`, `lhr.life`,
`srv.us`, `sslip.io`, and `nip.io`. Matching respects domain boundaries and URL
hostname normalization. Non-HTTP URLs, credentials in URLs, and local hostnames
are also excluded.

All PayAI-supported testnets are excluded in both legacy and CAIP-2 formats:
Base Sepolia, Solana Devnet, BSC testnet, Avalanche Fuji, Sei testnet, Polygon
Amoy, X Layer testnet, SKALE Base Sepolia, and Arbitrum Sepolia (also legacy
`solana-testnet`). If a resource also
has a mainnet offer, the normalizer uses a retained offer, so its displayed
price and network do not come from the testnet offer.

These are 402index admission choices. The [upstream spec](https://github.com/x402-foundation/x402/blob/14bc0fbf784914a6eb24bf87cdcd8d827e2b3ff3/specs/extensions/bazaar.md#facilitator-behavior)
leaves catalog exposure to facilitators. [Coinbase's guidance](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
supports testnet discovery and describes lower ranking for shared tunnel hosts.
Their existence in a source catalog is not itself a protocol violation.
PayAI has also chosen to exclude testnets from its public catalog; the importer
retains its own filter so it does not depend on that deployment or cleanup.

## Ownership and moderation

New rows have `source = 'payai'`. A row owned by another source keeps its source,
metadata, and retirement state; only `payai_seen_pass` changes. The public source
filter continues to represent the owning source.

The importer skips hosts in `quarantined` or `held` state and preserves
`provider_deleted`. Watch and released hosts remain eligible. Relisting restores
only rows retired by PayAI's own automatic pass tracking, not manual retirements.

## Bounded scans and retirement

- `PAYAI_MAX_PAGES` defaults to 100, with 100 resources per page. Positive integer
  overrides are capped at 1,000. Each run resumes from the saved offset.
- `PAYAI_FULL_PASS_TIMEOUT_HOURS` defaults to 24. An expired unfinished pass is
  abandoned with a fresh pass id; it cannot contribute retirement evidence.
- Each page commits catalog writes, presence stamps, coverage counters, and its
  next offset together. HTTP failures and invalid pages do not advance it.
- A finished pass counts only when at least 90% of the largest reported upstream
  total was inspected and no item-processing errors occurred. Deliberate policy
  exclusions count toward coverage because PayAI's total includes those rows.
  Empty catalogs and truncated passes do not trigger retirement.
- A complete pass sets `upstream_missing_since` on absent PayAI-owned rows.
  Seven complete absences set `status = 'retired'` and a
  `payai-auto-pass-<id>` batch. Relisting clears that retirement and its timestamps.

Offset pagination is not a snapshot: catalog changes between requests can shift
rows. Coverage and repeated passes reduce false retirements but cannot guarantee
a perfectly consistent view. No live catalog deletion is performed by this PR.

The database adds one nullable presence column and one small summary row per
finished pass. It does not store a new URL history on every pass.
