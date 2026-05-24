# Quota Watcher — Cloudflare Worker + D1 Deployment Checklist

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
| Tables | ✅ organizations, org_members, providers, usage_snapshots, alert_events, model_pricing, \_cf_KV |
| Seed prices | ✅ 16 models seeded (OpenAI + Anthropic + Groq) |
| Worker `quota-watcher` | ⚠️ Uploaded as **draft** (not published) |
| AES_GCM_KEY secret | ❌ Not set (needs Workers Scripts write permission) |
| Cron trigger | ❌ Not configured |

## Why Not Published

The Token scope available from Termux has `Workers Scripts: Read` and `D1: Edit`,  
but is **missing `Workers Scripts: Edit`** needed to:
- Apply the AES_GCM_KEY secret
- Attach the D1 binding to the Worker
- Promote the compiled script to a live version and route

## How to Finish (Laptop — 5 min)

```bash
git clone git@github.com:nexusguardus/quota-watcher.git
cd quota-watcher
npm install -g wrangler@3
wrangler login
# Edit wrangler.toml: database_id pasted at creation (already correct: 526b46dd-aec4-4275-95dc-4c120c28ace0)
npx wrangler d1 migrations apply quota_db --local    # verify locally
npx wrangler d1 migrations apply quota_db --remote   # ensure prod matches
openssl rand -hex 32 | wrangler secret put AES_GCM_KEY
npx wrangler publish   # deploys to workers.dev + applies D1 binding + publishes
```

## Or Dashboard UI (no laptop, 2 min)

1. Cloudflare Dashboard → Workers & Pages → quota-watcher → **Settings**
2. **Variables → Add variable**  
   Name: `AES_GCM_KEY`  
   Type: `Secret` (text)  
   Value: paste `openssl rand -hex 32` output here
3. **Add D1 Database binding**  
   Variable name: `DB`  
   Database: choose `quota_db` (already in your account → the bound env var name must match `DB`)
4. Save → Worker is live at `https://quota-watcher.<account>.workers.dev`
5. **Settings → Triggers → Cron** → expression: `*/10 * * * *`

Then test:  
`curl https://quota-watcher.<your-account>.workers.dev/api/health`

## Route/URL

Once published, a `workers.dev` subdomain is auto-assigned:  
`https://quota-watcher.<account_id>.workers.dev`

## Architecture

```
quota-watcher Worker
├── /api/health               → { status: "healthy", env: "development" }
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
  last_polled_at INTEGER,
  created_at INTEGER

model_pricing:
  model_id, provider, input_cost_per_1m, output_cost_per_1m
```
