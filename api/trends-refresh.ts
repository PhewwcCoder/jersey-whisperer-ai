// SerpApi Google Trends → trend_signals upsert
// Safe to call with no SERPAPI_KEY: returns ok:false so the UI stays on cached snapshots.
// TODO: wire a Vercel Cron or Supabase pg_cron for scheduled refresh (twice-weekly on free tier).

// node-fetch shadows the global fetch to avoid the Windows libuv assertion crash
// (Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 76)
// that Node.js native fetch (undici) triggers during serverless function teardown on Windows.
import nodeFetch from "node-fetch";
const fetch = nodeFetch as unknown as typeof globalThis.fetch;

// Reuse the shared alias matcher (hardcoded team/alias list) for query→team dedup.
import { matchQueryToTeam } from "../src/lib/trend-signals";
// Football-relevance filter for the related-queries DISPLAY boxes (drops cricket/
// other-sport/noise queries). DISPLAY-DATA ONLY — never touches DSS/trend_signals.
import { isFootballRelevant } from "../src/lib/football-filter";

const SERPAPI_BASE = "https://serpapi.com/search.json";

const DEFAULT_TEAMS = ["Argentina", "Brazil", "Portugal", "Real Madrid", "Barcelona", "Bangladesh"];

// geo-agnostic: change geo to serve any market — scalability by design.
// Default geo when the request body omits one. "" would mean worldwide.
const DEFAULT_GEO = "BD";

// Bangla / Banglish secondary keywords from the hardcoded snapshot in trend-signals.ts.
// If a secondary keyword exists the endpoint makes a second SerpApi call and picks the
// higher trendScore01 of the two, giving more signal for teams with strong local-language search.
const TEAM_EXTRA_KEYWORDS: Record<string, string> = {
  Argentina: "আর্জেন্টিনা জার্সি",
  Brazil: "brazil jersey bd",
};

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function arrayMean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function momentumLabel(score: number): "breakout" | "rising" | "stable" {
  if (score >= 0.75) return "breakout";
  if (score >= 0.5) return "rising";
  return "stable";
}

function detectKeywordLanguage(keyword: string): "en" | "bn" | "banglish" {
  if (/[ঀ-৿]/.test(keyword)) return "bn";
  if (/\b(bd|vai|ache)\b/i.test(keyword)) return "banglish";
  return "en";
}

interface TimelineEntry {
  partial_data?: boolean;
  values?: Array<{ extracted_value?: number }>;
}

interface SerpApiShape {
  interest_over_time?: { timeline_data?: TimelineEntry[] };
  error?: string;
}

interface ScoreResult {
  trendScore01: number;
  recentMean: number;
  baselineMean: number;
  momentum: number;
  keyword: string;
  language: "en" | "bn" | "banglish";
}

async function fetchScoreForKeyword(
  keyword: string,
  apiKey: string,
  geo: string,
): Promise<ScoreResult | null> {
  const params = new URLSearchParams({
    engine: "google_trends",
    q: keyword,
    data_type: "TIMESERIES",
    date: "today 12-m",
    geo, // geo-agnostic: selected market drives the momentum window
    hl: "en",
    api_key: apiKey,
  });

  const response = await fetch(`${SERPAPI_BASE}?${params.toString()}`);
  if (!response.ok) {
    // Surface SerpApi's own error text (e.g. "Invalid API key" vs "ran out of searches")
    // so a 401 is diagnosable. Body is the error message only — never contains the key.
    const body = await response.text().catch(() => "");
    console.warn(
      `[trends-refresh] SerpApi HTTP ${response.status} for "${keyword}": ${body.slice(0, 200)}`,
    );
    return null;
  }

  const data = (await response.json()) as SerpApiShape;
  if (data.error) {
    console.warn(`[trends-refresh] SerpApi error for "${keyword}": ${data.error}`);
    return null;
  }

  const timeline = data.interest_over_time?.timeline_data ?? [];
  // Exclude partial_data weeks for cleaner signal (they can be mid-week snapshots)
  const nonPartial = timeline.filter((e) => !e.partial_data);
  const weekly = nonPartial.map((e) => e.values?.[0]?.extracted_value ?? 0);

  if (weekly.length < 4) {
    console.warn(
      `[trends-refresh] Not enough data for "${keyword}" (${weekly.length} non-partial weeks)`,
    );
    return null;
  }

  // recent = mean of the last 4 non-partial weeks
  // baseline = mean of the 8 weeks before those 4 (12 total lookback)
  const recentSlice = weekly.slice(-4);
  const baselineSlice = weekly.slice(-12, -4);
  const recentMean = arrayMean(recentSlice);
  const baselineMean = arrayMean(baselineSlice.length ? baselineSlice : weekly.slice(0, -4));

  const momentum = (recentMean - baselineMean) / (baselineMean + 1e-6);
  const trendScore01 = clamp01(0.5 + 0.5 * Math.tanh(1.5 * momentum));

  return {
    trendScore01,
    recentMean,
    baselineMean,
    momentum,
    keyword,
    language: detectKeywordLanguage(keyword),
  };
}

// ---------------------------------------------------------------------------
// Feature 2: Related Queries — top + rising jersey searches in a market
// ---------------------------------------------------------------------------
interface RelatedEntry {
  query: string;
  value: number;
}

interface RelatedQueriesShape {
  related_queries?: {
    top?: Array<{ query?: string; extracted_value?: number }>;
    rising?: Array<{ query?: string; extracted_value?: number }>;
  };
  error?: string;
}

async function fetchRelatedQueries(
  apiKey: string,
  geo: string,
  date: string,
): Promise<{ top: RelatedEntry[]; rising: RelatedEntry[] }> {
  const params = new URLSearchParams({
    engine: "google_trends",
    q: "jersey",
    data_type: "RELATED_QUERIES",
    date, // recency window: "now 1-d" (past 24h) or "now 7-d" (past 7 days)
    geo, // geo-agnostic: default "BD"; change to serve any market — scalability by design
    hl: "en",
    api_key: apiKey,
  });

  const url = `${SERPAPI_BASE}?${params.toString()}`;
  // Redacted request URL (never log the api_key) — confirms which window was called.
  console.log(`[trends-refresh] RELATED_QUERIES request: ${url.replace(apiKey, "REDACTED")}`);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(
      `[trends-refresh] RELATED_QUERIES HTTP ${response.status} date="${date}": ${body.slice(0, 200)}`,
    );
    return { top: [], rising: [] };
  }

  const data = (await response.json()) as RelatedQueriesShape;
  if (data.error) {
    console.warn(`[trends-refresh] RELATED_QUERIES error date="${date}": ${data.error}`);
    return { top: [], rising: [] };
  }

  const mapEntries = (list?: Array<{ query?: string; extracted_value?: number }>) =>
    (list ?? [])
      .map((e) => ({ query: e.query ?? "", value: e.extracted_value ?? 0 }))
      .filter((e) => e.query)
      .slice(0, 8);

  return {
    top: mapEntries(data.related_queries?.top),
    rising: mapEntries(data.related_queries?.rising),
  };
}

// Weighted recency blend for ONE bucket (top OR rising), merged per query:
//   blended = 0.20 * score_24h + 0.80 * score_7d   (score = extracted_value;
//   a query absent from a window counts as 0 there).
// FALLBACK (low-traffic hours, e.g. early morning): if the 24h window is
// empty/all-zero, use 100% of the 7-day data so the card is NEVER blank.
// Returns usedFallback so the caller can log when the fallback fires.
const WEIGHT_24H = 0.2;
const WEIGHT_7D = 0.8;

function blendByQuery(
  win24: RelatedEntry[],
  win7: RelatedEntry[],
): { entries: RelatedEntry[]; usedFallback: boolean } {
  const has24 = win24.some((e) => e.value > 0);
  if (!has24) {
    // 24h empty → 100% of the 7-day window (the card stays populated).
    return { entries: [...win7].sort((a, b) => b.value - a.value), usedFallback: true };
  }

  // Merge by normalized query string; keep the first-seen display form.
  const merged = new Map<string, { query: string; v24: number; v7: number }>();
  for (const e of win24) {
    merged.set(e.query.trim().toLowerCase(), { query: e.query, v24: e.value, v7: 0 });
  }
  for (const e of win7) {
    const key = e.query.trim().toLowerCase();
    const existing = merged.get(key);
    if (existing) existing.v7 = e.value;
    else merged.set(key, { query: e.query, v24: 0, v7: e.value });
  }

  const entries = [...merged.values()]
    .map((b) => ({ query: b.query, value: Math.round(WEIGHT_24H * b.v24 + WEIGHT_7D * b.v7) }))
    .sort((a, b) => b.value - a.value);
  return { entries, usedFallback: false };
}

// Team-level dedup. Related Queries often returns several variants of the same
// team (e.g. "argentina jersey" #1 and "argentina jersey 2026" #4 both → Argentina).
// Collapse to the single highest-value variant per matched team using the SHARED
// alias matcher (matchQueryToTeam, backed by the hardcoded localTrendSignals list).
// Queries that match no tracked team are kept as-is and flagged "opportunity" —
// stock-this-next discovery candidates (e.g. "spain jersey 2026" when Spain isn't
// tracked). Sorted by value desc. Used for *byTeam lists; the raw lists are untouched.
interface DedupedQuery {
  query: string;
  value: number;
  team: string | null;
  status: "matched" | "opportunity";
}

function dedupeByTeam(list: RelatedEntry[]): DedupedQuery[] {
  const bestByTeam = new Map<string, DedupedQuery>();
  const opportunities: DedupedQuery[] = [];

  for (const entry of list) {
    const team = matchQueryToTeam(entry.query);
    if (!team) {
      // No known team → keep as-is; discovery / "stock this next" candidate.
      opportunities.push({
        query: entry.query,
        value: entry.value,
        team: null,
        status: "opportunity",
      });
      continue;
    }
    const existing = bestByTeam.get(team);
    // Keep only the highest-value variant per team (max extracted_value).
    if (!existing || entry.value > existing.value) {
      bestByTeam.set(team, { query: entry.query, value: entry.value, team, status: "matched" });
    }
  }

  return [...bestByTeam.values(), ...opportunities].sort((a, b) => b.value - a.value);
}

async function deleteMarketRows(supabaseUrl: string, apiKey: string, query: string): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/market_discovery?${query}`, {
    method: "DELETE",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase market DELETE failed (${response.status}): ${text}`);
  }
}

async function insertMarketRows(
  supabaseUrl: string,
  apiKey: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return;
  const response = await fetch(`${supabaseUrl}/rest/v1/market_discovery`, {
    method: "POST",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase market INSERT failed (${response.status}): ${text}`);
  }
}

function scoreRising(value: number): number {
  return value / (value + 200); // saturating — bounds breakout values
}

async function deleteSupabaseRows(
  supabaseUrl: string,
  apiKey: string,
  team: string,
  geo: string,
): Promise<void> {
  // Per-geo delete: only clears THIS market's cached row, leaving other geos intact.
  const url =
    `${supabaseUrl}/rest/v1/trend_signals` +
    `?matched_team=eq.${encodeURIComponent(team)}` +
    `&source=eq.serpapi_google_trends&geo=eq.${encodeURIComponent(geo)}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase DELETE failed (${response.status}): ${text}`);
  }
}

async function insertSupabaseRow(
  supabaseUrl: string,
  apiKey: string,
  row: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/trend_signals`, {
    method: "POST",
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase INSERT failed (${response.status}): ${text}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export type RefreshEntry = {
  team: string;
  keyword: string;
  trendScore: number;
  momentumLabel: string;
  explanation: string;
  ok: boolean;
  error?: string;
};

export type RelatedQueriesResult = {
  top: RelatedEntry[];
  rising: RelatedEntry[];
  topByTeam: DedupedQuery[];
  risingByTeam: DedupedQuery[];
  window: string;
  fallback: { top: boolean; rising: boolean };
};

// Core trends refresh — callable directly from the seed script without an HTTP server.
export async function runTrendsRefresh(params: {
  serpApiKey: string;
  supabaseUrl: string;
  supabaseKey: string;
  geo: string;
  teams: string[];
}): Promise<{ refreshed: RefreshEntry[]; relatedQueries: RelatedQueriesResult }> {
  const { serpApiKey, supabaseUrl, supabaseKey, geo: selectedGeo, teams } = params;

  const refreshed: RefreshEntry[] = [];

  for (const team of teams) {
    try {
      const primaryKeyword = `${team.toLowerCase()} jersey`;
      const extraKeyword = TEAM_EXTRA_KEYWORDS[team];

      const scorePromises: Promise<ScoreResult | null>[] = [
        fetchScoreForKeyword(primaryKeyword, serpApiKey, selectedGeo),
      ];
      if (extraKeyword) {
        scorePromises.push(fetchScoreForKeyword(extraKeyword, serpApiKey, selectedGeo));
      }

      const settled = await Promise.allSettled(scorePromises);
      const scores = settled
        .filter((r): r is PromiseFulfilledResult<ScoreResult | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((s): s is ScoreResult => s !== null);

      if (!scores.length) {
        refreshed.push({
          team,
          keyword: primaryKeyword,
          trendScore: 0,
          momentumLabel: "stable",
          explanation: "No usable data returned by SerpApi.",
          ok: false,
          error: "No usable timeline data",
        });
        continue;
      }

      const best = scores.reduce((a, b) => (b.trendScore01 > a.trendScore01 ? b : a));
      const label = momentumLabel(best.trendScore01);
      const pct = Math.round(best.momentum * 100);
      const sign = pct >= 0 ? "+" : "";
      const geoLabel = selectedGeo || "worldwide";
      const lowBaseline = best.baselineMean < 1 || Math.abs(pct) > 1000;
      const explanation = lowBaseline
        ? `Breakout (low baseline) · recent avg ${Math.round(best.recentMean)}/100 ` +
          `(SerpApi TIMESERIES geo=${geoLabel})`
        : `Interest ${sign}${pct}% vs 8-wk baseline · ` +
          `recent avg ${Math.round(best.recentMean)}/100 (SerpApi TIMESERIES geo=${geoLabel})`;

      await deleteSupabaseRows(supabaseUrl, supabaseKey, team, selectedGeo);
      await insertSupabaseRow(supabaseUrl, supabaseKey, {
        keyword: best.keyword,
        geo: selectedGeo,
        channel: "web",
        language: best.language,
        momentum: label,
        growth_weight: best.trendScore01,
        matched_team: team,
        matched_player: null,
        explanation,
        source: "serpapi_google_trends",
        fetched_at: new Date().toISOString(),
      });

      refreshed.push({
        team,
        keyword: best.keyword,
        trendScore: best.trendScore01,
        momentumLabel: label,
        explanation,
        ok: true,
      });
      console.log(
        `[trends-refresh] ${team}: score=${best.trendScore01.toFixed(3)} (${label}) — "${best.keyword}"`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[trends-refresh] Failed for "${team}":`, message);
      refreshed.push({
        team,
        keyword: `${team.toLowerCase()} jersey`,
        trendScore: 0,
        momentumLabel: "stable",
        explanation: "",
        ok: false,
        error: message,
      });
    }
  }

  const relatedQueries: RelatedQueriesResult = {
    top: [],
    rising: [],
    topByTeam: [],
    risingByTeam: [],
    window: "20% last 24h + 80% last 7 days",
    fallback: { top: false, rising: false },
  };
  try {
    const fetchedAt = new Date().toISOString();
    let win24: { top: RelatedEntry[]; rising: RelatedEntry[] } = { top: [], rising: [] };
    try {
      win24 = await fetchRelatedQueries(serpApiKey, selectedGeo, "now 1-d");
    } catch (error) {
      console.error("[trends-refresh] RELATED_QUERIES 24h call failed:", error);
    }
    let win7: { top: RelatedEntry[]; rising: RelatedEntry[] } = { top: [], rising: [] };
    try {
      win7 = await fetchRelatedQueries(serpApiKey, selectedGeo, "now 7-d");
    } catch (error) {
      console.error("[trends-refresh] RELATED_QUERIES 7d call failed:", error);
    }

    const topBlend = blendByQuery(win24.top, win7.top);
    const risingBlend = blendByQuery(win24.rising, win7.rising);
    relatedQueries.fallback = { top: topBlend.usedFallback, rising: risingBlend.usedFallback };

    let aiCalls = 0;
    const filterFootball = async (entries: RelatedEntry[]): Promise<RelatedEntry[]> => {
      const kept: RelatedEntry[] = [];
      for (const entry of entries) {
        try {
          const verdict = await isFootballRelevant(entry.query);
          if (verdict.usedAI) aiCalls += 1;
          if (verdict.relevant) kept.push(entry);
        } catch (error) {
          console.error(`[football-filter] classify failed for "${entry.query}":`, error);
          kept.push(entry);
        }
      }
      return kept;
    };

    const totalToClassify = topBlend.entries.length + risingBlend.entries.length;
    const top = await filterFootball(topBlend.entries);
    const rising = await filterFootball(risingBlend.entries);
    console.log(
      `[football-filter] AI classified ${aiCalls} of ${totalToClassify} queries ` +
        `(kept top ${top.length}/${topBlend.entries.length}, rising ${rising.length}/${risingBlend.entries.length})`,
    );

    if (top.length || rising.length) {
      const topByTeam = dedupeByTeam(top);
      const risingByTeam = dedupeByTeam(rising);
      await deleteMarketRows(
        supabaseUrl,
        supabaseKey,
        `kind=in.(related_top,related_rising)&geo=eq.${encodeURIComponent(selectedGeo)}`,
      );
      const rows: Record<string, unknown>[] = [
        ...top.map((e) => ({
          kind: "related_top",
          team: matchQueryToTeam(e.query) ?? null,
          label: e.query,
          score: clamp01(e.value / 100),
          raw_value: e.value,
          geo: selectedGeo,
          source: "serpapi_google_trends",
          fetched_at: fetchedAt,
        })),
        ...rising.map((e) => ({
          kind: "related_rising",
          team: matchQueryToTeam(e.query) ?? null,
          label: e.query,
          score: scoreRising(e.value),
          raw_value: e.value,
          geo: selectedGeo,
          source: "serpapi_google_trends",
          fetched_at: fetchedAt,
        })),
      ];
      await insertMarketRows(supabaseUrl, supabaseKey, rows);
      relatedQueries.top = top;
      relatedQueries.rising = rising;
      relatedQueries.topByTeam = topByTeam;
      relatedQueries.risingByTeam = risingByTeam;
      console.log(
        `[trends-refresh] RELATED_QUERIES geo=${selectedGeo} (blended 20/80): ` +
          `top ${top.length}→${topByTeam.length}, rising ${rising.length}→${risingByTeam.length}`,
      );
    }
  } catch (error) {
    console.error("[trends-refresh] RELATED_QUERIES stage failed:", error);
  }

  return { refreshed, relatedQueries };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    // DEMO_MODE: skip all SerpApi and news calls; return immediately so the client
    // keeps rendering the cached Supabase data that was seeded before the demo.
    if (process.env.DEMO_MODE === "true") {
      console.log("[trends-refresh] DEMO_MODE — skipping live API calls");
      return jsonResponse({ ok: true, demo: true });
    }

    const serpApiKey = process.env.SERPAPI_KEY;
    // Diagnostic: presence + length + a SAFE fingerprint (first4…last4 only, never the
    // full value). Compare the fingerprint to your known-good key (0a07…2088): if it
    // differs, `vercel dev` is overriding .env.local with a stale cloud env var.
    {
      const k = process.env.SERPAPI_KEY || "";
      const fp = k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "(too short)";
      console.log("[serpapi] key present:", !!k, "length:", k.length, "fingerprint:", fp);
    }
    if (!serpApiKey) {
      // Not a hard error — the app falls back to cached hardcoded snapshots.
      return jsonResponse({
        ok: false,
        error: "SERPAPI_KEY not configured — cached hardcoded snapshots remain active.",
      });
    }

    // Server-side names first (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — bypass RLS for
    // the DELETE+INSERT writes), falling back to the VITE_-prefixed names for local dev.
    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
    const supabaseKey = (
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
    )?.trim();
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ ok: false, error: "Supabase not configured." });
    }

    let teams: string[] = DEFAULT_TEAMS;
    let selectedGeo = DEFAULT_GEO;
    try {
      const body = (await request.json()) as { teams?: string[]; geo?: string };
      if (Array.isArray(body.teams) && body.teams.length) teams = body.teams;
      if (typeof body.geo === "string") selectedGeo = body.geo.trim();
    } catch {
      // No body or invalid JSON — use defaults
    }

    const { refreshed, relatedQueries } = await runTrendsRefresh({
      serpApiKey,
      supabaseUrl,
      supabaseKey,
      geo: selectedGeo,
      teams,
    });

    // ── news refresh (non-blocking) ──────────────────────────────────────────
    // API-Football transfers/fixtures. Separate try/catch so it can't block others.
    try {
      const { refreshNewsEvents } = await import("./news-refresh");
      await refreshNewsEvents();
    } catch (e) {
      console.error("news-refresh failed (non-blocking):", e);
    }

    // ── Google AI Mode football news → Gemini parse (non-blocking, own guard) ──
    // Own try/catch + internal 20h cache so one "Refresh trends" click updates
    // trends + transfers + news, and any one failing never blocks the others.
    try {
      const { refreshFootballNews } = await import("./football-news-refresh");
      await refreshFootballNews();
    } catch (e) {
      console.error("football-news-refresh failed (non-blocking):", e);
    }

    return jsonResponse({
      ok: true,
      refreshed,
      relatedQueries,
    });
  },
};
