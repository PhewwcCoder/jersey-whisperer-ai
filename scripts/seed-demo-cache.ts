/**
 * JerseyBecho Demo Cache Seeder
 *
 * Runs the REAL pipeline (SerpApi trends + OpenRouter/Gemini news parse) and writes
 * results to Supabase so the June 12 demo has warm, accurate cached data.
 *
 * IMPORTANT: Every seeded row comes from a real API response. Nothing is fabricated,
 * hardcoded, or invented. Run this on June 11 (or the morning of June 12) with all
 * keys present in .env.local, then set DEMO_MODE=true before starting vercel dev.
 *
 * Run:  npx tsx scripts/seed-demo-cache.ts
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 1. Load .env.local and inject into process.env BEFORE any dynamic imports
//    (dynamic imports read process.env at module-eval time, not import-parse time).
// ---------------------------------------------------------------------------
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const name = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[name] = value;
    }
  } catch (err) {
    console.error("Could not read .env.local:", (err as Error).message);
  }
  return out;
}

function present(v: string | undefined): string {
  return v ? `present (${v.slice(0, 6)}...)` : "MISSING";
}

function hr() {
  console.log("─".repeat(68));
}

async function countSupabaseRows(
  supabaseUrl: string,
  supabaseKey: string,
  table: string,
  filter = "",
  idCol = "id",
): Promise<number> {
  try {
    const url = `${supabaseUrl}/rest/v1/${table}?select=${idCol}${filter ? `&${filter}` : ""}`;
    const res = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    });
    const range = res.headers.get("content-range") ?? "";
    const match = /\/(\d+)$/.exec(range);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return -1;
  }
}

// Read the just-written related-query rows from market_discovery and build the SAME
// Box-3 candidate list the client builds (dedupe by query text, keep the max score).
// This guarantees the classifications we seed cover exactly the queries the client
// will request at demo time. Returns [] on any error.
async function fetchStockCandidates(
  supabaseUrl: string,
  supabaseKey: string,
  geo: string,
): Promise<{ query: string; score: number }[]> {
  try {
    const url =
      `${supabaseUrl}/rest/v1/market_discovery` +
      `?geo=eq.${encodeURIComponent(geo)}&kind=in.(related_top,related_rising)&select=label,score`;
    const res = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ label?: string; score?: number }>;
    const byQuery = new Map<string, { query: string; score: number }>();
    for (const r of rows) {
      const query = (r.label ?? "").trim();
      if (!query) continue;
      const key = query.toLowerCase();
      const score = typeof r.score === "number" ? r.score : 0;
      const existing = byQuery.get(key);
      if (!existing || score > existing.score) byQuery.set(key, { query, score });
    }
    return [...byQuery.values()];
  } catch {
    return [];
  }
}

async function main() {
  hr();
  console.log("  JerseyBecho Demo Cache Seeder");
  hr();
  console.log("Loading .env.local ...");

  const env = loadEnv();
  // Inject into process.env so the imported modules (which read process.env) see them.
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  // Seeding MUST run the real pipeline even if .env.local already has DEMO_MODE=true.
  // Force it off for this process so trends/news/classify make live calls and write
  // fresh rows. (Set DEMO_MODE=true again only when you start `vercel dev` for the demo.)
  if (process.env.DEMO_MODE === "true") {
    console.log("  (DEMO_MODE found in .env.local — disabling it for this seed run)");
    delete process.env.DEMO_MODE;
  }

  const serpKey = process.env.SERPAPI_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
  const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  )?.trim();

  console.log(`  SERPAPI_KEY         : ${present(serpKey)}`);
  console.log(`  OPENROUTER_API_KEY  : ${present(openRouterKey)}`);
  console.log(`  GEMINI_API_KEY      : ${present(geminiKey)}`);
  console.log(`  SUPABASE_URL        : ${present(supabaseUrl)}`);
  console.log(`  SUPABASE_KEY        : ${present(supabaseKey)}`);
  console.log();

  const missingKeys: string[] = [];
  if (!serpKey) missingKeys.push("SERPAPI_KEY");
  if (!openRouterKey && !geminiKey) missingKeys.push("OPENROUTER_API_KEY or GEMINI_API_KEY");
  if (!supabaseUrl) missingKeys.push("SUPABASE_URL / VITE_SUPABASE_URL");
  if (!supabaseKey) missingKeys.push("SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY");
  if (missingKeys.length) {
    console.error("Cannot seed — missing keys:");
    for (const k of missingKeys) console.error(`  ✗ ${k}`);
    process.exit(1);
  }

  // Dynamic imports so process.env is fully set before modules evaluate.
  const { runTrendsRefresh } = await import("../api/trends-refresh.js");
  const { refreshFootballNews } = await import("../api/football-news-refresh.js");
  const { classifyJerseys } = await import("../api/classify-jerseys.js");

  const DEFAULT_TEAMS = [
    "Argentina",
    "Brazil",
    "Portugal",
    "Real Madrid",
    "Barcelona",
    "Bangladesh",
  ];

  // ---------------------------------------------------------------------------
  // Step 1 — Trends (trend_signals + market_discovery)
  // ---------------------------------------------------------------------------
  hr();
  console.log(`[1/3] Refreshing trend_signals + market_discovery`);
  console.log(`      geo=BD, ${DEFAULT_TEAMS.length} teams`);
  console.log();

  const { refreshed } = await runTrendsRefresh({
    serpApiKey: serpKey!,
    supabaseUrl: supabaseUrl!,
    supabaseKey: supabaseKey!,
    geo: "BD",
    teams: DEFAULT_TEAMS,
  });

  let trendOk = 0;
  for (const r of refreshed) {
    if (r.ok) {
      trendOk += 1;
      console.log(
        `  ✓ ${r.team.padEnd(14)} score=${r.trendScore.toFixed(3)} (${r.momentumLabel.padEnd(8)}) "${r.keyword}"`,
      );
    } else {
      console.warn(`  ✗ ${r.team.padEnd(14)} ${r.error ?? "failed"}`);
    }
  }

  const trendCount = await countSupabaseRows(supabaseUrl!, supabaseKey!, "trend_signals");
  const marketCount = await countSupabaseRows(supabaseUrl!, supabaseKey!, "market_discovery");
  console.log();
  console.log(`  trend_signals rows written this run : ${trendOk}`);
  console.log(
    `  trend_signals total in DB           : ${trendCount >= 0 ? trendCount : "query failed"}`,
  );
  console.log(
    `  market_discovery total in DB        : ${marketCount >= 0 ? marketCount : "query failed"}`,
  );

  // ---------------------------------------------------------------------------
  // Step 2 — AI Stock Picks (jersey_classifications): classify the Box-3 candidates
  // with the REAL OpenRouter→Gemini routing and persist verdicts for the demo.
  // ---------------------------------------------------------------------------
  console.log();
  hr();
  console.log("[2/3] Classifying Box-3 candidates → jersey_classifications");
  console.log();

  const candidates = await fetchStockCandidates(supabaseUrl!, supabaseKey!, "BD");
  if (!candidates.length) {
    console.warn("  ✗ no related-query candidates in market_discovery — skipping classify step");
  } else {
    const scoreByQuery = new Map(candidates.map((c) => [c.query.trim().toLowerCase(), c.score]));
    console.log(`  classifying ${candidates.length} candidate queries ...`);
    // Real classifier: OpenRouter primary → Gemini fallback. classifyJerseys persists
    // each fresh verdict to jersey_classifications (with trend_score) itself.
    const cls = await classifyJerseys(
      candidates.map((c) => c.query),
      { scoreByQuery },
    );
    if (cls.ok && cls.classifications) {
      const kept = cls.classifications.filter((c) => c.isJersey);
      const rejected = cls.classifications.length - kept.length;
      console.log(
        `  ✓ kept ${kept.length} jerseys, rejected ${rejected} (source=${cls.source ?? "live"})`,
      );
      for (const c of kept) {
        console.log(`     • ${c.query}  →  ${c.team ?? "?"} (${c.kind ?? "?"})`);
      }
    } else {
      // Classifier genuinely failed — log and skip. Do NOT invent rows.
      console.warn(`  ✗ classify failed · reason=${cls.reason ?? "unknown"} — no rows seeded`);
    }
  }

  const classCount = await countSupabaseRows(
    supabaseUrl!,
    supabaseKey!,
    "jersey_classifications",
    "",
    "query",
  );
  console.log(
    `  jersey_classifications total in DB    : ${classCount >= 0 ? classCount : "query failed"}`,
  );

  // ---------------------------------------------------------------------------
  // Step 3 — Football news (force-bypass the 20h cache for seeding)
  // ---------------------------------------------------------------------------
  console.log();
  hr();
  console.log("[3/3] Refreshing football news (force-bypassing 20h cache)");
  console.log();

  const newsResult = await refreshFootballNews({ forceRefresh: true });

  const newsCount = await countSupabaseRows(
    supabaseUrl!,
    supabaseKey!,
    "news_events",
    "source=eq.google_ai_mode",
  );
  console.log();
  console.log(`  news_events written this run          : ${newsResult.written}`);
  console.log(
    `  news_events (google_ai_mode) in DB    : ${newsCount >= 0 ? newsCount : "query failed"}`,
  );

  // ---------------------------------------------------------------------------
  // Done
  // ---------------------------------------------------------------------------
  console.log();
  hr();
  console.log("  Seed complete — demo cache is warm.");
  console.log();
  console.log("  Next steps:");
  console.log("    1. Add DEMO_MODE=true to .env.local");
  console.log("    2. Restart: npx vercel dev");
  console.log("    3. Refresh buttons no-op; all data served from the rows above.");
  hr();
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
