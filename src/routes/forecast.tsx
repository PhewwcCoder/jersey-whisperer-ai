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
import { localTrendSignals } from "@/lib/trend-signals";
import {
  DEMO_GEO,
  emptyMarketDiscovery,
  fallbackMarketDiscovery,
  GEO_OPTIONS,
  geoName,
  isFresh,
  queryMatchesInventory,
  timeAgo,
  type MarketDiscovery,
} from "@/lib/market-signals";
import {
  ArrowUpRight,
  Database,
  Globe,
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
  const [searchQuery, setSearchQuery] = useState("Argentina 2XL player edition");
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

  // Lowercased inventory text for cross-checking related queries against what we stock.
  const inventoryText = useMemo(
    () =>
      products.map((product) =>
        `${product.product_name} ${product.team_country_club} ${product.player_name ?? ""} ${product.font_name ?? ""}`.toLowerCase(),
      ),
    [products],
  );

  // Group geo-map markets by team for the "Top markets" card.
  const geoByTeam = useMemo(() => {
    const grouped = new Map<string, MarketDiscovery["geo"]>();
    for (const entry of marketDiscovery.geo) {
      const list = grouped.get(entry.team) ?? [];
      list.push(entry);
      grouped.set(entry.team, list);
    }
    return [...grouped.entries()].map(([team, markets]) => ({
      team,
      markets: [...markets].sort((a, b) => b.value - a.value).slice(0, 3),
    }));
  }, [marketDiscovery.geo]);

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
    } catch (error) {
      console.error("[trends-refresh] Refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  }

  const forecasts = useMemo(() => {
    try {
      return products
        .map((p) => forecastProduct(p, trendSignals, products, newsEvents))
        .sort((left, right) => right.demandSpikeScore - left.demandSpikeScore);
    } catch (error) {
      console.error("Forecast error:", error);
      return [];
    }
  }, [products, trendSignals, newsEvents]);

  const topRecommendations = useMemo(() => forecasts.slice(0, 10), [forecasts]);

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

  // Fetch news events once on mount — non-blocking, S_news falls back to 0 if empty.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    fetchNewsEventsFromSupabase()
      .then(setNewsEvents)
      .catch(() => {});
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

            <div className="space-y-3">
              {topRecommendations.map((forecast, index) => (
                <div
                  key={forecast.product_id}
                  className="rounded-xl border border-border bg-background p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                          #{index + 1}
                        </div>
                        <div className="truncate font-semibold text-foreground">
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
                    </div>

                    <div className="w-full rounded-lg border border-border bg-muted/30 p-3 lg:max-w-[280px]">
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Recommendation
                      </div>
                      <div className="mt-2 text-sm text-foreground/90">
                        {forecast.recommendation}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {topRecommendations.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
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
              {/* Radix forbids value="" so Worldwide uses a "WW" sentinel; geo state keeps "". */}
              <Select
                value={geo || "WW"}
                onValueChange={(value) => setGeo(value === "WW" ? "" : value)}
                disabled={refreshing}
              >
                <SelectTrigger className="h-9 w-[170px]" aria-label="Select market">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GEO_OPTIONS.map((option) => (
                    <SelectItem key={option.code || "WW"} value={option.code || "WW"}>
                      {option.name}
                      {option.code ? ` (${option.code})` : ""}
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

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <div className="font-medium text-foreground">
                  Top Jersey Searches in {geoName(geo)}
                </div>
              </div>
              <div className="mb-3 text-xs text-muted-foreground">
                Related queries for "jersey" · weighted recency: 60% last 24h + 40% last 7d · Rising = what to stock next.
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <RelatedQueryList
                  title="Top searches"
                  icon={<Search className="h-3.5 w-3.5" />}
                  items={relatedTop}
                  inventoryText={inventoryText}
                />
                <RelatedQueryList
                  title="Rising / What to Stock Next"
                  icon={<ArrowUpRight className="h-3.5 w-3.5" />}
                  items={relatedRising}
                  inventoryText={inventoryText}
                  highlightOpportunities
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary" />
                <div className="font-medium text-foreground">Geographic Demand Map</div>
              </div>
              <div className="mb-3 text-xs text-muted-foreground">
                Which countries search hardest for each kit — use to decide where to expand or ship.
              </div>
              <div className="space-y-4">
                {geoByTeam.map(({ team, markets }) => {
                  const max = Math.max(...markets.map((m) => m.value), 1);
                  return (
                    <div key={team}>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Top markets — {team} jersey
                      </div>
                      <div className="space-y-1.5">
                        {markets.map((market) => (
                          <div key={`${team}-${market.location}`} className="flex items-center gap-2">
                            <div className="w-28 shrink-0 truncate text-sm text-foreground/90">
                              {market.location}
                            </div>
                            <Progress
                              value={Math.round((market.value / max) * 100)}
                              className="h-2 flex-1"
                            />
                            <div className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                              {market.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {geoByTeam.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    No data for {geoName(geo)} yet — click "Refresh trends" to fetch.
                  </div>
                )}
              </div>
            </div>
          </div>
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
                {`32% Customer Conversation
25% Market Trend
20% Stock Reduction Velocity
15% Sports News
8% Profit Margin`}
              </div>
            </div>

            <MethodRow
              title="Customer Conversation"
              body="queries + confirmed sales, 14-day recency decay (w_query=1, w_sale=6)"
            />
            <MethodRow
              title="Market Trend"
              body="Live SerpApi Google Trends · 60% last-24h + 40% last-7d · geo-aware"
            />
            <MethodRow
              title="Stock Reduction Velocity"
              body="days-of-supply urgency (14-day target cover)"
            />
            <MethodRow
              title="Sports News"
              body="transfers, trophies, hat-tricks, marquee call-ups (7-day recency decay)"
            />
            <MethodRow
              title="Profit Margin"
              body="prioritizes profitable products when demand is healthy"
            />

            <div className="rounded-lg border border-border bg-background p-4 text-muted-foreground">
              For preliminary demo: Customer Conversation uses "Confirm order" button taps.
              Production version adds NLP detection (EN/Banglish/Bangla confirmation phrases) + payment method mentions.
              Stock Reduction uses old proxy; production adds trailing-14d units-sold tracking.
              Sports News uses static rubric; production adds event tracking.
            </div>
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

function MethodRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{body}</div>
    </div>
  );
}

function RelatedQueryList({
  title,
  icon,
  items,
  inventoryText,
  highlightOpportunities = false,
}: {
  title: string;
  icon: ReactNode;
  items: { query: string; value: number; score: number; bucket: "top" | "rising" }[];
  inventoryText: string[];
  highlightOpportunities?: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">
        {items.map((item) => {
          const stocked = queryMatchesInventory(item.query, inventoryText);
          const showOpportunity = highlightOpportunities && !stocked;
          return (
            <div
              key={`${title}-${item.query}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground/90">{item.query}</div>
                {showOpportunity && (
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
            No data yet.
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
