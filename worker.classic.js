// ===== QUOTA WATCHER — Cloudflare Worker (plain JS) =====

async function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getCryptoKey(secretHex) {
  return crypto.subtle.importKey("raw", hexToBytes(secretHex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptCredential(plaintext, secretHex) {
  const key = await getCryptoKey(secretHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToHex(new Uint8Array(enc)), iv: bytesToHex(iv) };
}

async function decryptCredential(ciphertextHex, ivHex, secretHex) {
  const key = await getCryptoKey(secretHex);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(ivHex) }, key, hexToBytes(ciphertextHex));
  return new TextDecoder().decode(dec);
}

function resolveModelId(id) {
  if (id.startsWith("ft:") || id.startsWith("ft-")) return id.replace(/^ft[:_]-/, "").split(":")[0] || id;
  return id;
}

async function pollOpenAI(apiKey, dateISO, pricingMap) {
  const t0 = Date.now();
  const r = await fetch("https://api.openai.com/v1/usage?date=" + dateISO, {
    headers: { Authorization: "Bearer " + apiKey },
  });
  if (!r.ok) {
    const b = await r.text().catch(() => "");
    throw new Error("OpenAI " + r.status + ": " + b.slice(0, 200));
  }
  const body = await r.json();
  let cost = 0;
  for (const c of body.data) {
    const resolved = resolveModelId(c.model || "");
    const price = pricingMap[resolved] || pricingMap[c.model || ""] || null;
    if (price) {
      const m = 1_000_000;
      cost += (c.n_context_tokens_total / m * price.in) + (c.n_generated_tokens_total / m * price.out);
    } else {
      console.warn("unmapped_model: openai/" + (c.model || "unknown"));
    }
  }
  return { rawPayload: JSON.stringify(body), estimatedCost: Math.round(cost * 100) / 100, pollMs: Date.now() - t0 };
}

async function handleScheduled(env) {
  const rows = await env.DB.prepare("SELECT model_id, input_cost_per_1m, output_cost_per_1m FROM model_pricing").all();
  const pricingMap = {};
  for (const row of rows.results) pricingMap[row.model_id] = { in: row.input_cost_per_1m, out: row.output_cost_per_1m };

  const today = new Date().toISOString().slice(0, 10);
  const { results: providers } = await env.DB.prepare(
    "SELECT id, org_id, provider_name, encrypted_credentials, iv, budget_cap, alert_threshold_percent FROM providers WHERE enabled = 1"
  ).all();

  for (const p of providers) {
    try {
      const apiKey = await decryptCredential(p.encrypted_credentials, p.iv, env.AES_GCM_KEY);
      if (!apiKey || apiKey.length < 10) { console.warn("[" + p.id + "] short key"); continue; }
      if (p.provider_name !== "openai") { console.log("[" + p.id + "] skipping " + p.provider_name); continue; }
      const pr = await pollOpenAI(apiKey, today, pricingMap);
      if (p.budget_cap > 0) {
        const usedPct = (pr.estimatedCost / p.budget_cap) * 100;
        if (usedPct >= p.alert_threshold_percent && usedPct < 100) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO alert_events (id, org_id, provider_id, alert_type, alert_date) VALUES (?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), p.org_id, p.id, "budget_" + Math.round(p.alert_threshold_percent), today).run();
          console.log("[ALERT] " + p.id + " " + usedPct.toFixed(1) + "%");
        }
      }
      await env.DB.prepare(
        "INSERT INTO usage_snapshots (id, org_id, provider_id, snapshot_date, raw_payload, derived_cost) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id, snapshot_date) DO UPDATE SET raw_payload=excluded.raw_payload, derived_cost=excluded.derived_cost"
      ).bind(crypto.randomUUID(), p.org_id, p.id, today, pr.rawPayload, pr.estimatedCost).run();
      await env.DB.prepare("UPDATE providers SET last_polled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), p.id).run();
      console.log("[" + p.id + "] ok: " + pr.estimatedCost + " USD");
    } catch (err) {
      console.error("[" + p.id + "] error:", (err && err.message || String(err)).slice(0, 400));
      await env.DB.prepare("UPDATE providers SET last_poll_error = ? WHERE id = ?").bind((err && err.message || String(err)).slice(0, 500), p.id).run();
    }
  }
}


async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ status: "healthy", now: Math.floor(Date.now() / 1000) }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  const auth = request.headers.get("Authorization");
  if (!auth) return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });
  if (url.pathname === "/api/providers/connect" && request.method === "POST") {
    try {
      const body = await request.json();
      const { provider_name, api_key, name, budget_cap } = body;
      if (!provider_name || !api_key) return new Response(JSON.stringify({ error: "provider_name + api_key required" }), { status: 400 });
      const { ciphertext, iv } = await encryptCredential(api_key, env.AES_GCM_KEY);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO providers (id, org_id, user_id, provider_name, encrypted_credentials, iv, name, budget_cap, alert_threshold_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, "demo-org", "demo-user", provider_name, ciphertext, iv, name || provider_name, budget_cap || 0, 80).run();
      return new Response(JSON.stringify({ id }), { headers: { "Content-Type": "application/json" }, status: 201 });
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
  }
  if (url.pathname === "/api/providers" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, provider_name, name, budget_cap, alert_threshold_percent, last_polled_at, last_poll_error, enabled FROM providers"
    ).all();
    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
  }
  return new Response("Quota Watcher", { status: 404 });
}


addEventListener("fetch", event => {
  event.respondWith(handleFetch(event.request, event.env || {}));
});
addEventListener("scheduled", event => {
  event.waitUntil(handleScheduled(event.env || {}));
});
