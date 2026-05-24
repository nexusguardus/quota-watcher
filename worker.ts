// ═══════════════════════════════════════════════════════════════════════
//  QUOTA WATCHER — Cloudflare Worker + D1 + Cron
//  Entry point: fetch (HTTP) + scheduled (background polling)
// ═══════════════════════════════════════════════════════════════════════

interface Env {
  DB: D1Database;
  AES_GCM_KEY: string;
  ENVIRONMENT: string;
  WORKER_SECRET?: string;
}

// ───────────────────────────────────────────────────────────────────────
// TYPES
// ───────────────────────────────────────────────────────────────────────

type ProviderType = "openai" | "anthropic" | "groq" | "aws" | "elevenlabs";

interface ProviderRow {
  id: string;
  org_id: string;
  provider_name: ProviderType;
  encrypted_credentials: string;
  iv: string;
  budget_cap: number | null;
  alert_threshold_percent: number;
  last_polled_at: number | null;
  enabled: number;
}

interface ModelPricingRow {
  model_id: string;
  provider: ProviderType;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
}

interface SnapshotInsert {
  id: string;
  org_id: string;
  provider_id: string;
  snapshot_date: string;
  raw_payload: string;
  derived_cost: number;
}

// ───────────────────────────────────────────────────────────────────────
// CRYPTO HELPERS — AES-256-GCM via Web Crypto API
// ───────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getCryptoKey(secretHex: string): Promise<CryptoKey> {
  const rawKey = hexToBytes(secretHex);
  return crypto.subtle.importKey(
    "raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
}

export async function encryptCredential(plaintext: string, secretHex: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await getCryptoKey(secretHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)
  );
  return { ciphertext: bytesToHex(new Uint8Array(encrypted)), iv: bytesToHex(iv) };
}

export async function decryptCredential(ciphertextHex: string, ivHex: string, secretHex: string): Promise<string> {
  const key = await getCryptoKey(secretHex);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) }, key, hexToBytes(ciphertextHex)
  );
  return new TextDecoder().decode(decrypted);
}

// ───────────────────────────────────────────────────────────────────────
// MODEL RESOLUTION & PRICING
// ───────────────────────────────────────────────────────────────────────

/** Strip fine-tune prefix: "ft:gpt-4o:abc" → "gpt-4o" */
export function resolveModelId(modelId: string): string {
  if (modelId.startsWith("ft:") || modelId.startsWith("ft-")) {
    const base = modelId.replace(/^ft[:_]-/, "").split(":")[0];
    return base ?? modelId;
  }
  return modelId;
}

const pricingCache = new Map<string, ModelPricingRow>();

async function loadPricingCache(env: Env): Promise<void> {
  if (pricingCache.size > 0) return;
  const { results } = await env.DB.prepare(
    "SELECT model_id, provider, input_cost_per_1m, output_cost_per_1m FROM model_pricing"
  ).all<ModelPricingRow>();
  for (const row of results) {
    pricingCache.set(`${row.provider}:${row.model_id}`, row);
  }
}

function getCostsForModel(provider: ProviderType, modelId: string): { inPerM: number; outPerM: number; mapped: boolean } {
  const resolved = resolveModelId(modelId);
  // Try resolved first, then fall back to raw model_id
  const hit = pricingCache.get(`${provider}:${resolved}`) ?? pricingCache.get(`${provider}:${modelId}`);
  if (hit) return { inPerM: hit.input_cost_per_1m, outPerM: hit.output_cost_per_1m, mapped: true };
  return { inPerM: 0, outPerM: 0, mapped: false };
}

// ───────────────────────────────────────────────────────────────────────
// OPENAI POLLING ADAPTER
// ───────────────────────────────────────────────────────────────────────

interface OpenAIUsageChunk {
  n_requests: number;
  n_context_tokens_total: number;
  n_generated_tokens_total: number;
  model: string;           // model_id as returned by /v1/usage (includes ft: prefix for fine-tunes)
}

interface OpenAIUsageResponse {
  data: OpenAIUsageChunk[];
}

/**
 * Polls GET https://api.openai.com/v1/usage?date=YYYY-MM-DD
 * Returns the cumulative snapshot for that date.
 */
async function pollOpenAI(
  apiKey: string,
  dateISO: string
): Promise<{ rawPayload: string; totalRequests: number; totalInputTokens: number; totalOutputTokens: number; estimatedCost: number; pollMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`https://api.openai.com/v1/usage?date=${dateISO}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as OpenAIUsageResponse;
  let totalRequests = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let estimatedCost = 0;

  // ── Load pricing from D1 (seed data covers all active models) ─────────
  const pricingRows = await env.DB.prepare(
    "SELECT model_id, input_cost_per_1m, output_cost_per_1m FROM model_pricing WHERE provider = 'openai'"
  ).all<{ model_id: string; input_cost_per_1m: number; output_cost_per_1m: number }>();
  const pricingMap = new Map<string, { in: number; out: number }>();
  for (const row of pricingRows.results) {
    pricingMap.set(row.model_id, { in: row.input_cost_per_1m, out: row.output_cost_per_1m });
  }

  for (const chunk of body.data) {
    totalRequests += chunk.n_requests;
    totalInput += chunk.n_context_tokens_total;
    totalOutput += chunk.n_generated_tokens_total;

    // Per-model cost using D1 pricing, with fine-tune base-model fallback
    const resolved = resolveModelId(chunk.model);
    const price = pricingMap.get(resolved) ?? pricingMap.get(chunk.model);
    const m = 1_000_000;
    if (price) {
      estimatedCost += (chunk.n_context_tokens_total / m * price.in)
                     + (chunk.n_generated_tokens_total / m * price.out);
    } else {
      console.warn(`unmapped_model: openai/${chunk.model}`);
    }
  }

  return {
    rawPayload: JSON.stringify(body),
    totalRequests,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    estimatedCost,
    pollMs: Date.now() - t0,
  };
}

// ───────────────────────────────────────────────────────────────────────
// ALERT LOGIC
// ───────────────────────────────────────────────────────────────────────

interface AlertCheck {
  providerId: string;
  orgId: string;
  thresholdPct: number;
  derivedCost: number;
  budgetCap: number;
  snapshotDate: string;
}

async function checkAndLogAlerts(env: Env, checks: AlertCheck[]): Promise<void> {
  // Dedup: unique(provider_id, alert_type, alert_date) in D1 handles it.
  // We pass a no-op here and trust the DB constraint to win on race.
  for (const c of checks) {
    const cap = c.budgetCap;
    if (!cap || cap <= 0) continue;

    const usedPct = (c.derivedCost / cap) * 100;
    const thresholdPct = Math.min(c.thresholdPct, 95);

    if (usedPct >= thresholdPct && usedPct < 100) {
      const alertType = `budget_${Math.round(thresholdPct)}`;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO alert_events
          (id, org_id, provider_id, alert_type, alert_date, triggered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        c.orgId,
        c.providerId,
        alertType,
        c.snapshotDate,
        Math.floor(Date.now() / 1000)
      ).run();

      console.log(`[ALERT] provider=${c.providerId} pct=${usedPct.toFixed(1)}% type=${alertType}`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// CRON WORKER — runs every 10 min via Cloudflare Cron Trigger
// ───────────────────────────────────────────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  await loadPricingCache(env);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. Pull all enabled providers
  const { results: providers } = await env.DB.prepare(`
    SELECT id, org_id, provider_name, encrypted_credentials, iv,
           budget_cap, alert_threshold_percent, last_polled_at
    FROM providers WHERE enabled = 1
  `).all<ProviderRow>();

  const snapshotInserts: SnapshotInsert[] = [];
  const alertChecks: AlertCheck[] = [];

  for (const p of providers) {
    try {
      // 2. Decrypt API key
      const apiKey = await decryptCredential(p.encrypted_credentials, p.iv, env.AES_GCM_KEY);
      if (!apiKey || apiKey.length < 10) {
        console.warn(`[${p.id}] short/invalid decrypted key — skipping`);
        continue;
      }

      // 3. Route to the right polling adapter
      let pollResult: { rawPayload: string; totalRequests: number; totalInputTokens: number; totalOutputTokens: number; estimatedCost: number; pollMs: number };
      if (p.provider_name === "openai") {
        pollResult = await pollOpenAI(apiKey, today);
      } else {
        console.log(`[${p.id}] provider ${p.provider_name} not yet implemented — skipping`);
        continue;
      }

      // 4. UPSERT into usage_snapshots
      snapshotInserts.push({
        id: crypto.randomUUID(),
        org_id: p.org_id,
        provider_id: p.id,
        snapshot_date: today,
        rawPayload: pollResult.rawPayload,
        derivedCost: Math.round(pollResult.estimatedCost * 100) / 100,
      });

      // 5. Check alert thresholds
      if (p.budget_cap && p.budget_cap > 0) {
        alertChecks.push({
          providerId: p.id,
          orgId: p.org_id,
          thresholdPct: p.alert_threshold_percent,
          derivedCost: pollResult.estimatedCost,
          budgetCap: p.budget_cap,
          snapshotDate: today,
        });
      }

      // 6. Stamp last_polled_at
      await env.DB.prepare(`UPDATE providers SET last_polled_at = ? WHERE id = ?`)
        .bind(Math.floor(Date.now() / 1000), p.id).run();

    } catch (err: any) {
      console.error(`[${p.id}] poll error:`, err.message?.slice(0, 300));
      await env.DB.prepare(`UPDATE providers SET last_poll_error = ? WHERE id = ?`)
        .bind(err.message?.slice(0, 500), p.id).run();
    }
  }

  // 7. Bulk upsert snapshots (one per enabled provider × today)
  if (snapshotInserts.length > 0) {
    const rows = snapshotInserts.map(s =>
      `('${s.id}','${s.org_id}','${s.provider_id}','${s.snapshot_date}','${s.rawPayload.replace(/'/g,"''")}',${s.derivedCost})`
    ).join(",");

    await env.DB.prepare(`
      INSERT INTO usage_snapshots (id, org_id, provider_id, snapshot_date, raw_payload, derived_cost)
      VALUES ${rows}
      ON CONFLICT(provider_id, snapshot_date) DO UPDATE SET
        raw_payload = excluded.raw_payload,
        derived_cost = excluded.derived_cost
    `).run();
  }

  // 8. Evaluate alerts (deduped by DB unique constraint)
  if (alertChecks.length > 0) {
    await checkAndLogAlerts(env, alertChecks);
  }

  console.log(`Cron complete: ${providers.length} providers checked, ${snapshotInserts.length} snapshots upserted`);
}

// ───────────────────────────────────────────────────────────────────────
// HTTP ROUTES (dashboard API, provider connect, auth stub)
// ───────────────────────────────────────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Health check — no auth needed
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      env: env.ENVIRONMENT,
      ts: Math.floor(Date.now() / 1000),
    }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Auth stub — replace with Clerk JWT verification
  const authHeader = request.headers.get("Authorization");
  const isInternal = request.headers.get("X-Worker-Secret") === env.WORKER_SECRET;

  // ── Connect a new provider ──────────────────────────────────────────
  if (url.pathname === "/api/providers/connect" && request.method === "POST") {
    if (!authHeader) return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401 });
    // TODO: verify Clerk JWT → extract clerk_user_id, org_id
    const body = await request.json() as any;
    const { provider_name, api_key, name, budget_cap, alert_threshold_percent } = body;

    if (!provider_name || !api_key) {
      return new Response(JSON.stringify({ error: "provider_name and api_key required" }), { status: 400 });
    }

    try {
      const { ciphertext, iv } = await encryptCredential(api_key, env.AES_GCM_KEY);
      const orgId = "demo-org"; // TODO: from Clerk JWT
      const userId = "demo-user"; // TODO: from Clerk JWT

      const providerId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO providers
          (id, org_id, user_id, provider_name, encrypted_credentials, iv, name, budget_cap, alert_threshold_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(providerId, orgId, userId, provider_name, ciphertext, iv, name ?? `${provider_name} key`, budget_cap ?? 0, alert_threshold_percent ?? 80).run();

      return new Response(JSON.stringify({ id: providerId, status: "connected" }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ── List providers for an org ───────────────────────────────────────
  if (url.pathname === "/api/providers" && request.method === "GET") {
    if (!authHeader) return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401 });
    // TODO: verify Clerk JWT → org_id
    const orgId = "demo-org"; // stub
    const { results } = await env.DB.prepare(`
      SELECT id, provider_name, name, budget_cap, alert_threshold_percent,
             last_polled_at, last_poll_error, enabled, created_at
      FROM providers WHERE org_id = ?
    `).bind(orgId).all();

    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // ── Today's snapshot ────────────────────────────────────────────────
  if (url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/today") && request.method === "GET") {
    if (!authHeader) return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401 });
    const providerId = url.pathname.split("/")[3];
    const { results } = await env.DB.prepare(`
      SELECT derived_cost, raw_payload, fetched_at, poll_ms
      FROM usage_snapshots
      WHERE provider_id = ? AND snapshot_date = ?
      ORDER BY fetched_at DESC LIMIT 1
    `).bind(providerId, new Date().toISOString().slice(0, 10)).all();

    return new Response(JSON.stringify(results[0] ?? null), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response("Quota Watcher — see /api/health", { status: 404 });
}

// ───────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ───────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
