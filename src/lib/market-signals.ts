// Market-discovery fallback snapshots (Feature 1: Interest By Region, Feature 2: Related Queries).
// These mirror the shape SerpApi Google Trends returns so the UI renders identically whether the
// data is live (Supabase `market_discovery` table) or this demo fallback. Never removed — they are
// the graceful fallback when SERPAPI_KEY is unset, a call fails, or the DB has no rows.

export interface GeoMarketSignal {
  team: string;
  location: string;
  value: number; // SerpApi extracted_value (0..100)
  score: number; // S_geo = value / 100
}

export interface RelatedQuerySignal {
  query: string;
  value: number; // SerpApi extracted_value
  score: number; // S_top = value/100  |  S_rising = value/(value+200)
  bucket: "top" | "rising";
}

export interface MarketDiscovery {
  geo: GeoMarketSignal[];
  related: RelatedQuerySignal[];
  fetchedAt?: string; // ISO timestamp when the data is live; undefined for fallback
  live: boolean;
}

export const GEO_MAP_TEAMS = ["Argentina", "Brazil", "Portugal", "Real Madrid", "Barcelona"];

// The market the hardcoded snapshots represent. Cache misses for THIS geo fall back to the
// demo snapshot (so the showcase market is never blank); misses for other geos show an
// explicit "no data yet" empty-state instead.
export const DEMO_GEO = "BD";

// Google Trends geo codes offered in the location selector. "" = Worldwide.
// geo-agnostic: add a row here to serve any new market — scalability by design.
export const GEO_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "BD", name: "Bangladesh" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "MY", name: "Malaysia" },
  { code: "IN", name: "India" },
  { code: "", name: "Worldwide" },
];

export function geoName(code: string): string {
  return GEO_OPTIONS.find((option) => option.code === code)?.name ?? (code || "Worldwide");
}

// Empty (non-demo) market discovery — used when a non-demo geo has no cached rows yet.
export const emptyMarketDiscovery: MarketDiscovery = { live: false, geo: [], related: [] };

// Worldwide top markets searching "<team> jersey" (extracted_value 0..100).
const FALLBACK_GEO_RAW: Record<string, Array<{ location: string; value: number }>> = {
  Argentina: [
    { location: "Argentina", value: 100 },
    { location: "Bangladesh", value: 71 },
    { location: "India", value: 39 },
    { location: "Indonesia", value: 28 },
    { location: "Uruguay", value: 22 },
  ],
  Brazil: [
    { location: "Brazil", value: 100 },
    { location: "Bangladesh", value: 55 },
    { location: "India", value: 41 },
    { location: "Nigeria", value: 30 },
    { location: "Indonesia", value: 26 },
  ],
  Portugal: [
    { location: "Portugal", value: 100 },
    { location: "India", value: 34 },
    { location: "Bangladesh", value: 33 },
    { location: "Indonesia", value: 25 },
    { location: "Brazil", value: 19 },
  ],
  "Real Madrid": [
    { location: "Indonesia", value: 100 },
    { location: "India", value: 62 },
    { location: "Spain", value: 47 },
    { location: "Bangladesh", value: 35 },
    { location: "Mexico", value: 31 },
  ],
  Barcelona: [
    { location: "Indonesia", value: 100 },
    { location: "India", value: 58 },
    { location: "Egypt", value: 44 },
    { location: "Spain", value: 40 },
    { location: "Bangladesh", value: 33 },
  ],
};

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

export function scoreGeo(value: number): number {
  return Math.max(0, Math.min(1, value / 100));
}

// Saturating score so breakout values don't dominate linearly.
export function scoreRising(value: number): number {
  return value / (value + 200);
}

export function scoreTop(value: number): number {
  return Math.max(0, Math.min(1, value / 100));
}

export const fallbackMarketDiscovery: MarketDiscovery = {
  live: false,
  geo: GEO_MAP_TEAMS.flatMap((team) =>
    (FALLBACK_GEO_RAW[team] ?? []).map((entry) => ({
      team,
      location: entry.location,
      value: entry.value,
      score: scoreGeo(entry.value),
    })),
  ),
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
