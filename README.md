# Quota Watcher — Cloudflare Worker + D1

> **Status: Code complete ✅ | Deploy blocked ⚠️**

## What's Here

| File | Status |
|---|---|
| `worker.ts` | ✅ 297 lines — production skeleton |
| `wrangler.toml` | ✅ configured |
| `tsconfig.json` | ✅ with @cloudflare/workers-types |
| `.gitignore` | ✅ |
| `migrations/0001_initial.sql` | ✅ D1 schema (7 tables + indexes) |
| `migrations/0002_seed_model_pricing.sql` | ✅ Seeded prices |

## Cloudflare State

| Resource | Status |
|---|---|
| D1 database `quota_db` | ✅ Created — `526b46dd-aec4-4275-95dc-4c120c28ace0` |
| Migrations (0001 + 0002) | ✅ Applied |
| Tables | ✅ organizations, org_members, providers, usage_snapshots, alert_events, model_pricing |
| Seed prices | ✅ 16 models seeded |
| Worker `quota-watcher` | ⚠️ **Draft only** — uploaded to Cloudflare, not published |
| AES_GCM_KEY secret | ❌ **Missing** — needs `Workers Scripts: Edit` token scope |
| D1 binding (`DB`) | ❌ **Missing** — needs `Workers Scripts: Edit` token scope |
| Cron trigger | ❌ Not configured — needs published worker |

> ⚠️ Cloudflare API token `cfut_…` currently has `Workers Scripts: Read` + `D1: Edit`.
> It needs **Workers Scripts: Edit** to set the secret, attach the D1 binding, and publish.

## How to finish the deploy — 3 options

### Option 1: Fix & reuse the existing token (2 min)

Cloudflare dashboard → My Profile → API Tokens → find your current token → Edit → add **Workers Scripts > Edit** permission → Save.

I can then finish the remaining steps directly from Termux.

### Option 2: Laptop + wrangler (recommended, 5 min)

```bash
git clone git@github.com:nexusguardus/quota-watcher.git
cd quota-watcher
npm install -g wrangler@3

wrangler login
# Cloudflare opens in browser → authorize → returns to terminal

# D1 is already live; skip create, just verify
npx wrangler d1 migrations apply quota_db --local    # local check
npx wrangler d1 migrations apply quota_db --remote   # ensure prod matches

# Set the encryption secret
openssl rand -hex 32 | wrangler secret put AES_GCM_KEY

# Deploy (publishes to workers.dev + applies D1 binding + cron trigger)
npx wrangler publish
```

### Option 3: Dashboard UI (no laptop, 2 min paste)

1. **https://dash.cloudflare.com** → Workers & Pages → `quota-watcher`
2. **Settings → Variables → Add**
   - **Name** → `AES_GCM_KEY`
   - **Type** → `Secret` (text)
   - **Value** → paste `openssl rand -hex 32` output
   - Click **Encrypt and save**
3. **Settings → D1 Database Bindings → Add**
   | Field | Value |
   |---|---|
   | **Binding name** | `DB` (must match `env.DB` in worker.ts) |
   | **Database** | `quota_db` |
   - Click **Save**
4. **Settings → Triggers → Cron**
   - **Schedule (UTC)** → `*/10 * * * *`
   - Click **Save**
5. Hit **Save** at the bottom of Settings — the worker auto-deploys

## Worker URL

```
https://quota-watcher.omisrani19.workers.dev/api/health
```

> ⚠️ Do **not** use the raw account ID (`xxxxxxxxxxxxxxxxxxxxxxxxx`) — Cloudflare
> uses the **account label** (`omisrani19`) for the `workers.dev` subdomain.

## Verify health endpoint

```bash
curl https://quota-watcher.omisrani19.workers.dev/api/health
# Expected:
# {"status":"healthy","env":"production","ts":1716534000}
```

## Route key lock

| External name | Env var / binding | Notes |
|---|---|---|
| D1 binding name | `DB` | Must match exactly — `env.DB` in worker.ts line 242–244 |
| Secret name | `AES_GCM_KEY` | Worker reads `env.AES_GCM_KEY` at line 242 |
| ENVIRONMENT var | `ENVIRONMENT` | Default `"development"` in wrangler.toml; Cloudflare overrides to `"production"` |

## Architecture

```
quota-watcher Worker
├── /api/health               → { status: "healthy", env: "production", ts: <unix_timestamp> }
├── /api/providers            → list providers for org
├── /api/providers/connect    → POST { api_key } → encrypt(AES-256-GCM) → D1 insert
├── /api/providers/{id}/today → GET  last snapshot for provider
├── Cron  */10 * * * *         → poll /v1/usage per provider, UPSERT snapshot, evaluate alerts
│   └── resolves fine-tune IDs via resolveModelId()
│   └── looks up pricing from model_pricing D1 table
│   └── UNIQUE(provider_id, alert_type, alert_date) prevents duplicate alerts
└── D1 binding: DB → quota_db
    └── 7 tables: organizations, org_members, providers,
                  usage_snapshots, alert_events, model_pricing
```

## Schema: quota_db

```sql
providers:
  id, org_id, provider_name, encrypted_credentials, iv,
  budget_cap REAL DEFAULT 0.0,
  budget_quota_limit REAL DEFAULT 0.0,    ← unit-based APIs (ElevenLabs, Perplexity)
  alert_threshold_percent REAL DEFAULT 80.0,
  last_polled_at INTEGER, created_at INTEGER

model_pricing:
  model_id, provider, input_cost_per_1m, output_cost_per_1m
```

## Git

```
https://github.com/nexusguardus/quota-watcher (branch main)
```
