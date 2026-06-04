// SerpApi Google Trends → trend_signals upsert
// Safe to call with no SERPAPI_KEY: returns ok:false so the UI stays on cached snapshots.
// TODO: wire a Vercel Cron or Supabase pg_cron for scheduled refresh (twice-weekly on free tier).

// Reuse the shared alias matcher (hardcoded team/alias list) for query→team dedup.
import { matchQueryToTeam } from "../src/lib/trend-signals";

const SERPAPI_BASE = "https://serpapi.com/search.json";

const DEFAULT_TEAMS = [
  "Argentina",
  "Brazil",
  "Portugal",
  "Real Madrid",
  "Barcelona",
  "Bangladesh",
];

// Teams we build a worldwide "Interest By Region" map for (market discovery — Feature 1).
const GEO_MAP_TEAMS = ["Argentina", "Brazil", "Portugal", "Real Madrid", "Barcelona"];

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
    console.warn(`[trends-refresh] SerpApi HTTP ${response.status} for "${keyword}"`);
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
// Feature 1: Interest By Region (GEO_MAP) — which countries search "<team> jersey"
// ---------------------------------------------------------------------------
interface RegionEntry {
  location: string;
  value: number;
}

interface GeoRegionRow {
  location?: string;
  geo?: string;
  value?: number | string;
  extracted_value?: number;
}

interface GeoMapShape {
  interest_by_region?: GeoRegionRow[] | Record<string, GeoRegionRow[]>;
  compared_breakdown_by_region?: GeoRegionRow[];
  error?: string;
}

// Coerce SerpApi's region value to a 0..100 number. extracted_value is the clean field,
// but some responses only carry `value` (sometimes a "53" string), so accept both.
function regionValue(row: GeoRegionRow): number {
  if (typeof row.extracted_value === "number") return row.extracted_value;
  const raw = typeof row.value === "string" ? parseInt(row.value, 10) : row.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

async function fetchGeoMap(
  team: string,
  apiKey: string,
  geo: string,
): Promise<RegionEntry[]> {
  // data_type=GEO_MAP_0 → "Interest By Region" for a SINGLE query (what we want).
  // GEO_MAP (no suffix) is "Compared Breakdown By Region" and requires MULTIPLE
  // comma-separated queries — a single query 400s with
  // "Please change the `data_type` to one that supports a single query."
  // Omit `region` so SerpApi applies its default granularity: COUNTRY worldwide
  // when no geo is sent, sub-regions when a geo is given. Omit geo entirely for
  // worldwide. geo-agnostic: change geo to serve any market — scalability by design.
  const params = new URLSearchParams({
    engine: "google_trends",
    q: `${team} jersey`,
    data_type: "GEO_MAP_0",
    hl: "en",
    api_key: apiKey,
  });
  if (geo) params.set("geo", geo); // omitted entirely → worldwide country breakdown

  const url = `${SERPAPI_BASE}?${params.toString()}`;
  // Redacted request URL (never log the api_key) — for diagnosing 400s.
  console.log(`[trends-refresh] GEO_MAP_0 request: ${url.replace(apiKey, "REDACTED")}`);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(
      `[trends-refresh] GEO_MAP_0 HTTP ${response.status} for "${team}" geo="${geo}": ` +
        body.slice(0, 300),
    );
    return [];
  }

  const data = (await response.json()) as GeoMapShape;
  if (data.error) {
    console.warn(`[trends-refresh] GEO_MAP_0 error for "${team}" geo="${geo}": ${data.error}`);
    return [];
  }

  // interest_by_region can be an array OR an object keyed by single-query name; also fall
  // back to compared_breakdown_by_region. Normalize to a flat array.
  const byRegion = data.interest_by_region;
  let rows: GeoRegionRow[] = [];
  if (Array.isArray(byRegion)) {
    rows = byRegion;
  } else if (byRegion && typeof byRegion === "object") {
    rows = Object.values(byRegion).flat();
  } else if (Array.isArray(data.compared_breakdown_by_region)) {
    rows = data.compared_breakdown_by_region;
  }

  // One-shot raw-shape log to confirm the live response structure (debugging geoMarkets:[]).
  console.log(
    `[trends-refresh] GEO_MAP "${team}" geo="${geo}": top-keys=${Object.keys(data).join(",")} ` +
      `rows=${rows.length} sample=${JSON.stringify(rows[0] ?? null)}`,
  );

  return rows
    .map((r) => ({ location: r.location ?? "", value: regionValue(r) }))
    .filter((r) => r.location && r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
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
    console.warn(`[trends-refresh] RELATED_QUERIES HTTP ${response.status} date="${date}"`);
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
//   blended = 0.60 * score_24h + 0.40 * score_7d   (score = extracted_value;
//   a query absent from a window counts as 0 there).
// FALLBACK (low-traffic hours, e.g. early morning): if the 24h window is
// empty/all-zero, use 100% of the 7-day data so the card is NEVER blank.
// Returns usedFallback so the caller can log when the fallback fires.
const WEIGHT_24H = 0.6;
const WEIGHT_7D = 0.4;

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
      opportunities.push({ query: entry.query, value: entry.value, team: null, status: "opportunity" });
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

async function deleteMarketRows(
  supabaseUrl: string,
  apiKey: string,
  query: string,
): Promise<void> {
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

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    const serpApiKey = process.env.SERPAPI_KEY;
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
    // geo-agnostic: one selected geo drives every SerpApi call this refresh (TIMESERIES,
    // GEO_MAP, RELATED_QUERIES) and tags every cached row — scalability by design.
    let selectedGeo = DEFAULT_GEO;
    try {
      const body = (await request.json()) as { teams?: string[]; geo?: string };
      if (Array.isArray(body.teams) && body.teams.length) {
        teams = body.teams;
      }
      // Accept "" explicitly (= Worldwide); only undefined keeps the default.
      if (typeof body.geo === "string") {
        selectedGeo = body.geo.trim();
      }
    } catch {
      // No body or invalid JSON — use defaults
    }

    type RefreshEntry = {
      team: string;
      keyword: string;
      trendScore: number;
      momentumLabel: string;
      explanation: string;
      ok: boolean;
      error?: string;
    };

    const refreshed: RefreshEntry[] = [];

    for (const team of teams) {
      // Per-team try/catch — one failure must not abort the rest (quota safety)
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
          .filter(
            (r): r is PromiseFulfilledResult<ScoreResult | null> => r.status === "fulfilled",
          )
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

        // Pick the keyword variant with the strongest momentum signal
        const best = scores.reduce((a, b) => (b.trendScore01 > a.trendScore01 ? b : a));
        const label = momentumLabel(best.trendScore01);
        const pct = Math.round(best.momentum * 100);
        const sign = pct >= 0 ? "+" : "";
        const geoLabel = selectedGeo || "worldwide";
        // Cap the displayed % when the baseline is ~0 (e.g. Brazil "+4625000000%"): a tiny
        // baseline makes the ratio explode. trendScore math is unchanged (tanh-bounded) —
        // this only fixes the human-readable string.
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

    // -----------------------------------------------------------------------
    // Feature 1: Interest By Region (GEO_MAP), scoped to the selected geo.
    // geo="" → worldwide countries (expansion story); a country code → its sub-regions.
    // Stored in market_discovery (kind='geo_map'), SEPARATE from per-product DSS,
    // tagged with the selected geo so the cache is per-market.
    // -----------------------------------------------------------------------
    const geoMarkets: Array<{ team: string; location: string; value: number }> = [];
    try {
      const fetchedAt = new Date().toISOString();
      for (const team of GEO_MAP_TEAMS) {
        // Per-team try/catch — one quota failure must not abort the rest.
        try {
          const regions = await fetchGeoMap(team, serpApiKey, selectedGeo);
          if (!regions.length) continue;

          await deleteMarketRows(
            supabaseUrl,
            supabaseKey,
            `kind=eq.geo_map&team=eq.${encodeURIComponent(team)}&geo=eq.${encodeURIComponent(selectedGeo)}`,
          );
          await insertMarketRows(
            supabaseUrl,
            supabaseKey,
            regions.map((r) => ({
              kind: "geo_map",
              team,
              label: r.location,
              score: clamp01(r.value / 100),
              raw_value: r.value,
              geo: selectedGeo,
              source: "serpapi_google_trends",
              fetched_at: fetchedAt,
            })),
          );
          regions.forEach((r) => geoMarkets.push({ team, location: r.location, value: r.value }));
          console.log(`[trends-refresh] GEO_MAP ${team}: ${regions.length} markets`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`[trends-refresh] GEO_MAP failed for "${team}":`, message);
        }
      }
    } catch (error) {
      console.error("[trends-refresh] GEO_MAP stage failed:", error);
    }

    // -----------------------------------------------------------------------
    // Feature 2: Related Queries — WEIGHTED RECENCY BLEND.
    // TWO RELATED_QUERIES calls per refresh (2/refresh, well under the 100/mo cap):
    //   call A date="now 1-d" (past 24h), call B date="now 7-d" (past 7 days).
    // blended = 0.60*score_24h + 0.40*score_7d per query; 24h empty → 100% 7-day.
    // -----------------------------------------------------------------------
    const relatedQueries: {
      top: RelatedEntry[];
      rising: RelatedEntry[];
      topByTeam: DedupedQuery[];
      risingByTeam: DedupedQuery[];
      window: string;
      fallback: { top: boolean; rising: boolean };
    } = {
      top: [],
      rising: [],
      topByTeam: [],
      risingByTeam: [],
      window: "60% last 24h + 40% last 7 days",
      fallback: { top: false, rising: false },
    };
    try {
      const fetchedAt = new Date().toISOString();

      // Each window call in its own try/catch — one quota failure must not abort the other.
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

      // Blend each bucket; fall back to 100% 7-day when the 24h window is empty.
      const topBlend = blendByQuery(win24.top, win7.top);
      const risingBlend = blendByQuery(win24.rising, win7.rising);
      relatedQueries.fallback = { top: topBlend.usedFallback, rising: risingBlend.usedFallback };
      if (topBlend.usedFallback) {
        console.log(
          `[trends-refresh] RELATED_QUERIES top: 24h empty → FALLBACK to 100% 7-day ` +
            `(${win7.top.length} queries) so the card is never blank`,
        );
      }
      if (risingBlend.usedFallback) {
        console.log(
          `[trends-refresh] RELATED_QUERIES rising: 24h empty → FALLBACK to 100% 7-day ` +
            `(${win7.rising.length} queries) so the card is never blank`,
        );
      }

      const top = topBlend.entries;
      const rising = risingBlend.entries;

      if (top.length || rising.length) {
        // Team-level dedup of the BLENDED lists (keep highest blended per team);
        // unmatched queries stay as "opportunity". Raw blended lists kept intact.
        const topByTeam = dedupeByTeam(top);
        const risingByTeam = dedupeByTeam(rising);

        await deleteMarketRows(
          supabaseUrl,
          supabaseKey,
          `kind=in.(related_top,related_rising)&geo=eq.${encodeURIComponent(selectedGeo)}`,
        );
        // Store EVERY blended query (no data loss) tagged with its matched team
        // (or null) so the cache carries the mapping for dedup on read.
        const rows: Record<string, unknown>[] = [
          ...top.map((e) => ({
            kind: "related_top",
            team: matchQueryToTeam(e.query) ?? null,
            label: e.query,
            score: clamp01(e.value / 100), // S_top = blended / 100
            raw_value: e.value,
            geo: selectedGeo,
            source: "serpapi_google_trends",
            fetched_at: fetchedAt,
          })),
          ...rising.map((e) => ({
            kind: "related_rising",
            team: matchQueryToTeam(e.query) ?? null,
            label: e.query,
            score: scoreRising(e.value), // saturating, on the blended value
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
          `[trends-refresh] RELATED_QUERIES geo=${selectedGeo} (blended 60/40): ` +
            `top ${top.length}→${topByTeam.length}, rising ${rising.length}→${risingByTeam.length} ` +
            `(team-deduped; fallback top=${topBlend.usedFallback} rising=${risingBlend.usedFallback})`,
        );
      }
    } catch (error) {
      console.error("[trends-refresh] RELATED_QUERIES stage failed:", error);
    }

    // ── news refresh (non-blocking) ──────────────────────────────────────────
    try {
      const { refreshNewsEvents } = await import("./news-refresh");
      await refreshNewsEvents();
    } catch (e) {
      console.error("news-refresh failed (non-blocking):", e);
    }

    return jsonResponse({
      ok: true,
      refreshed,
      geoMarkets,
      relatedQueries,
    });
  },
};
