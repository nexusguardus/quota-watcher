-- ============================================================
--  MIGRATION 0001 — Initial schema
--  Run:  wrangler d1 execute quota --file=./migrations/0001_initial.sql
-- ============================================================

--  ORGANIZATIONS
CREATE TABLE IF NOT EXISTS organizations (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  clerk_org_id    TEXT    UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  plan            TEXT    DEFAULT 'free',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

--  ORG MEMBERS
CREATE TABLE IF NOT EXISTS org_members (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL
                   REFERENCES organizations(id) ON DELETE CASCADE,
  clerk_user_id   TEXT    NOT NULL,
  role            TEXT    DEFAULT 'member',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, clerk_user_id)
);

--  PROVIDERS (connected API keys)
CREATE TABLE IF NOT EXISTS providers (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL
                           REFERENCES organizations(id) ON DELETE CASCADE,
  provider_name           TEXT NOT NULL,
  name                    TEXT NOT NULL,

  -- AES-256-GCM encrypted API key
  encrypted_credentials   TEXT NOT NULL,
  iv                      TEXT NOT NULL,

  -- Budget
  budget_cap              REAL DEFAULT 0,
  budget_quota_limit      INTEGER,
  budget_quota_unit       TEXT,
  alert_threshold_percent REAL DEFAULT 80,

  -- Polling state
  last_polled_at          INTEGER,
  last_poll_error         TEXT,
  enabled                 INTEGER DEFAULT 1,
  created_at              TEXT DEFAULT (datetime('now'))
);

--  USAGE SNAPSHOTS
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  provider_id     TEXT NOT NULL
                   REFERENCES providers(id) ON DELETE CASCADE,
  snapshot_date   TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,
  derived_cost    REAL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_id, snapshot_date)
);

--  ALERT EVENTS
CREATE TABLE IF NOT EXISTS alert_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  provider_id     TEXT NOT NULL
                   REFERENCES providers(id) ON DELETE CASCADE,
  alert_type      TEXT NOT NULL,
  alert_date      TEXT NOT NULL,
  triggered_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_id, alert_type, alert_date)
);

--  MODEL PRICING
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id       TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  input_cost_per_1m  REAL NOT NULL,
  output_cost_per_1m REAL NOT NULL,
  updated_at     TEXT DEFAULT (datetime('now'))
);

--  INDEXES
CREATE INDEX IF NOT EXISTS idx_providers_org    ON providers(org_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON usage_snapshots(provider_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_alert_events_idx ON alert_events(provider_id, alert_date);
