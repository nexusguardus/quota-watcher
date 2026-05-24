# Quota Watcher

> Authoritative polling of LLM provider management APIs — no proxy, no SDK.

* Cloudflare Worker + D1 + Cron Trigger
* AES-256-GCM credential storage (zero npm crypto deps)
* Multi-tenant: organizations → users → providers → snapshots → alerts
* Alerting: Slack / Discord / email at configurable threshold %
* Target: OpenAI (polling `/v1/usage`), then Anthropic, Groq, ElevenLabs

---

## Setup (laptop / non-Termux)

```bash
git clone <your-repo-url>
cd quota-watcher-repo
npm install -g wrangler
wrangler login
wrangler d1 create quota_db       # copy the database_id into wrangler.toml
wrangler d1 migrations apply quota_db --local
```

## File Layout

```
├── worker.ts               — Core worker (fetch + scheduled)
├── wrangler.toml            — D1 binding, cron config
├── tsconfig.json            — TypeScript targets CF Worker
├── migrations/
│   ├── 0001_initial.sql     — Schema: orgs, providers, snapshots, alerts, pricing
│   └── 0002_seed_model_pricing.sql  — 16 baseline prices (OpenAI + Anthropic + Groq)
└── package.json
```

## Dev

```bash
wrangler dev                  # local worker piped through wrangler
wrangler tail                 # real-time log streaming
```
