// api/classify-jerseys.ts — classify Live-Market-Signals candidate queries into
// stockable football jerseys, for the "AI Stock Picks" box (Box 3) on the forecast page.
// Server-side only. Primary: DeepSeek (DEEPSEEK_API_KEY, model from DEEPSEEK_MODEL env,
// default deepseek-chat). Then OpenRouter if configured (OPENROUTER_MODEL, default
// openai/gpt-oss-120b:free). Fallback: Gemini gemini-2.5-flash. Final fallback:
// deterministic rule filter in the client.
//
// Caching is two-tier: a warm in-memory Map (L1, fast within one running instance)
// backed by a durable Supabase table `jersey_classifications` (L2, survives restarts).
// Each real LLM batch is UPSERTed to L2 so the June-11 seed is still served on June-12.
//
// DEMO_MODE=true: serve the most-recent day's rows from `jersey_classifications` with
// ZERO outbound LLM/API calls (returns ok:true, source:'cache'). Only if that table is
// genuinely empty do we return ok:false so the client uses the rule filter (and the
// badge then truthfully reads "rule filter", not "AI-verified").

// node-fetch shadows the global fetch to avoid the Windows libuv assertion crash
// (Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 76)
// that Node.js native fetch (undici) triggers during serverless function teardown on Windows.
import _nodeFetch from "node-fetch";
const fetch = _nodeFetch as unknown as typeof globalThis.fetch;

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL_DEFAULT = "deepseek-chat";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL_DEFAULT = "openai/gpt-oss-120b:free";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export interface JerseyClassification {
  query: string;
  isJersey: boolean;
  team: string | null;
  kind: "national" | "club" | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Small per-query-per-day cache. Key = `${YYYY-MM-DD}|${normalized query}`. Module-level
// Map so repeated page loads within a warm instance never re-hit the AI for the same
// terms; cold starts re-classify (one batched call, not one per render).
const classifyCache = new Map<string, JerseyClassification>();

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(query: string): string {
  return `${dayKey()}|${query.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Durable cache (Supabase `jersey_classifications`). Raw REST — consistent with
// the other api/ files. Every helper fails safe: a DB error just means we fall
// through to the LLM (live) or to the rule filter (DEMO_MODE).
// ---------------------------------------------------------------------------
type SupabaseEnv = { url: string; key: string };

function supabaseEnv(): SupabaseEnv | null {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

function rowToClassification(row: Record<string, unknown>): JerseyClassification | null {
  const query = typeof row.query === "string" ? row.query : null;
  if (!query) return null;
  const kind = row.kind === "national" || row.kind === "club" ? row.kind : null;
  return {
    query,
    isJersey: row.is_jersey === true,
    team: typeof row.team === "string" && row.team.trim() ? row.team.trim() : null,
    kind,
  };
}

// Read TODAY's cached verdicts for a specific set of queries (L2 lookup). Fetches the
// day's rows then filters in code — avoids fragile PostgREST `in.(...)` URL encoding.
async function fetchCachedForDay(
  sb: SupabaseEnv,
  day: string,
  queries: string[],
): Promise<JerseyClassification[]> {
  try {
    const res = await fetch(
      `${sb.url}/rest/v1/jersey_classifications?day=eq.${day}&select=query,is_jersey,team,kind`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Record<string, unknown>[];
    const want = new Set(queries.map((q) => q.trim().toLowerCase()));
    const out: JerseyClassification[] = [];
    for (const row of rows) {
      const c = rowToClassification(row);
      if (c && want.has(c.query.trim().toLowerCase())) out.push(c);
    }
    return out;
  } catch (err) {
    console.warn("[classify-jerseys] L2 cache read failed (proceeding):", err);
    return [];
  }
}

// DEMO_MODE read: the most-recent day's verdicts, filtered to the requested queries
// (so Box 3 shows only currently-relevant picks). Two GETs: newest day, then its rows.
async function fetchLatestDay(sb: SupabaseEnv, queries: string[]): Promise<JerseyClassification[]> {
  try {
    const dayRes = await fetch(
      `${sb.url}/rest/v1/jersey_classifications?select=day&order=day.desc&limit=1`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!dayRes.ok) return [];
    const dayRows = (await dayRes.json()) as Array<{ day?: string }>;
    const latest = dayRows[0]?.day;
    if (!latest) return [];
    const res = await fetch(
      `${sb.url}/rest/v1/jersey_classifications?day=eq.${latest}&select=query,is_jersey,team,kind`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Record<string, unknown>[];
    const want = queries.length ? new Set(queries.map((q) => q.trim().toLowerCase())) : null;
    const out: JerseyClassification[] = [];
    for (const row of rows) {
      const c = rowToClassification(row);
      if (!c) continue;
      if (want && !want.has(c.query.trim().toLowerCase())) continue;
      out.push(c);
    }
    return out;
  } catch (err) {
    console.warn("[classify-jerseys] DEMO cache read failed:", err);
    return [];
  }
}

// Persist a batch of fresh verdicts (on_conflict query,day). trend_score is written
// only when a score map is supplied (the seed passes the 20/80 blended score).
async function upsertClassifications(
  sb: SupabaseEnv,
  classifications: JerseyClassification[],
  day: string,
  scoreByQuery?: Map<string, number>,
): Promise<void> {
  if (!classifications.length) return;
  const rows = classifications.map((c) => ({
    query: c.query,
    is_jersey: c.isJersey,
    team: c.team,
    kind: c.kind,
    trend_score: scoreByQuery?.get(c.query.trim().toLowerCase()) ?? null,
    day,
  }));
  try {
    const res = await fetch(`${sb.url}/rest/v1/jersey_classifications?on_conflict=query,day`, {
      method: "POST",
      headers: {
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[classify-jerseys] L2 upsert failed (${res.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("[classify-jerseys] L2 upsert error (non-fatal):", err);
  }
}

function deepseekFallbackReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  return http ? `deepseek_http_${http[1]}` : "deepseek_parse_failed";
}

function openRouterFallbackReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  return http ? `openrouter_http_${http[1]}` : "openrouter_parse_failed";
}

function geminiFallbackReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  return http ? `gemini_http_${http[1]}` : "gemini_parse_failed";
}

// Shared POST-with-retry for both providers. Handles 429/503 transients; respects the
// Retry-After header when OpenRouter sends it on 429 (rate-limit). Throws on non-transient
// error or exhausted retries so the caller can fall through to the next provider.
async function postWithRetry(label: string, url: string, init: RequestInit): Promise<Response> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    const transient = res.status === 503 || res.status === 429;
    if (transient && attempt < MAX_RETRIES) {
      const retryAfterSec = res.headers.get("retry-after");
      const delayMs = retryAfterSec
        ? Math.min(parseInt(retryAfterSec, 10) * 1000, 30000)
        : 1000 * 2 ** attempt;
      console.warn(
        `[classify-jerseys] ${label} ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`,
      );
      await sleep(delayMs);
      continue;
    }
    throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

interface ChatUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface GeminiUpstream {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

function buildPrompt(queries: string[]): string {
  return [
    "You classify search queries for a football (soccer) jersey shop. For EACH query decide",
    "whether it names a SPECIFIC, stockable national-team or club football jersey.",
    "",
    "isJersey=true ONLY when a concrete national team or club can be identified, e.g.",
    '"argentina jersey", "psg jersey", "portugal 2026 away", "inter miami messi jersey".',
    "",
    "DOMAIN KNOWLEDGE — Bangladesh football:",
    "  BAFUFE (Bangladesh Amateur Football Union Federation) is the Bangladeshi national",
    '  football federation. Any query mentioning "bafufe" refers to a Bangladesh national',
    '  team jersey → team="Bangladesh", kind="national".',
    "",
    "isJersey=false for everything else, in particular:",
    '- shop / store / "near me" / buy / price / cheap / online / delivery / order queries',
    "  (these are purchase-LOCATION intent, not a product),",
    '- informational queries: jersey number, size chart, meanings, "capital of new jersey",',
    '  population, "how to", "what is", wiki,',
    '- competitor shop names (e.g. "jersey freak", "jersey champs") and generic non-team',
    '  terms with no club/country ("football jersey", "jersey design"),',
    '- clothing / fashion apparel brands that print jersey-style tees but are NOT football',
    '  team kits (e.g. "fabrilife", "aarong", "le reve", "richman", "ecstasy").',
    "",
    'team = the resolved national team or club name (or null). kind = "national" | "club" | null.',
    "When isJersey=false, team and kind MUST be null.",
    "",
    "Examples:",
    '  "jersey shop near me" -> {"query":"jersey shop near me","isJersey":false,"team":null,"kind":null}',
    '  "ronaldo jersey number" -> {"query":"ronaldo jersey number","isJersey":false,"team":null,"kind":null}',
    '  "bafufe jersey" -> {"query":"bafufe jersey","isJersey":true,"team":"Bangladesh","kind":"national"}',
    '  "argentina jersey 2026" -> {"query":"argentina jersey 2026","isJersey":true,"team":"Argentina","kind":"national"}',
    '  "psg jersey" -> {"query":"psg jersey","isJersey":true,"team":"Paris Saint-Germain","kind":"club"}',
    "",
    'Return ONLY JSON: {"classifications":[{"query":string,"isJersey":boolean,"team":string|null,"kind":"national"|"club"|null}]}.',
    "Echo each query back verbatim. Queries:",
    JSON.stringify(queries),
  ].join("\n");
}

function parseClassifications(content: string): JerseyClassification[] {
  const parsed = JSON.parse(content) as { classifications?: unknown };
  const rawList = Array.isArray(parsed.classifications)
    ? parsed.classifications
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  const out: JerseyClassification[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const query = typeof r.query === "string" ? r.query : null;
    if (!query) continue;
    const kind = r.kind === "national" || r.kind === "club" ? r.kind : null;
    out.push({
      query,
      isJersey: r.isJersey === true,
      team: typeof r.team === "string" && r.team.trim() ? r.team.trim() : null,
      kind,
    });
  }
  return out;
}

// PRIMARY classifier — DeepSeek (OpenAI-compatible chat/completions, model from
// DEEPSEEK_MODEL env, default deepseek-chat). response_format json_object forces valid
// JSON. Throws on error/empty so the caller falls back to Gemini.
async function classifyWithDeepSeek(
  queries: string[],
  deepseekKey: string,
): Promise<JerseyClassification[]> {
  const model = process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL_DEFAULT;
  const res = await postWithRetry("DeepSeek", DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildPrompt(queries) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });
  const payload = (await res.json()) as ChatUpstream;
  if (payload.error) throw new Error(`DeepSeek error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("DeepSeek empty content");
  return parseClassifications(content);
}

async function classifyWithOpenRouter(
  queries: string[],
  openRouterKey: string,
): Promise<JerseyClassification[]> {
  const model = process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_MODEL_DEFAULT;
  const res = await postWithRetry("OpenRouter", OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildPrompt(queries) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });
  const payload = (await res.json()) as ChatUpstream;
  if (payload.error) throw new Error(`OpenRouter error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("OpenRouter empty content");
  return parseClassifications(content);
}

async function classifyWithGemini(
  queries: string[],
  geminiKey: string,
): Promise<JerseyClassification[]> {
  const res = await postWithRetry("Gemini", `${GEMINI_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(queries) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });
  const payload = (await res.json()) as GeminiUpstream;
  if (payload.error) throw new Error(`Gemini error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  if (!content) throw new Error("Gemini empty content");
  return parseClassifications(content);
}

// Resolve each just-classified query to a verdict (LLM reply or not-a-jersey fallback),
// populate the warm L1 map and the running result, and RETURN the resolved batch so the
// caller can persist it to the durable L2 cache.
function resolveAndCache(
  toClassify: string[],
  fresh: JerseyClassification[],
  out: JerseyClassification[],
): JerseyClassification[] {
  const byQuery = new Map(fresh.map((c) => [c.query.trim().toLowerCase(), c]));
  const resolved: JerseyClassification[] = [];
  for (const query of toClassify) {
    const fallback: JerseyClassification = { query, isJersey: false, team: null, kind: null };
    const c = byQuery.get(query.trim().toLowerCase()) ?? fallback;
    classifyCache.set(cacheKey(query), c);
    out.push(c);
    resolved.push(c);
  }
  return resolved;
}

export interface ClassifyResult {
  ok: boolean;
  reason?: string;
  source?: "live" | "cache";
  classifications: JerseyClassification[] | null;
}

// Never throws. Returns ok:false (+ reason) on any failure so the client falls back.
// opts.scoreByQuery (used by the seed) writes trend_score alongside each verdict.
export async function classifyJerseys(
  queries: string[],
  opts?: { scoreByQuery?: Map<string, number> },
): Promise<ClassifyResult> {
  const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  const sb = supabaseEnv();
  const day = dayKey();

  // DEMO_MODE: serve the most-recent day's seeded verdicts from Supabase — ZERO
  // outbound LLM/API calls. Only an empty table forces the rule filter.
  if (process.env.DEMO_MODE === "true") {
    if (sb) {
      const cached = await fetchLatestDay(sb, unique);
      if (cached.length) {
        console.log(
          `[classify-jerseys] DEMO_MODE — served ${cached.length} cached verdicts (no AI calls)`,
        );
        return { ok: true, source: "cache", classifications: cached };
      }
    }
    console.warn(
      "[classify-jerseys] DEMO_MODE — cache empty · reason=demo_cache_empty → rule filter",
    );
    return { ok: false, reason: "demo_cache_empty", classifications: null };
  }

  if (!unique.length) return { ok: true, classifications: [] };

  const result: JerseyClassification[] = [];
  let toClassify: string[] = [];

  // L1 — warm in-memory (fast path within one running instance).
  for (const query of unique) {
    const hit = classifyCache.get(cacheKey(query));
    if (hit) result.push(hit);
    else toClassify.push(query);
  }

  // L2 — durable Supabase cache (today's rows). Survives restarts.
  if (toClassify.length && sb) {
    const cached = await fetchCachedForDay(sb, day, toClassify);
    if (cached.length) {
      const got = new Set(cached.map((c) => c.query.trim().toLowerCase()));
      for (const c of cached) {
        classifyCache.set(cacheKey(c.query), c);
        result.push(c);
      }
      toClassify = toClassify.filter((q) => !got.has(q.trim().toLowerCase()));
    }
  }

  if (!toClassify.length) return { ok: true, source: "cache", classifications: result };

  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  // L3 — LLM. DeepSeek primary → (OpenRouter if configured) → Gemini fallback.
  // Persist fresh verdicts to L2.
  if (deepseekKey) {
    try {
      const fresh = await classifyWithDeepSeek(toClassify, deepseekKey);
      const resolved = resolveAndCache(toClassify, fresh, result);
      if (sb) await upsertClassifications(sb, resolved, day, opts?.scoreByQuery);
      const model = process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL_DEFAULT;
      console.log(`[classify-jerseys] classified ${toClassify.length} via DeepSeek (${model})`);
      return { ok: true, source: "live", classifications: result };
    } catch (err) {
      const reason = deepseekFallbackReason(err);
      console.warn(`[classify-jerseys] DeepSeek failed · reason=${reason} → next provider`);
    }
  }

  if (openRouterKey) {
    try {
      const fresh = await classifyWithOpenRouter(toClassify, openRouterKey);
      const resolved = resolveAndCache(toClassify, fresh, result);
      if (sb) await upsertClassifications(sb, resolved, day, opts?.scoreByQuery);
      const model = process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_MODEL_DEFAULT;
      console.log(`[classify-jerseys] classified ${toClassify.length} via OpenRouter (${model})`);
      return { ok: true, source: "live", classifications: result };
    } catch (err) {
      const reason = openRouterFallbackReason(err);
      // 404/400 usually means the model name is wrong; log it so the user can pick a
      // current free model and set OPENROUTER_MODEL in .env.local.
      console.warn(`[classify-jerseys] OpenRouter failed · reason=${reason} → trying Gemini`);
    }
  }

  // Try Gemini.
  if (geminiKey) {
    try {
      const fresh = await classifyWithGemini(toClassify, geminiKey);
      const resolved = resolveAndCache(toClassify, fresh, result);
      if (sb) await upsertClassifications(sb, resolved, day, opts?.scoreByQuery);
      console.log(
        `[classify-jerseys] classified ${toClassify.length} via Gemini (gemini-2.5-flash)`,
      );
      return { ok: true, source: "live", classifications: result };
    } catch (err) {
      const reason = geminiFallbackReason(err);
      console.warn(`[classify-jerseys] Gemini also failed · reason=${reason} → rule filter`);
      return { ok: false, reason, classifications: null };
    }
  }

  // No keys at all (DeepSeek is the primary provider).
  const reason = "deepseek_key_missing";
  console.warn(`[classify-jerseys] no AI keys configured · reason=${reason} → rule filter`);
  return { ok: false, reason, classifications: null };
}

export const handler = {
  async fetch(request: Request): Promise<Response> {
    // Boot-time key presence — booleans only, never values. If a key shows false after
    // adding it to .env.local, restart `npx vercel dev` to pick up the new value.
    console.log(
      `[classify-jerseys] startup — OPENROUTER:${!!process.env.OPENROUTER_API_KEY}` +
        ` GEMINI:${!!process.env.GEMINI_API_KEY}` +
        ` DEEPSEEK:${!!process.env.DEEPSEEK_API_KEY}`,
    );
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }
    try {
      const body = (await request.json().catch(() => ({}))) as { queries?: unknown };
      const queries = Array.isArray(body.queries)
        ? body.queries.filter((q): q is string => typeof q === "string")
        : [];
      const result = await classifyJerseys(queries);
      return jsonResponse(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const http = /HTTP (\d{3})/.exec(msg);
      const reason = http ? `deepseek_http_${http[1]}` : "handler_error";
      console.error("[classify-jerseys] handler error · reason=", reason);
      return jsonResponse({ ok: false, reason, classifications: null }, 200);
    }
  },
};

export default handler;
