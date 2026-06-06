import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/AppShell";
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
  ArrowUpRight,
  Database,
  Newspaper,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
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

function ForecastPage() {
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

  const provenanceText = useMemo(() => {
    if (geoStatus === "live" && liveFetchedAt) {
      return `Live · SerpApi · ${geoName(geo)} · refreshed ${timeAgo(liveFetchedAt)}`;
    }
    if (geoStatus === "demo") {
      return "Demo snapshot (no live data yet)";
    }
    return `No data for ${geoName(geo)} yet — click "Refresh trends" to fetch`;
  }, [geoStatus, liveFetchedAt, geo]);

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
  }, [stockCandidates]);

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
    return picks.sort((a, b) => b.score - a.score);
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
  const newsSorted = useMemo(
    () =>
      [...newsEvents]
        .sort(
          (a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime(),
        )
        .slice(0, 12),
    [newsEvents],
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

  return (
    <>
      <PageHeader
        title="Forecast Preview"
        subtitle="Use demand signals to decide what to restock, promote, or hold this week"
      />

      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        <Card className="border-primary/20">
          <CardContent className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-foreground">Top 10 Product Recommendations</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  AI-ranked actions from your inventory, market demand, sports news, customer queries,
                  stock movement, and profit margin.
                </div>
              </div>
              <Button variant="outline" onClick={() => setMethodologyOpen(true)}>
                How is the score calculated?
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {topRecommendations.map((forecast, index) => {
                const expanded = expandedRecs.has(forecast.product_id);
                return (
                  <div
                    key={forecast.product_id}
                    className="flex flex-col rounded-xl border border-border bg-background p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <div className="mb-1 flex items-start gap-2">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        #{index + 1}
                      </div>
                      <div className="min-w-0 font-semibold text-foreground">
                        {forecast.product_name} - {forecast.sizeLabel}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {forecast.team} - {forecast.typeLabel}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="outline" className={forecast.urgencyColor}>
                        Score: {forecast.demandSpikeScore}/100
                      </Badge>
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                        Action: {formatActionLabel(forecast.action)}
                      </Badge>
                    </div>
                    <div className="mt-3">
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Reasons
                      </div>
                      <ul className="mt-2 space-y-1 text-sm text-foreground/90">
                        {buildSellerReasons(forecast).map((reason) => (
                          <li key={reason}>- {reason}</li>
                        ))}
                      </ul>
                    </div>

                    {/* Recommendation collapses; pushed to the bottom of the card. */}
                    <div className="mt-auto pt-3">
                      <button
                        type="button"
                        onClick={() => toggleRec(forecast.product_id)}
                        aria-expanded={expanded ? "true" : "false"}
                        className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
                      >
                        {expanded ? "Hide recommendation ▴" : "Show recommendation ▾"}
                      </button>
                      {expanded && (
                        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3">
                          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            Recommendation
                          </div>
                          <div className="mt-2 text-sm text-foreground/90">
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

        <Card className="border-primary/20 bg-gradient-to-br from-primary/10 via-background to-accent/10">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <div className="font-semibold text-foreground">What You Might Be Missing</div>
            </div>
            <div className="space-y-3">
              {missedInsights.map((insight) => (
                <div
                  key={insight}
                  className="rounded-lg border border-border bg-background/80 p-3 text-sm text-foreground/90"
                >
                  {insight}
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

      <Card className="mb-4">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="font-semibold text-foreground">Live Market Signals</span>
                {dataFresh && (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                    Live
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{provenanceText}</div>
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
                {refreshing ? "Refreshing…" : "Refresh trends"}
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
                title="Top searches"
                icon={<Search className="h-3.5 w-3.5" />}
                items={relatedTop}
              />
              <RelatedQueryList
                title="Rising"
                icon={<ArrowUpRight className="h-3.5 w-3.5" />}
                items={relatedRising}
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

      <Card className="mb-4">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Newspaper className="h-4 w-4 text-primary" />
              <div>
                <div className="font-semibold text-foreground">Sports News Signals</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Football events feeding the Sports News score (13% of demand score)
                </div>
              </div>
            </div>
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
                {newsRefreshing ? "Refreshing…" : "Refresh news"}
              </Button>
            </div>
          </div>

          {newsSorted.length > 0 ? (
            <>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent Football Events
              </div>
              <div className="space-y-1.5">
                {newsSorted.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge variant="outline" className={newsTypeBadgeClass(event.type)}>
                        {newsTypeLabel(event.type)}
                      </Badge>
                      <div className="min-w-0 flex-1 text-sm text-foreground/90">
                        {newsHeadline(event)}
                      </div>
                      <div className="text-xs text-muted-foreground">{newsBoostsText(event)}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase">
                          {event.tier}
                        </span>
                        {newsEventDate(event) && (
                          <span className="font-mono text-[10px]">{newsEventDate(event)}</span>
                        )}
                        <span className="w-14 text-right font-mono">{newsDaysAgo(event)}</span>
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
                          · news via Google AI Mode · DeepSeek (deepseek-v4-flash) primary, Gemini fallback
                        </span>
                      )}
                    </>
                  ) : (
                    "Demo data — refresh to pull live API-Football + news events"
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No sports events yet — click "Refresh trends" to pull live data.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <div className="border-b border-border px-5 py-4">
            <div className="font-semibold text-foreground">Demand Spike Score Table</div>
            <div className="text-xs text-muted-foreground">
              Product scoring uses demand signals, stock movement, margin, and customer interest.
            </div>
          </div>

          {forecasts.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="text-right">Recent inquiries</TableHead>
                  <TableHead className="text-right">Trend score</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-center">Manual rating</TableHead>
                  <TableHead className="text-right">Demand Spike Score</TableHead>
                  <TableHead>Urgency label</TableHead>
                  <TableHead>Recommendation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forecasts.map((forecast) => (
                  <TableRow key={forecast.product_id}>
                    <TableCell className="font-medium">{forecast.product_name}</TableCell>
                    <TableCell>{forecast.team}</TableCell>
                    <TableCell>{forecast.typeLabel}</TableCell>
                    <TableCell className="font-mono text-xs">{forecast.sizeLabel}</TableCell>
                    <TableCell className="text-right font-mono">{forecast.stock}</TableCell>
                    <TableCell className="text-right font-mono">{forecast.recentInquiries}</TableCell>
                    <TableCell className="text-right font-mono">
                      {toPercent(forecast.breakdown.marketTrend)}
                    </TableCell>
                    <TableCell className="text-right font-mono">{forecast.marginPercent}%</TableCell>
                    <TableCell className="text-center">
                      <StarRating
                        value={starRatings[forecast.product_id] ?? 0}
                        onChange={(next) =>
                          setStarRatings((prev) => ({ ...prev, [forecast.product_id]: next }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono">{forecast.demandSpikeScore}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={forecast.urgencyColor}>
                        {forecast.urgencyLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-[280px] text-sm text-foreground/90">
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
                {`20–35% Customer Signal (queries + confirmed sales)
20% Market Trend
20% Stock Reduction Velocity
13% Sports News
7% Profit Margin
5% Seller Rating`}
              </div>
              <div className="mt-2 text-xs text-muted-foreground/80">
                DSS = 100 × Σwᵢ·Sᵢ (no normalization). The customer weight is 0.20 until a
                confirmed purchase exists, then 0.35 — so a purchase unlocks the full 0–100
                range (query-only caps at 85, no customer signal caps ~65).
              </div>
            </div>

            <MethodRow
              title="Customer Signal"
              body="customer queries + confirmed sales, 14-day recency decay (saturating); weight 0.20 → 0.35 once a sale is confirmed"
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
}: {
  title: string;
  icon: ReactNode;
  items: { query: string; value: number; score: number; bucket: "top" | "rising" }[];
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">
        {items.map((item) => (
          <div
            key={`${title}-${item.query}`}
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
          >
            <div className="min-w-0 truncate text-sm text-foreground/90">{item.query}</div>
            <div className="shrink-0 font-mono text-xs text-muted-foreground">
              {Math.round(item.score * 100)}%
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
    <div>
      <div className="mb-2 flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          AI Stock Picks
        </div>
        <span
          className="rounded-full border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground/70"
          title={
            usingRuleFallback
              ? fallbackReasonLabel(fallbackReason)
              : "Picks verified by AI (OpenRouter → Gemini fallback)"
          }
        >
          {usingRuleFallback ? "rule filter" : "AI-verified"}
        </span>
      </div>
      <div className="space-y-1.5">
        {items.map((item) => {
          const stocked = queryMatchesInventory(item.query, inventoryText);
          return (
            <div
              key={`pick-${item.query}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground/90">{item.query}</div>
                {!stocked && (
                  <div className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    opportunity — not stocked yet
                  </div>
                )}
              </div>
              <div className="shrink-0 font-mono text-xs text-muted-foreground">
                {Math.round(item.score * 100)}%
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
