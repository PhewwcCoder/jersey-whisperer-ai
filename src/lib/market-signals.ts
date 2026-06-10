// Market-discovery fallback snapshots (Feature 1: Interest By Region, Feature 2: Related Queries).
// These mirror the shape SerpApi Google Trends returns so the UI renders identically whether the
// data is live (Supabase `market_discovery` table) or this demo fallback. Never removed — they are
// the graceful fallback when SERPAPI_KEY is unset, a call fails, or the DB has no rows.

import { TIER_LISTS } from "./news-score";

export interface RelatedQuerySignal {
  query: string;
  value: number; // SerpApi extracted_value
  score: number; // S_top = value/100  |  S_rising = value/(value+200)
  bucket: "top" | "rising";
}

export interface MarketDiscovery {
  related: RelatedQuerySignal[];
  fetchedAt?: string; // ISO timestamp when the data is live; undefined for fallback
  live: boolean;
}

// The market the hardcoded snapshots represent. Cache misses for THIS geo fall back to the
// demo snapshot (so the showcase market is never blank); misses for other geos show an
// explicit "no data yet" empty-state instead.
export const DEMO_GEO = "BD";

export const GEO_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "BD", name: "Bangladesh" },
  { code: "IN", name: "India" },
  { code: "TH", name: "Thailand" },
  { code: "TR", name: "Turkey" },
  { code: "US", name: "United States" },
];

export function geoName(code: string): string {
  return GEO_OPTIONS.find((option) => option.code === code)?.name ?? code;
}

// Empty (non-demo) market discovery — used when a non-demo geo has no cached rows yet.
export const emptyMarketDiscovery: MarketDiscovery = { live: false, related: [] };

// Related queries for q="jersey", geo=BD.
const FALLBACK_RELATED_TOP: Array<{ query: string; value: number }> = [
  { query: "argentina jersey", value: 100 },
  { query: "brazil jersey", value: 78 },
  { query: "football jersey", value: 64 },
  { query: "messi jersey", value: 52 },
  { query: "real madrid jersey", value: 41 },
];

const FALLBACK_RELATED_RISING: Array<{ query: string; value: number }> = [
  { query: "argentina jersey 2026", value: 4500 }, // Breakout
  { query: "inter miami messi jersey", value: 250 },
  { query: "al nassr ronaldo jersey", value: 180 },
  { query: "mbappe real madrid jersey", value: 130 },
  { query: "portugal jersey 2026", value: 90 },
];

// Saturating score so breakout values don't dominate linearly.
export function scoreRising(value: number): number {
  return value / (value + 200);
}

export function scoreTop(value: number): number {
  return Math.max(0, Math.min(1, value / 100));
}

export const fallbackMarketDiscovery: MarketDiscovery = {
  live: false,
  related: [
    ...FALLBACK_RELATED_TOP.map((entry) => ({
      query: entry.query,
      value: entry.value,
      score: scoreTop(entry.value),
      bucket: "top" as const,
    })),
    ...FALLBACK_RELATED_RISING.map((entry) => ({
      query: entry.query,
      value: entry.value,
      score: scoreRising(entry.value),
      bucket: "rising" as const,
    })),
  ],
};

// Human-readable "x minutes ago" used by the provenance line and freshness pill.
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function isFresh(iso: string | undefined, withinMs = 60 * 60 * 1000): boolean {
  if (!iso) return false;
  const then = new Date(iso).getTime();
  return Number.isFinite(then) && Date.now() - then < withinMs;
}

// ── Jersey-relevance filter for the Top/Rising related-query panel ─────────────
// Deterministic + synchronous (NEVER calls AI) so it can't misfire live on stage.
// DISPLAY-ONLY — it filters what the "Top Searches / Rising / What to Stock Next"
// boxes show and NEVER touches DSS, S_trend, or trend_signals. A query is KEPT only
// when BOTH hold: (1) it has a positive football/jersey signal, and (2) it is not on
// the junk/competitor/locality blocklist. Extend the arrays below to tune the boxes.

// (1) Positive signal — generic jersey/football vocabulary (substring match).
export const JERSEY_SIGNAL_TERMS: string[] = [
  "jersey", "kit", "home", "away", "third", "retro", "world cup", "wc", "football", "2025", "2026",
];

// (2a) Junk / non-football nouns — drop if the query contains any of these.
export const QUERY_JUNK_TERMS: string[] = [
  "poison", "frog", "capital", "new jersey", "population", "weather",
];

// (2b) Competitor shop names — drop if the query contains any of these.
export const COMPETITOR_NAMES: string[] = [
  "jersey freak", "jersey champs",
];

// (2b-ii) Clothing / fashion brands that print "jersey"-style apparel but are NOT
// football team jerseys (purchase intent is fashion, not a stockable team kit). Drop
// outright even when the query contains "jersey".
export const CLOTHING_BRANDS: string[] = [
  "fabrilife", "aarong", "le reve", "richman", "ecstasy", "easy fashion", "yellow clothing",
];

// (2c) Dhaka-area / locality tokens — combined with a standalone "bd" marker these flag
// a competitor-shop / locality query (e.g. "jersey freak bd khilgaon"). Extend freely.
export const DHAKA_AREAS: string[] = [
  "khilgaon", "mirpur", "dhanmondi", "mohakhali", "uttara", "bashundhara", "gulshan", "banani", "mohammadpur",
];

// (2d) Shop/commerce + info intent — drop even when the query contains "jersey", because
// these are purchase-location or informational searches, NOT a stockable product (e.g.
// "jersey shop near me", "ronaldo jersey number", "what is the capital of new jersey").
// Extend freely as new junk patterns surface.
export const QUERY_INTENT_JUNK: string[] = [
  // shop / commerce intent
  "shop", "store", "near me", "buy", "price", "cheap", "online", "delivery", "order",
  "where to buy", "for sale", "outlet", "showroom",
  // info / non-product intent
  "number", "meaning", "size chart", "how to", "what is", "capital", "population", "wiki",
];

// Flattened tier-list signal tokens (full names + each >3-char token of every tracked
// team / player / national team) so "messi", "argentina", "real madrid" count as a
// positive signal. Reuses the existing TIER_LISTS — no duplication.
const TIER_SIGNAL_TOKENS: string[] = (() => {
  const out = new Set<string>();
  for (const category of ["players", "clubs", "national"] as const) {
    for (const tier of ["most", "mid", "low"] as const) {
      for (const name of TIER_LISTS[category][tier]) {
        const lower = name.toLowerCase();
        out.add(lower);
        for (const token of lower.split(/\s+/)) if (token.length > 3) out.add(token);
      }
    }
  }
  return [...out];
})();

// KEEP a related query only when it has a positive football/jersey signal AND is not
// blocklisted. Pure + synchronous → safe to call at render time, never hits the network.
export function isJerseyRelevantQuery(query: string): boolean {
  const q = (query ?? "").toLowerCase().trim();
  if (!q) return false;

  // (2) Blocklist first — a junk/competitor/locality/intent hit drops the query outright.
  if (QUERY_JUNK_TERMS.some((term) => q.includes(term))) return false;
  if (COMPETITOR_NAMES.some((term) => q.includes(term))) return false;
  if (CLOTHING_BRANDS.some((term) => q.includes(term))) return false;
  // shop/commerce + info intent drops the query even if it mentions "jersey".
  if (QUERY_INTENT_JUNK.some((term) => q.includes(term))) return false;
  // standalone "bd" marker + any Dhaka-area token ⇒ competitor-shop locality query.
  if (/\bbd\b/.test(q) && DHAKA_AREAS.some((area) => q.includes(area))) return false;

  // (1) Positive signal — generic jersey vocab OR a tracked team/player/national name.
  return (
    JERSEY_SIGNAL_TERMS.some((term) => q.includes(term)) ||
    TIER_SIGNAL_TOKENS.some((token) => q.includes(token))
  );
}

// Cross-check a related query against current inventory text. Used to flag
// "opportunity — not stocked yet" for queries buyers search but we don't carry.
export function queryMatchesInventory(query: string, inventoryText: string[]): boolean {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 3 && token !== "jersey" && token !== "2026");
  if (!tokens.length) return false;
  return inventoryText.some((text) => tokens.some((token) => text.includes(token)));
}
