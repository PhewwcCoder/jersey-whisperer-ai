import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { forecastProduct } from "@/lib/forecast";
import { bdt } from "@/lib/inventory-utils";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { subscribeToTableChanges } from "@/lib/realtime";
import {
  applyJerseyInquiryCountsToProducts,
  fetchJerseyInquiryCounts,
} from "@/lib/supabase-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Boxes,
  Brain,
  CalendarClock,
  Clock,
  DollarSign,
  Flame,
  Layers,
  MessageSquareText,
  PackageX,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard - JerseyBecho AI" },
      { name: "description", content: "AI-powered inventory dashboard for jersey sellers." },
    ],
  }),
  component: DashboardPage,
});

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <Card className="overflow-hidden card-hover">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
            {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
          </div>
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent || "bg-primary/10 text-primary"}`}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  const t = useT();
  const { products, setProducts } = useStore();
  // Team name of the most recent live Botpress inquiry — drives the brief green
  // flash + "+1" badge on matching alert rows. Cleared after a short delay.
  const [inquiryFlashTeam, setInquiryFlashTeam] = useState<string | null>(null);
  const productsRef = useRef(products);
  productsRef.current = products;

  // Realtime: live inquiry counts (requires Realtime enabled on
  // public.jersey_inquiry_events — see src/lib/realtime.ts). Demo flow:
  // Messenger message → Botpress → /api/botpress-inquiry inserts a row →
  // this subscription fires → counts re-fetch → KPI/alert tiles update live.
  useEffect(() => {
    let flashTimer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToTableChanges(
      "jersey-inquiry-events-changes",
      "jersey_inquiry_events",
      (payload) => {
        if (payload.eventType !== "INSERT") return;

        const team = (payload.new as { team?: string | null })?.team;
        if (team) {
          setInquiryFlashTeam(team);
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => setInquiryFlashTeam(null), 2500);
        }

        // Re-pull aggregated counts and fold them into products so every
        // count-derived number on this page updates without a refresh.
        void fetchJerseyInquiryCounts().then((counts) => {
          if (!counts.length) return;
          const next = applyJerseyInquiryCountsToProducts(productsRef.current, counts);
          if (next !== productsRef.current) setProducts(next);
        });
      },
    );

    return () => {
      clearTimeout(flashTimer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    let totalUnits = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let preorder = 0;
    let restocking = 0;
    let invValue = 0;
    let profit = 0;

    for (const product of products) {
      for (const variant of product.variants) {
        totalUnits += variant.stock_quantity;
        invValue += variant.stock_quantity * variant.buy_price;
        profit += variant.stock_quantity * (variant.selling_price - variant.buy_price);
        if (variant.stock_quantity === 0 && variant.status === "Preorder") preorder++;
        else if (variant.stock_quantity === 0) outOfStock++;
        else if (variant.stock_quantity <= variant.low_stock_threshold) lowStock++;
        if (variant.possible_restock_date) restocking++;
      }
    }

    return { totalUnits, lowStock, outOfStock, preorder, restocking, invValue, profit };
  }, [products]);

  const dashboardSignals = useMemo(() => {
    let highDemandCount = 0;
    let restockAlertCount = 0;
    const topAlerts: ReturnType<typeof forecastProduct>[] = [];

    for (const product of products) {
      const forecast = forecastProduct(product);
      if (forecast.demandSpikeScore >= 65) highDemandCount += 1;
      if (["Buy Now", "Restock Soon", "Preorder / Restock"].includes(forecast.action)) {
        restockAlertCount += 1;
      }

      topAlerts.push(forecast);
      topAlerts.sort((left, right) => right.score - left.score);
      if (topAlerts.length > 3) topAlerts.pop();
    }

    const topTeams = [...new Set(topAlerts.map((forecast) => forecast.team))].slice(0, 2);
    return { highDemandCount, restockAlertCount, topAlerts, topTeams };
  }, [products]);

  return (
    <>
      <PageHeader
        title={t("Dashboard")}
        subtitle={t("24/7 AI inventory intelligence for jersey sellers")}
      />

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <ImpactCard
          icon={DollarSign}
          title={t("Revenue Impact Projection")}
          value="+15-30%"
          note={t("Projected uplift from AI-assisted replies and better demand-aware replenishment.")}
        />
        <ImpactCard
          icon={ShieldCheck}
          title={t("Inventory Stockout Reduction Target")}
          value="25%"
          note={t("Target reduction by using deterministic Demand Spike Score prioritization.")}
        />
        <ImpactCard
          icon={MessageSquareText}
          title={t("Conversion Rate Improvement")}
          value="24/7 AI Chat"
          note={t("Always-on reply coverage helps convert off-hour Messenger and WhatsApp leads.")}
        />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat icon={Boxes} label={t("Total products")} value={String(products.length)} />
        <Stat icon={Layers} label={t("Total stock units")} value={String(stats.totalUnits)} />
        <Stat
          icon={AlertTriangle}
          label={t("Low stock")}
          value={String(stats.lowStock)}
          accent="bg-warning/15 text-warning-foreground"
        />
        <Stat
          icon={PackageX}
          label={t("Out of stock")}
          value={String(stats.outOfStock)}
          accent="bg-destructive/10 text-destructive"
        />
        <Stat
          icon={Clock}
          label={t("Preorder")}
          value={String(stats.preorder)}
          accent="bg-info/15 text-info"
        />
        <Stat icon={CalendarClock} label={t("Expected restock")} value={String(stats.restocking)} />
        <Stat
          icon={Wallet}
          label={t("Inventory value")}
          value={bdt(stats.invValue)}
          accent="bg-primary/10 text-primary"
        />
        <Stat
          icon={TrendingUp}
          label={t("Potential profit")}
          value={bdt(stats.profit)}
          accent="bg-success/15 text-success"
        />
        <Stat
          icon={Flame}
          label={t("High demand")}
          value={String(dashboardSignals.highDemandCount)}
          accent="bg-accent text-accent-foreground"
        />
        <Stat
          icon={Brain}
          label={t("AI restock alerts")}
          value={String(dashboardSignals.restockAlertCount)}
          accent="bg-primary/10 text-primary"
        />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Brain className="h-4 w-4" />
              </div>
              <div>
                <div className="font-semibold">{t("Today's AI Business Alerts")}</div>
                <div className="text-xs text-muted-foreground">
                  {t(
                    "Demand score insights generated from trend signals, stock levels, and live selling pressure",
                  )}
                </div>
              </div>
            </div>
            <ul className="space-y-2">
              {dashboardSignals.topAlerts.map((forecast) => {
                // Brief green flash + "+1" chip when a live inquiry just arrived
                // for this row's team (simple CSS transition, reverts on clear).
                const justInquired = inquiryFlashTeam !== null && forecast.team === inquiryFlashTeam;
                return (
                  <li
                    key={forecast.product_id}
                    className={`flex items-start gap-3 rounded-md border p-3 transition-colors duration-700 ${
                      justInquired
                        ? "border-success/60 bg-success/15"
                        : "border-border bg-muted/30"
                    }`}
                  >
                    <Badge variant="outline" className={forecast.urgencyColor}>
                      {forecast.action}
                    </Badge>
                    <div className="flex-1 text-sm text-foreground/90">
                      <span className="font-medium">{forecast.product_name}</span> - {forecast.explanation}
                    </div>
                    {justInquired && (
                      <span className="rounded-full bg-success/20 px-2 py-0.5 text-xs font-semibold text-success">
                        +1
                      </span>
                    )}
                    <span className="text-xs font-mono text-muted-foreground">
                      {forecast.demandSpikeScore}/100
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-gradient-to-br from-primary/10 via-background to-accent/10">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Flame className="h-4 w-4 text-primary" />
              <div className="font-semibold text-foreground">{t("Today's Selling Signals")}</div>
            </div>
            <div className="grid gap-3">
              <SignalTile
                title={t("Market Demand")}
                body={
                  dashboardSignals.topTeams.length > 1
                    ? `${dashboardSignals.topTeams.join(" and ")} kits are trending in BD searches this week.`
                    : t("Football jersey demand is active in BD searches this week.")
                }
              />
              <SignalTile
                title={t("Stock Pressure")}
                body={`${stats.lowStock} variants are low stock and need attention before match-day demand spikes.`}
              />
              <SignalTile
                title={t("Restock Priority")}
                body={`${dashboardSignals.restockAlertCount} products need AI restock attention based on demand score signals.`}
              />
              <SignalTile
                title={t("Conversion Opportunity")}
                body={t("24/7 chat can capture late-night football buyers when the seller is offline.")}
              />
            </div>
            <div className="mt-4">
              <Button asChild>
                <Link to="/forecast">{t("Open Forecast")}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="mb-1 font-semibold">Inventory-first AI architecture</div>
          <p className="mb-3 text-xs text-muted-foreground">
            JerseyBecho AI checks structured stock data first, uses demand signals to score restock
            pressure, and helps sellers respond faster to real customer intent.
          </p>
          <ol className="grid gap-2 text-xs text-muted-foreground md:grid-cols-7">
            {[
              "Customer Message",
              "Entity Detection",
              "Inventory Match",
              "Safe Reply",
              "Demand Signal",
              "Forecast Score",
              "Restock Action",
            ].map((step, index) => (
              <li key={step} className="rounded-md border border-border bg-background p-2">
                <div className="text-[10px] font-semibold text-primary">STEP {index + 1}</div>
                {step}
              </li>
            ))}
          </ol>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-5">
            {[
              "Reduce late replies",
              "Reduce stockout risk",
              "Improve restock decisions",
              "Convert more Messenger leads",
              "Keep the demo fully stable",
            ].map((point) => (
              <div
                key={point}
                className="rounded-md bg-primary/5 px-3 py-2 font-medium text-primary"
              >
                + {point}
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <Link to="/query-sim" className="text-sm text-primary underline">
              Try the AI query simulator {"->"}
            </Link>
            <Link to="/forecast" className="text-sm text-primary underline">
              See forecasts {"->"}
            </Link>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function ImpactCard({
  icon: Icon,
  title,
  value,
  note,
}: {
  icon: any;
  title: string;
  value: string;
  note: string;
}) {
  return (
    <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-background to-accent/10">
      <CardContent className="p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{title}</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </CardContent>
    </Card>
  );
}

function SignalTile({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/80 p-3">
      <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="text-sm text-foreground/90">{body}</div>
    </div>
  );
}
