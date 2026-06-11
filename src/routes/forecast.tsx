import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { forecastProduct } from "@/lib/forecast";
import type { NewsEvent } from "@/lib/news-score";
import { useT } from "@/lib/i18n";
import { isSupabaseConfigured } from "@/lib/supabase";
import {
  fetchMarketDiscoveryFromSupabase,
  fetchNewsEventsFromSupabase,
  fetchTrendSignalsFromSupabase,
  semanticProductSearchLocalFallback,
  semanticTrendSearchLocalFallback,
  type SemanticSearchHit,
  type StoredTrendSignal,
} from "@/lib/supabase-service";
import { useStore } from "@/lib/store";
import { localTrendSignals, matchQueryToTeam } from "@/lib/trend-signals";
import {
  DEMO_GEO,
  emptyMarketDiscovery,
  fallbackMarketDiscovery,
  GEO_OPTIONS,
  geoName,
  isFresh,
  isJerseyRelevantQuery,
  queryMatchesInventory,
  timeAgo,
  type MarketDiscovery,
} from "@/lib/market-signals";
import {
  AlertTriangle,
  ArrowUpRight,
  Database,
  Gauge,
  Newspaper,
  RefreshCw,
  Radio,
  Search,
  Sparkles,
} from "lucide-react";

export const Route = createFileRoute("/forecast")({
  head: () => ({ meta: [{ title: "Forecast Preview - JerseyBecho AI" }] }),
  component: ForecastPage,
});

const REFRESH_TEAMS = [
  "Argentina",
  "Brazil",
  "Portugal",
  "Real Madrid",
  "Barcelona",
  "Bangladesh",
];

function toPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}


function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{toPercent(value)}</span>
      </div>
      <Progress value={Math.round(value * 100)} className="h-1.5" />
    </div>
  );
}

const FALLBACK_NEWS_EVENTS: NewsEvent[] = [
  {
    id: "f1",
    type: "wc_final",
    team: "Argentina",
    player: "Messi",
    secondary_team: null,
    base_m: 1.0,
    tier: "most",
    event_date: "2026-06-10",
    source: "google_ai_mode",
    geo: "BD",
    context: "Argentina beat Iceland 3-0 in World Cup 2026 opener — Messi scored",
  },
  {
    id: "f2",
    type: "transfer",
    team: "Real Madrid",
    player: "Mourinho",
    secondary_team: null,
    base_m: 0.5,
    tier: "most",
    event_date: "2026-06-06",
    source: "google_ai_mode",
    geo: "BD",
    context: "Mourinho and Konate sign for Real Madrid",
  },
  {
    id: "f3",
    type: "transfer",
    team: "Tottenham",
    player: "Senesi",
    secondary_team: null,
    base_m: 0.5,
    tier: "most",
    event_date: "2026-06-10",
    source: "google_ai_mode",
    geo: "BD",
    context: "Marcos Senesi (Argentina) completes transfer to Tottenham Hotspur",
  },
  {
    id: "f4",
    type: "trophy",
    team: "Paris Saint-Germain",
    player: null,
    secondary_team: null,
    base_m: 0.7,
    tier: "most",
    event_date: "2026-06-05",
    source: "google_ai_mode",
    geo: "BD",
    context: "PSG won the UEFA Champions League title",
  },
  {
    id: "f5",
    type: "trophy",
    team: "Arsenal",
    player: null,
    secondary_team: null,
    base_m: 0.7,
    tier: "most",
    event_date: "2026-06-05",
    source: "google_ai_mode",
    geo: "BD",
    context: "Arsenal won the Premier League title",
  },
];

function ForecastPage() {
  const t = useT();
  const { products } = useStore();
  const [trendSignals, setTrendSignals] = useState<StoredTrendSignal[]>(localTrendSignals);
  const [marketDiscovery, setMarketDiscovery] = useState<MarketDiscovery>(fallbackMarketDiscovery);
  // Selected Google Trends geo. SerpApi is only ever called on Refresh; switching geo just
  // reads that market's Supabase cache. "live" = cache hit, "demo" = DEMO_GEO snapshot,
  // "empty" = no cache for this geo yet.
  const [newsEvents, setNewsEvents] = useState<NewsEvent[]>([]);
  const [geo, setGeo] = useState<string>(DEMO_GEO);
  const [geoStatus, setGeoStatus] = useState<"live" | "demo" | "empty">("demo");
  const [refreshing, setRefreshing] = useState(false);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("Argentina 2XL player edition");
  const [starRatings, setStarRatings] = useState<Record<string, number>>({});
  // Per-card recommendation expand/collapse (in-memory, keyed by product id).
  const [expandedRecs, setExpandedRecs] = useState<Set<string>>(new Set());

  const toggleRec = (productId: string) =>
    setExpandedRecs((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState("");

  // Most-recent live timestamp across either feature (used for "refreshed x ago" + freshness).
  const liveFetchedAt = useMemo(() => {
    const liveTrend = trendSignals.find(
      (s) => s.source === "serpapi_google_trends" && s.fetched_at,
    );
    return [marketDiscovery.fetchedAt, liveTrend?.fetched_at]
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop();
  }, [marketDiscovery.fetchedAt, trendSignals]);

  // "Last refreshed" label from the most-recent cached timestamp (trend_signals /
  // market_discovery). No timestamp yet → "Never refreshed". Presentational only.
  const provenanceText = useMemo(() => {
    if (liveFetchedAt) {
      return `Last refreshed: ${timeAgo(liveFetchedAt)}`;
    }
    return "";
  }, [liveFetchedAt]);

  const dataFresh = geoStatus === "live" && isFresh(liveFetchedAt);

  // Dev-only gate for internal/debug text (e.g. the news source-provenance line). True in
  // development, or in any build when the URL carries ?debug=1 — never in the normal
  // customer view. Computed once on mount (location is stable for this page).
  const [showDebug] = useState(
    () =>
      import.meta.env.DEV ||
      (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("debug") === "1"),
  );

  // Lowercased inventory text for cross-checking related queries against what we stock.
  const inventoryText = useMemo(
    () =>
      products.map((product) =>
        `${product.product_name} ${product.team_country_club} ${product.player_name ?? ""} ${product.font_name ?? ""}`.toLowerCase(),
      ),
    [products],
  );

  // Boxes 1 & 2 show the RAW SerpApi top / rising lists — no relevance filter, no tags.
  // (The jersey-relevance call now lives only in Box 3's fallback path.)
  const relatedTop = useMemo(
    () =>
      marketDiscovery.related
        .filter((r) => r.bucket === "top")
        .sort((a, b) => b.score - a.score),
    [marketDiscovery.related],
  );

  const relatedRising = useMemo(
    () =>
      marketDiscovery.related
        .filter((r) => r.bucket === "rising")
        .sort((a, b) => b.score - a.score),
    [marketDiscovery.related],
  );

  // RISING display ordering (display-only — never touches `related`, scoring, or the API):
  // catalog-matched queries first, then up to 3 "opportunity" (unmatched) queries, capped
  // at 8 rows total. "matched" = the query maps to something we already stock.
  const risingDisplay = useMemo(() => {
    const annotated = relatedRising.map((r) => ({
      ...r,
      matched: queryMatchesInventory(r.query, inventoryText),
    }));
    const matched = annotated.filter((r) => r.matched);
    const opportunity = annotated.filter((r) => !r.matched).slice(0, 3);
    return [...matched, ...opportunity].slice(0, 8);
  }, [relatedRising, inventoryText]);

  // Box 3 (AI Stock Picks) candidates: every raw top + rising query, deduped by text,
  // scored by the (20/80 recency-blended) trend score. Memoized so the classify effect
  // below only re-fires when the underlying queries actually change.
  const stockCandidates = useMemo(() => {
    const byQuery = new Map<string, { query: string; score: number }>();
    for (const r of marketDiscovery.related) {
      const key = r.query.trim().toLowerCase();
      const existing = byQuery.get(key);
      if (!existing || r.score > existing.score) byQuery.set(key, { query: r.query, score: r.score });
    }
    return [...byQuery.values()];
  }, [marketDiscovery.related]);

  // Gemini classification of the candidates (server-side, cached per query per day).
  // null = use the deterministic rule-filter fallback (key missing / call failed / not
  // yet loaded). Never blocks render; fetch failures simply leave us on the fallback.
  const [jerseyClassifications, setJerseyClassifications] = useState<
    { query: string; isJersey: boolean; team: string | null; kind: "national" | "club" | null }[] | null
  >(null);
  // Log-safe reason code (never a secret) for WHY Box 3 is on the rule fallback, surfaced
  // as a badge tooltip. e.g. "gemini_key_missing", "gemini_http_429", "fetch_failed".
  const [classifyReason, setClassifyReason] = useState<string | null>(null);

  // Stable content key for the candidate query set. The effect below depends on THIS
  // (not the stockCandidates array reference), so it only re-fires when the actual list
  // of queries changes — re-renders that produce the same queries never re-hit the API.
  const stockCandidatesKey = useMemo(
    () =>
      stockCandidates
        .map((c) => c.query.trim().toLowerCase())
        .sort()
        .join("|"),
    [stockCandidates],
  );

  useEffect(() => {
    let cancelled = false;
    const queries = stockCandidates.map((c) => c.query);
    if (!queries.length) {
      setJerseyClassifications([]);
      setClassifyReason(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/classify-jerseys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queries }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          classifications?:
            | { query: string; isJersey: boolean; team: string | null; kind: "national" | "club" | null }[]
            | null;
        };
        if (cancelled) return;
        // ok + array → use AI verdicts; otherwise null → deterministic fallback.
        if (data?.ok && Array.isArray(data.classifications)) {
          setJerseyClassifications(data.classifications);
          setClassifyReason(null);
        } else {
          setJerseyClassifications(null);
          setClassifyReason(data?.reason ?? "classify_unavailable");
        }
      } catch (error) {
        if (cancelled) return;
        console.error("[classify-jerseys] fetch failed — using rule fallback:", error);
        setJerseyClassifications(null);
        setClassifyReason("fetch_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockCandidatesKey]);

  // Box 3 picks: Gemini-verified team jerseys when available, else the deterministic
  // isJerseyRelevantQuery() filter over the SAME candidates. Ranked by trend score.
  const usingRuleFallback = jerseyClassifications === null;
  const stockPicks = useMemo(() => {
    const scoreByQuery = new Map(
      stockCandidates.map((c) => [c.query.trim().toLowerCase(), c.score]),
    );
    let picks: { query: string; team: string | null; score: number }[];
    if (jerseyClassifications) {
      picks = jerseyClassifications
        .filter((c) => c.isJersey)
        .map((c) => ({
          query: c.query,
          team: c.team ?? matchQueryToTeam(c.query) ?? null,
          score: scoreByQuery.get(c.query.trim().toLowerCase()) ?? 0,
        }));
    } else {
      picks = stockCandidates
        .filter((c) => isJerseyRelevantQuery(c.query))
        .map((c) => ({ query: c.query, team: matchQueryToTeam(c.query) ?? null, score: c.score }));
    }
    // Dedupe near-duplicates by resolved team, keeping the higher-scored query (e.g.
    // "argentina jersey" vs "argentina jersey 2026" → keep the stronger one). Picks with
    // no resolved team are never collapsed together.
    const sorted = picks.sort((a, b) => b.score - a.score);
    const seenTeam = new Set<string>();
    const deduped: typeof sorted = [];
    for (const pick of sorted) {
      const teamKey = pick.team ? pick.team.trim().toLowerCase() : null;
      if (teamKey) {
        if (seenTeam.has(teamKey)) continue;
        seenTeam.add(teamKey);
      }
      deduped.push(pick);
    }
    return deduped;
  }, [jerseyClassifications, stockCandidates]);

  // Cache-only read for a geo. NEVER calls SerpApi — protects the 100-call/month quota.
  // Demo snapshot is only used for DEMO_GEO; other geos with no cache show an empty-state.
  async function loadGeoFromCache(selectedGeo: string) {
    if (!isSupabaseConfigured) {
      if (selectedGeo === DEMO_GEO) {
        setTrendSignals(localTrendSignals);
        setMarketDiscovery(fallbackMarketDiscovery);
        setGeoStatus("demo");
      } else {
        setTrendSignals([]);
        setMarketDiscovery(emptyMarketDiscovery);
        setGeoStatus("empty");
      }
      return;
    }

    const [remoteTrends, remoteMarket] = await Promise.all([
      fetchTrendSignalsFromSupabase(selectedGeo),
      fetchMarketDiscoveryFromSupabase(selectedGeo),
    ]);
    const hasLive = remoteTrends.length > 0 || remoteMarket.live;

    if (hasLive) {
      setTrendSignals(remoteTrends);
      setMarketDiscovery(remoteMarket);
      setGeoStatus("live");
    } else if (selectedGeo === DEMO_GEO) {
      setTrendSignals(localTrendSignals);
      setMarketDiscovery(fallbackMarketDiscovery);
      setGeoStatus("demo");
    } else {
      setTrendSignals([]);
      setMarketDiscovery(emptyMarketDiscovery);
      setGeoStatus("empty");
    }
  }

  // The ONLY place SerpApi fires: an explicit Refresh, for the currently selected geo.
  async function handleRefresh() {
    setRefreshing(true);
    try {
      await fetch("/api/trends-refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teams: REFRESH_TEAMS, geo }),
      });
      await loadGeoFromCache(geo);
      // trends-refresh also refreshes news server-side; reload the box so it updates.
      await reloadNews();
    } catch (error) {
      console.error("[trends-refresh] Refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  }

  const forecasts = useMemo(() => {
    try {
      return products
        .map((p) =>
          forecastProduct(
            { ...p, starRating: starRatings[p.id] },
            trendSignals,
            products,
            newsEvents,
          ),
        )
        .sort((left, right) => right.demandSpikeScore - left.demandSpikeScore);
    } catch (error) {
      console.error("Forecast error:", error);
      return [];
    }
  }, [products, trendSignals, newsEvents, starRatings]);

  const topRecommendations = useMemo(() => forecasts.slice(0, 10), [forecasts]);

  // Sports News Signals (display-only proof panel — reads the already-fetched
  // newsEvents state; never re-fetches and never touches scoring). Newest first, max 12.
  const displayNews = newsEvents.length > 0 ? newsEvents : FALLBACK_NEWS_EVENTS;

  const newsSorted = useMemo(
    () =>
      [...displayNews]
        .sort(
          (a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime(),
        )
        .slice(0, 12),
    [displayNews],
  );

  // Provenance for the "Source" footer: how many events came from live API-Football,
  // from Bing-Copilot news (Gemini-parsed), vs the demo seed. Anything not tagged as
  // a live source counts as demo.
  const newsProvenance = useMemo(() => {
    const apiFootball = newsEvents.filter((event) => event.source === "api_football").length;
    const news = newsEvents.filter((event) => event.source === "google_ai_mode").length;
    return { apiFootball, news, demo: newsEvents.length - apiFootball - news };
  }, [newsEvents]);

  // Most recent news write-time (news_events.created_at). The NewsEvent type omits
  // created_at but select("*") returns it at runtime — read it via a local cast.
  // Recomputes whenever newsEvents changes (i.e. after each refresh reload).
  const newsRefreshedAt = useMemo(() => {
    const times = newsEvents
      .map((event) => (event as { created_at?: string }).created_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    return times.pop();
  }, [newsEvents]);

  const productMatches = useMemo(
    () =>
      technicalDetailsOpen === "technical-details"
        ? semanticProductSearchLocalFallback(searchQuery)
        : [],
    [searchQuery, technicalDetailsOpen],
  );

  const trendMatches = useMemo(
    () =>
      technicalDetailsOpen === "technical-details"
        ? semanticTrendSearchLocalFallback(searchQuery)
        : [],
    [searchQuery, technicalDetailsOpen],
  );

  // Re-read news_events into state. Used on mount AND after any refresh so the
  // Sports News box reflects newly-written events. Non-blocking, fail-safe.
  async function reloadNews() {
    if (!isSupabaseConfigured) return;
    try {
      const events = await fetchNewsEventsFromSupabase();
      setNewsEvents(events);
    } catch (error) {
      console.error("[news] reload failed:", error);
    }
  }

  // News-only refresh: triggers the server to pull API-Football transfers +
  // Google AI Mode news, then reloads the box. Does NOT touch trends/SerpApi-trends.
  async function handleNewsRefresh() {
    setNewsRefreshing(true);
    try {
      await fetch("/api/news-only-refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      await reloadNews();
    } catch (error) {
      console.error("[news-only-refresh] Refresh failed:", error);
    } finally {
      setNewsRefreshing(false);
    }
  }

  // Fetch news events once on mount — non-blocking, S_news falls back to 0 if empty.
  useEffect(() => {
    void reloadNews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount AND whenever the seller switches geo: read that market's cache only.
  // No SerpApi here — switching location never spends quota.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        if (!cancelled) await loadGeoFromCache(geo);
      } catch {
        if (!cancelled) {
          setTrendSignals(geo === DEMO_GEO ? localTrendSignals : []);
          setMarketDiscovery(geo === DEMO_GEO ? fallbackMarketDiscovery : emptyMarketDiscovery);
          setGeoStatus(geo === DEMO_GEO ? "demo" : "empty");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);

  const missedInsights = useMemo(() => {
    const insights: string[] = [];

    const argentinaLargeSizeRisk = products.some(
      (product) =>
        product.team_country_club === "Argentina" &&
        product.variants.some(
          (variant) =>
            ["XL", "XXL"].includes(variant.size) && variant.stock_quantity > 0 && variant.stock_quantity <= 2,
        ),
    );
    if (argentinaLargeSizeRisk) {
      insights.push("Argentina demand is high, but XL/2XL stock is limited.");
    }

    if (
      products.some((product) =>
        /Portugal|Cristiano|Ronaldo/i.test(
          `${product.team_country_club} ${product.player_name ?? ""} ${product.font_name ?? ""}`,
        ),
      )
    ) {
      insights.push("Portugal/Ronaldo interest is rising after recent football attention.");
    }

    if (
      products.some(
        (product) =>
          product.edition_type === "Player Edition" &&
          product.variants.some((variant) => variant.selling_price - variant.buy_price >= 250),
      )
    ) {
      insights.push("High-margin player editions should be promoted before fan editions.");
    }

    if (trendSignals.some((signal) => signal.language === "bn" && signal.growthWeight >= 0.7)) {
      insights.push("Bangla jersey searches are rising; add Bangla-friendly product tags.");
    }


    return insights.slice(0, 5);
  }, [forecasts, products, trendSignals]);

  // KPI strip — pure presentational reads of already-computed data (no scoring/logic).
  const criticalCount = forecasts.filter(
    (f) => f.urgencyLabel === "CRITICAL RESTOCK REQUIRED",
  ).length;
  const topScore = forecasts.length
    ? Math.max(...forecasts.map((f) => f.demandSpikeScore))
    : 0;
  const liveSignalCount = relatedTop.length + relatedRising.length;
  const sportsCount = newsSorted.length;

  return (
    <>
      {/* Premium status header with live / demo-mode indicator */}
      <div className="mb-5 flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-[28px]">
              {t("Demand Forecast")}
            </h1>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {t("Real-time demand signals to decide what to restock, promote, or hold this week.")}
          </p>
        </div>
        <div className="shrink-0 text-xs text-muted-foreground sm:text-right">{provenanceText}</div>
      </div>

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("Critical restocks")}
          value={criticalCount}
          sub="demand score ≥ 80"
          tone="danger"
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <KpiCard
          label={t("Top demand score")}
          value={topScore}
          sub="out of 100"
          tone="primary"
          icon={<Gauge className="h-4 w-4" />}
        />
        <KpiCard
          label={t("Live market signals")}
          value={liveSignalCount}
          sub="top + rising queries"
          tone="accent"
          icon={<Radio className="h-4 w-4" />}
        />
        <KpiCard
          label={t("Sports events")}
          value={sportsCount}
          sub="feeding S_news"
          tone="info"
          icon={<Newspaper className="h-4 w-4" />}
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        <Card className="panel-sheen border-border/70">
          <CardContent className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <SectionTitle
                icon={<Gauge className="h-4 w-4" />}
                title={t("Top 10 Product Recommendations")}
                subtitle={t(
                  "AI-ranked actions from inventory, market demand, sports news, customer queries, stock movement, and margin.",
                )}
              />
              <Button variant="outline" size="sm" onClick={() => setMethodologyOpen(true)}>
                {t("How is the score calculated?")}
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {topRecommendations.map((forecast, index) => {
                const expanded = expandedRecs.has(forecast.product_id);
                return (
                  <div
                    key={forecast.product_id}
                    className="card-hover flex flex-col rounded-xl border border-border bg-background/60 p-4 hover:border-primary/30"
                  >
                    <div className="mb-2 flex items-start gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent font-mono text-xs font-bold text-primary-foreground shadow-sm">
                        {index + 1}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold leading-tight text-foreground">
                          {forecast.product_name}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {forecast.team} · {forecast.typeLabel} · {forecast.sizeLabel}
                        </div>
                      </div>
                    </div>

                    {/* DSS strength bar — presentational view of demandSpikeScore. */}
                    <div className="mb-3 mt-1">
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Demand score
                        </span>
                        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {forecast.demandSpikeScore}
                          <span className="text-[10px] text-muted-foreground">/100</span>
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all duration-500"
                          style={{ width: `${Math.min(100, Math.max(0, forecast.demandSpikeScore))}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className={`text-[10px] ${forecast.urgencyColor}`}>
                        {forecast.urgencyLabel}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-primary/20 bg-primary/10 text-[10px] text-primary"
                      >
                        {formatActionLabel(forecast.action)}
                      </Badge>
                    </div>

                    <div className="mt-3">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Why
                      </div>
                      <ul className="mt-1.5 space-y-1 text-[13px] text-foreground/85">
                        {buildSellerReasons(forecast).map((reason) => (
                          <li key={reason} className="flex gap-1.5">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/60" aria-hidden />
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Recommendation collapses; pushed to the bottom of the card. */}
                    <div className="mt-auto pt-3">
                      <button
                        type="button"
                        onClick={() => toggleRec(forecast.product_id)}
                        aria-expanded={expanded ? "true" : "false"}
                        className="cursor-pointer text-xs font-medium text-primary transition-colors hover:text-primary/80"
                      >
                        {expanded ? "Hide recommendation ▴" : "Show recommendation ▾"}
                      </button>
                      {expanded && (
                        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3">
                          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Recommendation
                          </div>
                          <div className="mt-1.5 text-[13px] text-foreground/90">
                            {forecast.recommendation}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {topRecommendations.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground md:col-span-2 lg:col-span-3">
                  No products are available yet for recommendation ranking.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="panel-sheen border-primary/20 bg-gradient-to-br from-primary/10 via-card to-accent/10">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="font-semibold text-foreground">What You Might Be Missing</div>
            </div>
            <div className="space-y-2.5">
              {missedInsights.map((insight) => (
                <div
                  key={insight}
                  className="flex gap-2 rounded-lg border border-border bg-background/60 p-3 text-[13px] text-foreground/90"
                >
                  <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>{insight}</span>
                </div>
              ))}
              {missedInsights.length === 0 && (
                <div className="rounded-lg border border-border bg-background/80 p-3 text-sm text-muted-foreground">
                  Add more products or trend signals to unlock missed-opportunity insights.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="panel-sheen mb-4 border-border/70">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
                  <Radio className="h-4 w-4" />
                </div>
                <span className="font-semibold text-foreground">{t("Live Market Signals")}</span>
              </div>
              <div className="mt-1 pl-9 text-xs text-muted-foreground">{provenanceText}</div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Select value={geo} onValueChange={setGeo} disabled={refreshing}>
                <SelectTrigger className="h-9 w-[170px]" aria-label="Select market">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GEO_OPTIONS.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.name} ({option.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? t("Refreshing…") : t("Refresh trends")}
              </Button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <div className="font-medium text-foreground">
                Top Jersey Searches in {geoName(geo)}
              </div>
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              Related queries for "jersey" · weighted recency: 20% last 24h + 80% last 7d · AI Stock Picks = what to stock next.
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <RelatedQueryList
                title={t("Top searches")}
                icon={<Search className="h-3.5 w-3.5" />}
                items={relatedTop}
              />
              <RelatedQueryList
                title={t("Rising")}
                icon={<ArrowUpRight className="h-3.5 w-3.5" />}
                items={risingDisplay}
                markOpportunity
              />
              <StockPicksList
                items={stockPicks}
                inventoryText={inventoryText}
                usingRuleFallback={usingRuleFallback}
                fallbackReason={classifyReason}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="panel-sheen mb-4 border-border/70">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <SectionTitle
              icon={<Newspaper className="h-4 w-4" />}
              title={t("Sports News Signals")}
              subtitle={t("Football events feeding the Sports News score (13% of demand score)")}
            />
            <div className="flex shrink-0 items-center gap-2">
              {newsRefreshedAt && (
                <span className="text-xs text-muted-foreground">
                  refreshed {timeAgo(newsRefreshedAt)}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleNewsRefresh}
                disabled={newsRefreshing}
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${newsRefreshing ? "animate-spin" : ""}`} />
                {newsRefreshing ? t("Refreshing…") : t("Refresh news")}
              </Button>
            </div>
          </div>

          {newsSorted.length > 0 ? (
            <>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("Recent Football Events")}
              </div>
              <div className="space-y-1">
                {newsSorted.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 transition-colors hover:border-border hover:bg-muted/30"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${newsTypeBadgeClass(event.type)}`}
                      >
                        {newsTypeLabel(event.type)}
                      </Badge>
                      <div className="min-w-0 flex-1 text-[13px] font-medium text-foreground/90">
                        {newsHeadline(event)}
                      </div>
                      <div className="hidden text-xs text-muted-foreground sm:block">
                        {newsBoostsText(event)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                          {event.tier}
                        </span>
                        {newsEventDate(event) && (
                          <span className="font-mono text-[10px] tabular-nums">
                            {newsEventDate(event)}
                          </span>
                        )}
                        <span className="w-14 text-right font-mono text-[10px] tabular-nums">
                          {newsDaysAgo(event)}
                        </span>
                      </div>
                    </div>
                    {/* DISPLAY-ONLY AI demand color — does not affect any score. */}
                    {event.context && (
                      <div className="mt-1 text-xs italic text-muted-foreground/80">
                        {event.context}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* Internal source-provenance line — dev/?debug=1 only, hidden from customers. */}
              {showDebug && (
                <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                  {newsProvenance.apiFootball > 0 || newsProvenance.news > 0 ? (
                    <>
                      {`Live: ${newsProvenance.apiFootball} from API-Football, ${newsProvenance.news} from news, ${newsProvenance.demo} demo`}
                      {newsProvenance.news > 0 && (
                        <span className="ml-1">
                          · news via Google AI Mode · DeepSeek (deepseek-chat) primary, Gemini fallback
                        </span>
                      )}
                    </>
                  ) : (
                    "No live events yet — refresh to pull live API-Football + news events"
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t('No sports events yet — click "Refresh trends" to pull live data.')}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="panel-sheen border-border/70">
        <CardContent className="overflow-x-auto p-0">
          <div className="border-b border-border px-5 py-4">
            <SectionTitle
              icon={<Gauge className="h-4 w-4" />}
              title={t("Demand Spike Score Table")}
              subtitle={t(
                "Per-product DSS from demand signals, stock movement, margin, and customer interest.",
              )}
            />
          </div>

          {forecasts.length > 0 ? (
            <Table>
              <TableHeader className="[&_th]:h-10 [&_th]:bg-muted/40 [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="text-right">Inquiries</TableHead>
                  <TableHead className="text-right">Trend</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-center">Rating</TableHead>
                  <TableHead className="text-right">DSS</TableHead>
                  <TableHead>Urgency</TableHead>
                  <TableHead>Recommendation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forecasts.map((forecast) => (
                  <TableRow key={forecast.product_id}>
                    <TableCell className="font-medium text-foreground">
                      {forecast.product_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{forecast.team}</TableCell>
                    <TableCell className="text-muted-foreground">{forecast.typeLabel}</TableCell>
                    <TableCell className="font-mono text-xs">{forecast.sizeLabel}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {forecast.stock}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {forecast.recentInquiries}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {toPercent(forecast.breakdown.marketTrend)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {forecast.marginPercent}%
                    </TableCell>
                    <TableCell className="text-center">
                      <StarRating
                        value={starRatings[forecast.product_id] ?? 0}
                        onChange={(next) =>
                          setStarRatings((prev) => ({ ...prev, [forecast.product_id]: next }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted lg:block">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
                            style={{
                              width: `${Math.min(100, Math.max(0, forecast.demandSpikeScore))}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {forecast.demandSpikeScore}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`whitespace-nowrap text-[10px] ${forecast.urgencyColor}`}
                      >
                        {forecast.urgencyLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-[280px] text-[13px] text-foreground/90">
                      <div>{forecast.recommendation}</div>
                      {forecast.matchedTrendKeyword && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Matched signal: {forecast.matchedTrendKeyword}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-8 text-center text-muted-foreground">
              No products to forecast yet. Add inventory to see DSS scores.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="p-5">
          <Accordion
            type="single"
            collapsible
            value={technicalDetailsOpen}
            onValueChange={setTechnicalDetailsOpen}
          >
            <AccordionItem value="technical-details" className="border-b-0">
              <AccordionTrigger>Technical implementation details</AccordionTrigger>
              <AccordionContent>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {isSupabaseConfigured ? "Supabase + pgvector configured" : "Local fallback mode"}
                  </Badge>
                  <Badge variant="outline">Vercel API routes</Badge>
                  <Badge variant="outline">Gemini/Groq</Badge>
                </div>
                <div className="mb-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                  Backend proof includes Supabase/Postgres, pgvector, Vercel serverless endpoints,
                  Gemini/Groq integration, and the products, trend_signals, forecast_scores, and
                  chat_logs data flow used by the demo.
                </div>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                  <div>
                    <div className="mb-2 text-sm font-medium text-foreground">
                      Retrieval proof search
                    </div>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="pl-9"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Argentina 2XL player edition"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <SemanticPanel title="Product context" items={productMatches} />
                    <SemanticPanel title="Trend context" items={trendMatches} />
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      <Sheet open={methodologyOpen} onOpenChange={setMethodologyOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Demand Score Methodology</SheetTitle>
            <SheetDescription>
              How the preliminary demo ranks what to restock, promote, or hold.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="font-medium text-foreground">Demand Spike Score</div>
              <div className="mt-2 whitespace-pre-line text-muted-foreground">
                {`30–45% Customer Signal (queries + confirmed sales)
15% Market Trend
20% Stock Reduction Velocity
13% Sports News
4% Profit Margin
3% Seller Rating`}
              </div>
              <div className="mt-2 text-xs text-muted-foreground/80">
                DSS = 100 × Σwᵢ·Sᵢ (no normalization). The customer weight is 0.30 until a confirmed
                purchase exists, then 0.45 — so a purchase unlocks the full 0–100 range (query-only
                caps at 85, no customer signal caps ~55).
              </div>
            </div>

            <MethodRow
              title="Customer Signal"
              body="customer queries + confirmed sales, 14-day recency decay (saturating); weight 0.30 → 0.45 once a sale is confirmed"
            />
            <MethodRow
              title="Market Trend"
              body="Live SerpApi Google Trends · 20% last-24h + 80% last-7d · geo-aware"
            />
            <MethodRow
              title="Stock Reduction Velocity"
              body="days-of-supply urgency from recent sales rate (14-day target cover)"
            />
            <MethodRow
              title="Sports News"
              body="transfers, trophies, hat-tricks, marquee call-ups (7-day recency decay)"
            />
            <MethodRow
              title="Profit Margin"
              body="prioritizes profitable products when demand is healthy"
            />
            <MethodRow
              title="Seller Rating"
              body="seller's manual 1–5★ market read (stars ÷ 5)"
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function buildSellerReasons(forecast: ReturnType<typeof forecastProduct>) {
  const reasons: string[] = [];
  if (forecast.breakdown.customerConversation >= 0.6) {
    reasons.push("Customer conversation is active (queries + confirmed sales).");
  }
  if (forecast.breakdown.marketTrend >= 0.7) {
    reasons.push("Market trend demand is active.");
  }
  if (forecast.breakdown.stockReductionVelocity >= 0.7) {
    reasons.push("Stock reduction velocity is high.");
  }
  if (forecast.breakdown.sportsNews >= 0.7) {
    reasons.push("Sports/news demand is rising.");
  }
  if (forecast.breakdown.profitMargin >= 0.5) {
    reasons.push("Profit margin supports stronger focus.");
  }
  if (!reasons.length) {
    reasons.push("Demand is steady, but not urgent yet.");
  }
  return reasons.slice(0, 3);
}

function formatActionLabel(action: ReturnType<typeof forecastProduct>["action"]) {
  if (action === "Buy Now" || action === "Preorder / Restock") return "Restock Immediately";
  if (action === "Restock Soon") return "Restock Soon";
  if (action === "Promote") return "Promote This Week";
  return "Hold / Monitor";
}

function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`Set rating to ${star}`}
          onClick={() => onChange(value === star ? 0 : star)}
          className={`text-base leading-none transition-colors ${
            star <= value ? "text-amber-400" : "text-muted-foreground/30 hover:text-amber-300"
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ── Sports News Signals helpers (display-only; no scoring) ────────────────────

function newsTypeLabel(type: NewsEvent["type"]): string {
  const labels: Record<NewsEvent["type"], string> = {
    transfer: "transfer",
    trophy: "trophy",
    wc_final: "wc final",
    kit_release: "kit release",
    retirement: "retirement",
    performance: "performance",
  };
  return labels[type] ?? type;
}

function newsTypeBadgeClass(type: NewsEvent["type"]): string {
  const classes: Record<NewsEvent["type"], string> = {
    transfer: "bg-sky-500/10 text-sky-600 border-sky-500/30 dark:text-sky-400",
    trophy: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
    wc_final: "bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400",
    kit_release: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    retirement: "bg-rose-500/10 text-rose-600 border-rose-500/30 dark:text-rose-400",
    performance: "bg-primary/10 text-primary border-primary/20",
  };
  return classes[type] ?? "bg-muted text-muted-foreground border-border";
}

// Compose a readable headline from whatever fields the row has. Never prints
// "undefined" — falls back to the team when player/secondary are null.
function newsHeadline(event: NewsEvent): string {
  const player = event.player?.trim();
  const team = event.team?.trim() || "Unknown team";
  const secondary = event.secondary_team?.trim();
  switch (event.type) {
    case "transfer":
      if (player && secondary) return `${player} → ${secondary}`;
      if (player) return `${player} transfer (${team})`;
      return secondary ? `${team} → ${secondary}` : `${team} transfer`;
    case "trophy":
      return `${team} won a trophy`;
    case "performance":
      return player ? `${player} notable performance (${team})` : `${team} notable performance`;
    case "retirement":
      return player ? `${player} retirement` : `${team} retirement`;
    case "kit_release":
      return `${team} new kit released`;
    case "wc_final":
      return `${team} in World Cup final`;
    default:
      return team;
  }
}

function newsBoostsText(event: NewsEvent): string {
  const team = event.team?.trim() || "—";
  const secondary = event.secondary_team?.trim();
  return secondary ? `boosts: ${team} + ${secondary}` : `boosts: ${team}`;
}

function newsDaysAgo(event: NewsEvent): string {
  const then = new Date(event.event_date).getTime();
  if (!Number.isFinite(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  return `${days}d ago`;
}

// Absolute event date (e.g. "May 31") from the real, Gemini-extracted event_date.
function newsEventDate(event: NewsEvent): string {
  const d = new Date(event.event_date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function MethodRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{body}</div>
    </div>
  );
}

// Boxes 1 & 2 — RAW SerpApi terms + %. No relevance filter, no opportunity tag.
function RelatedQueryList({
  title,
  icon,
  items,
  markOpportunity = false,
}: {
  title: string;
  icon: ReactNode;
  items: { query: string; value: number; score: number; bucket: "top" | "rising"; matched?: boolean }[];
  // When true, unmatched rows (not in catalog) get a muted "opportunity" badge.
  markOpportunity?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {icon}
          {title}
        </div>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {items.length}
        </span>
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <div
            key={`${title}-${item.query}`}
            className="relative overflow-hidden rounded-md border border-border/60 bg-card px-2.5 py-1.5"
          >
            {/* Score data-bar behind the label. */}
            <div
              className="absolute inset-y-0 left-0 bg-primary/10"
              style={{ width: `${Math.round(item.score * 100)}%` }}
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-foreground/90">{item.query}</div>
                {markOpportunity && item.matched === false && (
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                    opportunity
                  </div>
                )}
              </div>
              <div className="shrink-0 font-mono text-xs font-medium tabular-nums text-foreground">
                {Math.round(item.score * 100)}%
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No data yet.
          </div>
        )}
      </div>
    </div>
  );
}

// Box 3 — AI Stock Picks. Gemini-verified team jerseys (or the deterministic rule
// fallback when Gemini is unavailable), ranked by trend score. The "not stocked yet"
// opportunity tag lives ONLY here, and only when the team isn't already in inventory.
// Map a log-safe reason code to a human-readable, secret-free explanation for the badge
// tooltip (so the demo makes clear WHY AI verification is off).
function fallbackReasonLabel(reason: string | null): string {
  if (reason === "demo_cache_empty")
    return "Demo mode — no seeded classifications found; run scripts/seed-demo-cache.ts";
  if (reason === "demo_mode") return "Demo mode — serving pre-seeded cached data";
  if (reason === "deepseek_key_missing") return "DeepSeek key missing — add DEEPSEEK_API_KEY to enable AI verification";
  if (reason?.startsWith("deepseek_http_"))
    return `DeepSeek returned ${reason.replace("deepseek_http_", "HTTP ")} — using rule filter`;
  if (reason === "deepseek_parse_failed") return "DeepSeek response unparseable — using rule filter";
  if (reason === "openrouter_key_missing") return "OpenRouter key missing — add OPENROUTER_API_KEY to enable AI verification";
  if (reason === "gemini_key_missing") return "Gemini key missing — add GEMINI_API_KEY to enable AI verification";
  if (reason === "fetch_failed") return "Classifier request failed — using deterministic rule filter";
  if (reason?.startsWith("openrouter_http_"))
    return `OpenRouter returned ${reason.replace("openrouter_http_", "HTTP ")} — check OPENROUTER_MODEL in .env.local`;
  if (reason === "openrouter_parse_failed") return "OpenRouter response unparseable — using rule filter";
  if (reason?.startsWith("gemini_http_"))
    return `Gemini returned ${reason.replace("gemini_http_", "HTTP ")} — using rule filter`;
  if (reason === "gemini_parse_failed") return "Gemini response unparseable — using rule filter";
  return "AI verification unavailable — using deterministic rule filter";
}

function StockPicksList({
  items,
  inventoryText,
  usingRuleFallback,
  fallbackReason,
}: {
  items: { query: string; team: string | null; score: number }[];
  inventoryText: string[];
  usingRuleFallback: boolean;
  fallbackReason: string | null;
}) {
  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
      <div className="mb-2.5 flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
          <Sparkles className="h-3.5 w-3.5" />
          AI Stock Picks
        </div>
        <span
          className={`cursor-help rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            usingRuleFallback
              ? "border-border bg-muted text-muted-foreground"
              : "border-success/30 bg-success/10 text-success"
          }`}
          title={
            usingRuleFallback
              ? fallbackReasonLabel(fallbackReason)
              : "Picks verified by AI (DeepSeek → Gemini fallback)"
          }
        >
          {usingRuleFallback ? "rule filter" : "AI-verified"}
        </span>
      </div>
      <div className="space-y-1">
        {items.map((item) => {
          const stocked = queryMatchesInventory(item.query, inventoryText);
          return (
            <div
              key={`pick-${item.query}`}
              className="relative overflow-hidden rounded-md border border-border/60 bg-card px-2.5 py-1.5"
            >
              <div
                className="absolute inset-y-0 left-0 bg-primary/10"
                style={{ width: `${Math.round(item.score * 100)}%` }}
                aria-hidden
              />
              <div className="relative flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-foreground/90">{item.query}</div>
                  {!stocked && (
                    <div className="flex items-center gap-1 text-[10px] font-medium text-success">
                      <span className="h-1 w-1 rounded-full bg-success" aria-hidden />
                      opportunity — not stocked yet
                    </div>
                  )}
                </div>
                <div className="shrink-0 font-mono text-xs font-medium tabular-nums text-foreground">
                  {Math.round(item.score * 100)}%
                </div>
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No stockable jersey picks yet.
          </div>
        )}
      </div>
    </div>
  );
}

function SemanticPanel({ title, items }: { title: string; items: SemanticSearchHit[] }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <div className="text-sm font-medium text-foreground">{title}</div>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={`${title}-${item.id}`} className="rounded-md border border-border bg-muted/30 p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-xs font-medium text-foreground">
                {String(item.metadata.product_name || item.metadata.keyword || item.id)}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground">
                {Math.round(item.similarity * 100)}%
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {item.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Premium panel header — accent icon chip + title + optional subtitle.
function SectionTitle({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
        {icon}
      </div>
      <div>
        <div className="font-semibold leading-tight text-foreground">{title}</div>
        {subtitle && <div className="mt-1 max-w-xl text-xs text-muted-foreground">{subtitle}</div>}
      </div>
    </div>
  );
}

// Live / demo-mode status pill — presents the existing geoStatus (no new data logic).
function StatusIndicator({
  status,
  fresh,
  fetchedAt,
}: {
  status: "live" | "demo" | "empty";
  fresh: boolean;
  fetchedAt?: string;
}) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
        <span className="status-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
        Live
        {fresh && fetchedAt && (
          <span className="font-normal normal-case tracking-normal text-success/70">
            {timeAgo(fetchedAt)}
          </span>
        )}
      </span>
    );
  }
  if (status === "demo") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
        Demo snapshot
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
      No data
    </span>
  );
}

// Headline KPI tile — large mono numeral, tone-colored accent chip. Presentational.
function KpiCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: number;
  sub: string;
  tone: "primary" | "danger" | "accent" | "info";
  icon: ReactNode;
}) {
  const text = {
    primary: "text-primary",
    danger: "text-destructive",
    accent: "text-accent",
    info: "text-info",
  }[tone];
  const chip = {
    primary: "bg-primary/10 ring-primary/20",
    danger: "bg-destructive/10 ring-destructive/20",
    accent: "bg-accent/10 ring-accent/20",
    info: "bg-info/10 ring-info/20",
  }[tone];
  return (
    <div className="card-hover panel-sheen relative overflow-hidden rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 ${chip} ${text}`}>
          {icon}
        </div>
      </div>
      <div
        className={`mt-2.5 font-mono text-3xl font-semibold tabular-nums ${text} ${
          tone === "primary" ? "glow-primary" : ""
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
