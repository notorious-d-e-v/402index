import Database from 'better-sqlite3'
import { ensureQuarantineSchema } from '../../src/services/visibility.js'

/**
 * Create a fresh :memory: SQLite DB with the full canonical schema.
 * Use for tests that need their own Database instance (not the db.js singleton).
 * Source of truth: src/db.js
 * SYNC WARNING: Any ALTER TABLE migration added to src/db.js must be
 * reflected here. Run `PRAGMA table_info(services)` on both to compare.
 */
export function createTestDb() {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('L402', 'x402', 'both', 'MPP')),
      price_sats INTEGER,
      price_usd REAL,
      payment_asset TEXT,
      payment_network TEXT,
      category TEXT,
      input_schema TEXT,
      output_schema TEXT,
      provider TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      featured INTEGER DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      health_status TEXT DEFAULT 'unknown' CHECK(health_status IN ('healthy', 'degraded', 'down', 'unknown')),
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      last_checked TEXT,
      last_seen_healthy TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      contact_email TEXT,
      status TEXT DEFAULT 'active',
      http_method TEXT DEFAULT 'GET',
      probe_body TEXT,
      reliability_score REAL,
      x402_payment_valid INTEGER,
      x402_facilitator_reachable INTEGER,
      x402_asset_known INTEGER,
      l402_version TEXT,
      agent_spec_url TEXT,
      capabilities TEXT,
      token_format TEXT,
      invoice_type TEXT,
      pricing_model TEXT,
      content_domain TEXT,
      domain_verified INTEGER DEFAULT 0,
      approval_reason TEXT,
      provider_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      hostname TEXT,
      l402_compliant INTEGER,
      l402_degrade_reason TEXT,
      l402_format TEXT,
      consecutive_latency_spikes INTEGER DEFAULT 0,
      lnget_compatible INTEGER,
      probe_status TEXT DEFAULT 'probeable'
    );

    CREATE INDEX idx_services_protocol ON services(protocol);
    CREATE INDEX idx_services_category ON services(category);
    CREATE INDEX idx_services_source ON services(source);
    CREATE INDEX idx_services_health ON services(health_status);
    CREATE UNIQUE INDEX idx_services_url_protocol ON services(url, protocol);
    CREATE INDEX idx_services_hostname ON services(hostname);

    CREATE TABLE health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL REFERENCES services(id),
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down', 'timeout', 'error', 'rate_limited', 'method_not_allowed')),
      response_time_ms INTEGER,
      http_status INTEGER,
      error_message TEXT
    );
    CREATE INDEX idx_health_checks_service ON health_checks(service_id, checked_at);

    CREATE TABLE daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL UNIQUE,
      total_endpoints INTEGER,
      verified_endpoints INTEGER,
      total_providers INTEGER,
      verified_providers INTEGER,
      healthy_endpoints INTEGER,
      degraded_endpoints INTEGER,
      down_endpoints INTEGER,
      l402_endpoints INTEGER,
      l402_verified INTEGER,
      l402_healthy INTEGER,
      l402_providers INTEGER,
      x402_endpoints INTEGER,
      x402_verified INTEGER,
      x402_healthy INTEGER,
      x402_providers INTEGER,
      mpp_endpoints INTEGER,
      mpp_verified INTEGER,
      mpp_healthy INTEGER,
      mpp_providers INTEGER,
      avg_reliability_score REAL,
      median_latency_ms INTEGER,
      p90_latency_ms INTEGER,
      categories_json TEXT,
      top_providers_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_daily_snapshots_date ON daily_snapshots(snapshot_date);

    CREATE TABLE domain_claims (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      verification_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'verified', 'expired', 'revoked')),
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT,
      expires_at TEXT NOT NULL,
      last_check_at TEXT,
      contact_email TEXT
    );
    CREATE UNIQUE INDEX idx_domain_claims_domain ON domain_claims(domain);
    CREATE INDEX idx_domain_claims_status ON domain_claims(status);

    CREATE TABLE registration_attempts (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      name TEXT,
      provider TEXT,
      contact_email TEXT,
      http_method TEXT,
      probe_body TEXT,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      failure_reason TEXT NOT NULL,
      probe_http_status INTEGER,
      probe_error TEXT,
      suggested_protocol TEXT,
      ip_address TEXT
    );
    CREATE INDEX idx_reg_attempts_date ON registration_attempts(attempted_at);

    CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query_text TEXT,
      filters TEXT,
      result_count INTEGER,
      response_time_ms INTEGER,
      user_agent TEXT
    );
    CREATE INDEX idx_query_log_timestamp ON query_log(timestamp);

    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'service.new',
      protocol_filter TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      failure_count INTEGER DEFAULT 0
    );

    CREATE TABLE service_embeddings (
      service_id TEXT PRIMARY KEY
        REFERENCES services(id) ON DELETE NO ACTION,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      -- embedded_at is epoch SECONDS (INTEGER), NOT ISO datetime TEXT
      embedded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_service_embeddings_embedded_at
      ON service_embeddings(embedded_at);
  `)

  ensureQuarantineSchema(db)
  return db
}

/**
 * Give a bare test schema what LISTED (src/services/visibility.js) reads: services.hostname and
 * the quarantined_hosts table. For tests that build their own minimal services table.
 */
export function withQuarantineSchema(db) {
  const cols = db.pragma('table_info(services)').map(c => c.name)
  if (!cols.includes('hostname')) db.exec('ALTER TABLE services ADD COLUMN hostname TEXT')
  ensureQuarantineSchema(db)
  return db
}
