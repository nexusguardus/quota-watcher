// ═══════════════════════════════════════════════════════════════════════
//  QUOTA WATCHER — Cloudflare Worker + D1 + Cron (authoritative polling)
// ═══════════════════════════════════════════════════════════════════════

const PROVIDER_TYPES = ["openai", "anthropic", "groq", "aws", "elevenlabs"];

// ─── Crypto Helpers (AES-256-GCM, Worker built-in Web Crypto API) ────────

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getCryptoKey(secretHex) {
  const rawKey = hexToBytes(secretHex);
  return await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptCredential(plaintext, secretHex) {
  const key = await getCryptoKey(secretHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToHex(new Uint8Array(encrypted)), iv: bytesToHex(iv) };
}

async function decryptCredential(ciphertextHex, ivHex, secretHex) {
  const key = await getCryptoKey(secretHex);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) }, key, hexToBytes(ciphertextHex)
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Model Resolution ───────────────────────────────────────────────────

function resolveModelId(modelId) {
  if (modelId.startsWith("ft:") || modelId.startsWith("ft-")) {
    const base = modelId.replace(/^ft[:_]-/, "").split(":")[0];
    return base || modelId;
  }
  return modelId;
}

// ─── OpenAI Usage Polling ───────────────────────────────────────────────

async function pollOpenAI(apiKey, dateISO, pricingMap) {
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/usage?date=" + dateISO, {
    headers: { Authorization: "Bearer " + apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("OpenAI " + res.status + ": " + body.slice(0, 200));
  }

  const body = await res.json();
  let totalRequests = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let estimatedCost = 0;

  for (const chunk of body.data) {
    totalRequests += chunk.n_requests;
    totalInput += chunk.n_context_tokens_total;
    totalOutput += chunk.n_generated_tokens_total;

    const resolved = resolveModelId(chunk.model || chunk.snapshot_id || "");
    const price = pricingMap.get(resolved) || pricingMap.get(chunk.model || chunk.snapshot_id || "");
    const m = 1_000_000;
    if (price) {
      estimatedCost += (chunk.n_context_tokens_total / m * price.in) + (chunk.n_generated_tokens_total / m * price.out);
    } else {
      console.warn("unmapped_model: openai/" + (chunk.model || chunk.snapshot_id || "unknown"));
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

async function loadPricingMap(env) {
  const cacheKey = "pricing_map_cache";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return JSON.parse(cached);

  const { results } = await env.DB.prepare(
    "SELECT model_id, input_cost_per_1m, output_cost_per_1m FROM model_pricing"
  ).all();

  const map = {};
  for (const row of results) map[row.model_id] = { in: row.input_cost_per_1m, out: row.output_cost_per_1m };

  await env.CACHE.put(cacheKey, JSON.stringify(map), { expirationTtl: 86400 });
  return map;
}

// ─── Alert Logic ────────────────────────────────────────────────────────

async function checkAlerts(env, checks) {
  for (const c of checks) {
    const cap = c.budget_cap;
    if (!cap || cap <= 0) continue;
    const usedPct = (c.derived_cost / cap) * 100;
    if (usedPct >= c.alert_threshold_pct && usedPct < 100) {
      const alertType = "budget_" + Math.round(c.alert_threshold_pct);
      try {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO alert_events (id, org_id, provider_id, alert_type, alert_date) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), c.org_id, c.provider_id, alertType, c.snapshotDate).run();
        console.log("[ALERT] " + c.provider_id + " " + usedPct.toFixed(1) + "% " + alertType);
      } catch (e) {
        console.error("[ALERT ERROR]", e.message);
      }
    }
  }
}

// ─── Cron Handler ───────────────────────────────────────────────────────

async function handleScheduled(env) {
  const pricingMap = await loadPricingMap(env);
  const today = new Date().toISOString().slice(0, 10);

  const { results: providers } = await env.DB.prepare(
    "SELECT id, org_id, provider_name, encrypted_credentials, iv, budget_cap, alert_threshold_percent FROM providers WHERE enabled = 1"
  ).all();

  const snapshots = [];
  const alertChecks = [];

  for (const p of providers) {
    try {
      const apiKey = await decryptCredential(p.encrypted_credentials, p.iv, env.AES_GCM_KEY);
      if (!apiKey || apiKey.length < 10) { console.warn("[" + p.id + "] short key"); continue; }

      let pollResult;
      if (p.provider_name === "openai") {
        pollResult = await pollOpenAI(apiKey, today, pricingMap);
      } else {
        console.log("[" + p.id + "] " + p.provider_name + " not implemented yet");
        continue;
      }

      snapshots.push({
        id: crypto.randomUUID(),
        org_id: p.org_id,
        provider_id: p.id,
        snapshot_date: today,
        raw_payload: pollResult.rawPayload,
        derived_cost: Math.round(pollResult.estimatedCost * 100) / 100,
      });

      if (p.budget_cap && p.budget_cap > 0) {
        alertChecks.push({
          org_id: p.org_id,
          provider_id: p.id,
          budget_cap: p.budget_cap,
          alert_threshold_percent: p.alert_threshold_percent,
          derived_cost: pollResult.estimatedCost,
          snapshotDate: today,
        });
      }

      await env.DB.prepare("UPDATE providers SET last_polled_at = ? WHERE id = ?")
        .bind(Math.floor(Date.now() / 1000), p.id).run();
    } catch (err) {
      console.error("[" + p.id + "] poll error:", (err && err.message || err).slice(0, 300));
      await env.DB.prepare("UPDATE providers SET last_poll_error = ? WHERE id = ?")
        .bind((err && err.message || String(err)).slice(0, 500), p.id).run();
    }
  }

  // Bulk UPSERT snapshots
  if (snapshots.length > 0) {
    const rows = snapshots.map(s =>
      "(" + [
        "'" + s.id + "'",
        "'" + s.org_id + "'",
        "'" + s.provider_id + "'",
        "'" + s.snapshot_date + "'",
        "'" + s.raw_payload.replace(/'/g, "''") + "'",
        s.derived_cost
      ].join(",") + ")"
    ).join(",");
    await env.DB.prepare(
      "INSERT INTO usage_snapshots (id, org_id, provider_id, snapshot_date, raw_payload, derived_cost) VALUES " + rows +
      " ON CONFLICT(provider_id, snapshot_date) DO UPDATE SET raw_payload = excluded.raw_payload, derived_cost = excluded.derived_cost"
    ).run();
  }

  if (alertChecks.length > 0) await checkAlerts(env, alertChecks);
  console.log("Cron done: " + providers.length + " checked, " + snapshots.length + " snapshots");
}

// ─── HTTP Routes ─────────────────────────────────────────────────────────

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "healthy", ts: Math.floor(Date.now() / 1000) }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401 });

  if (url.pathname === "/api/providers/connect" && request.method === "POST") {
    try {
      const body = await request.json();
      const { provider_name, api_key, name, budget_cap, alert_threshold_percent } = body;
      if (!provider_name || !api_key) return new Response(JSON.stringify({ error: "provider_name and api_key required" }), { status: 400 });

      const { ciphertext, iv } = await encryptCredential(api_key, env.AES_GCM_KEY);
      const orgId = "demo-org";
      const userId = "demo-user";

      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO providers (id, org_id, user_id, provider_name, encrypted_credentials, iv, name, budget_cap, alert_threshold_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, orgId, userId, provider_name, ciphertext, iv, name || (provider_name + " key"), budget_cap || 0, alert_threshold_percent || 80).run();

      return new Response(JSON.stringify({ id, status: "connected" }), { headers: { "Content-Type": "application/json" }, status: 201 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  if (url.pathname === "/api/providers" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, provider_name, name, budget_cap, alert_threshold_percent, last_polled_at, last_poll_error, enabled, created_at FROM providers"
    ).all();
    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  return new Response("Quota Watcher — see /api/health", { status: 404 });
}

// ─── Entry Point ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) { return handleFetch(request, env); },
  async scheduled(event, env, ctx) { ctx.waitUntil(handleScheduled(env)); },
};
