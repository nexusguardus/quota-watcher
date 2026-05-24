# Quota Watcher — Cloudflare Worker + D1

> **Status: Code complete ✅ | Deploy blocked ⚠️**

## What's Here

| File | Status |
|---|---|
| `worker.ts` | ✅ 297 lines — production skeleton |
| `wrangler.toml` | ✅ configured |
| `tsconfig.json` | ✅ zelosdev / @cloudflare/workers-types |
| `.gitignore` | ✅ |
| `migrations/0001_initial.sql` | ✅ D1 schema (6 tables + indexes) |
| `migrations/0002_seed_model_pricing.sql` | ✅ Seeded prices |

## Deployed to Cloudflare ✅

- **D1 database** `quota_db` — created ✅
- **Migrations** — both applied ✅
- **Worker script** `quota-watcher` — uploaded to Cloudflare ✅
- **Deployment status** — `draft` only (worker content stored but NOT published) ⚠️

### Why not published

The Cloudflare API token **does not have `Workers Scripts: Edit` write permissions** for:

- `POST /publish`
- `POST /secrets` (AES_GCM_KEY)
- `POST /deployments`

D1 write (`POST /d1/database/{id}/query`) works fine ✅ and migrations are applied.

The token has `Workers Scripts: Read` (enough for listing) and `D1: Edit` and `Workers & Pages: Read`.

## How to finish the deploy — 3 options

### Option 1: Fix & use existing token (2 min)
Go to Cloudflare dashboard → My Profile → API Tokens → find your current token → Edit → add **Workers Scripts > Edit** permission → Save
Then run the publish commands from your laptop with wrangler.

### Option 2: Run from laptop with wrangler (recommended, 5 min)
```bash
git clone git@github.com:nexusguardus/quota-watcher.git
cd quota-watcher
npm install -g wrangler@3
wrangler login
npx wrangler d1 create quota_db          # paste UUID into wrangler.toml
npx wrangler d1 migrations apply quota_db --local
npx wrangler d1 migrations apply quota_db --remote
openssl rand -hex 32 | wrangler secret put AES_GCM_KEY
npx wrangler dev   # GET /api/health → healthy at localhost:8787
npx wrangler publish  # deploys to workers.dev + applies D1 binding + cron trigger
```

### Option 3: Dashboard UI deploy (1 min paste)
1. Cloudflare dashboard → Workers & Pages → Create a Worker → "quota-watcher"
2. Paste `worker.ts` into the editor
3. Settings → Variables → Add `AES_GCM_KEY` secret (paste your hex key)
4. Settings → Triggers → Cron → `*/10 * * * *`

## Architecture

```
quota-watcher Worker
├── /api/health          → health check
├── /api/providers       → list connected providers
├── /api/providers/connect → encrypt + store API key
├── cron: */10 * * * *   → poll OpenAI + Anthropic (in development)
```


