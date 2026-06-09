import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { forecastProduct } from "@/lib/forecast";
import { useStore } from "@/lib/store";
import type { Product } from "@/lib/types";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Flame,
  Megaphone,
  PackageOpen,
  PackageX,
  Pencil,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/ai-advisor")({
  head: () => ({ meta: [{ title: "AI Stock Advisor - JerseyBecho AI" }] }),
  component: AdvisorPage,
});

type Priority = "High" | "Medium" | "Low";
type AdvisorFilter = "All" | "High Priority" | "Restock" | "Promote" | "Hold" | "Reviewed";
type RecommendationType =
  | "out_of_stock"
  | "preorder"
  | "low_stock"
  | "high_margin"
  | "promote"
  | "hold";

interface AdvisorRecommendation {
  id: string;
  productId: string;
  productName: string;
  sizeLabel: string;
  reason: string;
  urgency: Priority;
  action: string;
  impact: string;
  type: RecommendationType;
  currentStock: number;
  recentInquiries: number;
  trendSignal: string;
  marginPercent: number;
  nextStep: string;
}

function averageMargin(product: Product) {
  if (!product.variants.length) return 0;
  const valid = product.variants.filter((variant) => variant.selling_price > 0);
  if (!valid.length) return 0;
  return (
    valid.reduce(
      (sum, variant) => sum + (variant.selling_price - variant.buy_price) / variant.selling_price,
      0,
    ) / valid.length
  );
}

function getPriorityStyles(priority: Priority) {
  if (priority === "High") {
    return {
      badge: "bg-destructive/10 text-destructive border-destructive/30",
      card: "border-destructive/35 bg-destructive/5 shadow-md hover:shadow-xl hover:-translate-y-1",
      accent: "bg-destructive",
    };
  }
  if (priority === "Medium") {
    return {
      badge: "bg-warning/15 text-warning-foreground border-warning/40",
      card: "border-warning/25 bg-warning/5 shadow-sm hover:shadow-lg hover:-translate-y-0.5",
      accent: "bg-warning",
    };
  }
  return {
    badge: "bg-muted text-muted-foreground border-border",
    card: "border-border bg-background shadow-sm hover:shadow-md hover:-translate-y-0.5",
    accent: "bg-muted-foreground/40",
  };
}

function getTypeLabel(type: RecommendationType) {
  switch (type) {
    case "out_of_stock":
      return "Out of stock";
    case "preorder":
      return "Preorder";
    case "low_stock":
      return "Restock";
    case "high_margin":
      return "High margin";
    case "promote":
      return "Promote";
    default:
      return "Hold";
  }
}

function getRecommendationIcon(type: RecommendationType) {
  switch (type) {
    case "out_of_stock":
    case "preorder":
      return PackageX;
    case "low_stock":
      return AlertTriangle;
    case "high_margin":
      return Wallet;
    case "promote":
      return Megaphone;
    case "hold":
      return Clock3;
    default:
      return PackageOpen;
  }
}

function matchesFilter(
  recommendation: AdvisorRecommendation,
  filter: AdvisorFilter,
  reviewed: boolean,
) {
  if (filter === "All") return true;
  if (filter === "Reviewed") return reviewed;
  if (filter === "High Priority") return recommendation.urgency === "High" && !reviewed;
  if (filter === "Restock") {
    return ["out_of_stock", "preorder", "low_stock"].includes(recommendation.type) && !reviewed;
  }
  if (filter === "Promote") {
    return ["promote", "high_margin"].includes(recommendation.type) && !reviewed;
  }
  if (filter === "Hold") return recommendation.type === "hold" && !reviewed;
  return true;
}

function AdvisorPage() {
  const { products } = useStore();
  const [activeFilter, setActiveFilter] = useState<AdvisorFilter>("All");
  const [reviewedIds, setReviewedIds] = useState<Record<string, boolean>>({});
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const recommendations = useMemo<AdvisorRecommendation[]>(() => {
    const output: AdvisorRecommendation[] = [];

    for (const product of products) {
      const forecast = forecastProduct(product);
      const margin = averageMargin(product);
      let productHasUrgentStockSignal = false;

      for (const variant of product.variants) {
        const sizeLabel = variant.size;
        const recommendationId = `${product.id}-${variant.id}`;

        if (variant.stock_quantity === 0 && variant.status === "Preorder") {
          productHasUrgentStockSignal = true;
          output.push({
            id: `${recommendationId}-preorder`,
            productId: product.id,
            productName: product.product_name,
            sizeLabel,
            reason: `Out of stock — keep preorder open and notify supplier.`,
            urgency: "High",
            action: "Keep preorder open and notify interested buyers.",
            impact: "Capture buyer interest even when the next shipment has not landed yet.",
            type: "preorder",
            currentStock: variant.stock_quantity,
            recentInquiries: forecast.recentInquiries,
            trendSignal: product.trend_signal,
            marginPercent: Math.round(margin * 100),
            nextStep: `Confirm supplier timing and keep ${sizeLabel} buyers updated.`,
          });
          continue;
        }

        if (variant.stock_quantity === 0) {
          productHasUrgentStockSignal = true;
          output.push({
            id: `${recommendationId}-out`,
            productId: product.id,
            productName: product.product_name,
            sizeLabel,
            reason: "Out of stock — buyers may leave without placing an order.",
            urgency: "High",
            action: "Open preorder and notify supplier today.",
            impact: "Reduces lost sales when buyers ask for this size and find nothing available.",
            type: "out_of_stock",
            currentStock: variant.stock_quantity,
            recentInquiries: forecast.recentInquiries,
            trendSignal: product.trend_signal,
            marginPercent: Math.round(margin * 100),
            nextStep: `Reopen demand capture for ${sizeLabel} and line up supplier confirmation.`,
          });
          continue;
        }

        if (variant.stock_quantity <= Math.max(variant.low_stock_threshold, 3)) {
          productHasUrgentStockSignal = true;
          const lowStockReason =
            variant.stock_quantity <= 1
              ? `Only ${variant.stock_quantity} pc left — restock before demand peaks.`
              : variant.stock_quantity <= 2
                ? `Only ${variant.stock_quantity} pcs left — high chance of missed sales.`
                : "Stock is running low — buyers may not find their size soon.";

          output.push({
            id: `${recommendationId}-low`,
            productId: product.id,
            productName: product.product_name,
            sizeLabel,
            reason: lowStockReason,
            urgency: forecast.breakdown.marketTrend >= 0.7 || forecast.recentInquiries >= 8 ? "High" : "Medium",
            action:
              forecast.breakdown.marketTrend >= 0.7 || forecast.recentInquiries >= 8
                ? `Restock ${forecast.suggested_restock_quantity} pcs before next supplier cycle.`
                : `Restock ${Math.max(6, forecast.suggested_restock_quantity - 4)} pcs soon to avoid missed demand.`,
            impact: "Keeps fast-moving sizes available when customers are ready to buy.",
            type: "low_stock",
            currentStock: variant.stock_quantity,
            recentInquiries: forecast.recentInquiries,
            trendSignal: product.trend_signal,
            marginPercent: Math.round(margin * 100),
            nextStep: `Top up ${sizeLabel} before search demand moves buyers to competitors.`,
          });
        }
      }

      if (forecast.action === "Promote" || (forecast.breakdown.marketTrend >= 0.72 && forecast.stock > 5)) {
        output.push({
          id: `${product.id}-promote`,
          productId: product.id,
          productName: product.product_name,
          sizeLabel: forecast.sizeLabel,
          reason: "High demand signal — this product is worth pushing harder this week.",
          urgency: forecast.breakdown.marketTrend >= 0.8 ? "High" : "Medium",
          action: "Promote this product this week while demand is rising.",
          impact: "Turns current football buzz into faster sell-through and stronger chat conversions.",
          type: "promote",
          currentStock: forecast.stock,
          recentInquiries: forecast.recentInquiries,
          trendSignal: product.trend_signal,
          marginPercent: Math.round(margin * 100),
          nextStep: "Push social posts, highlight available sizes, and reply fast to buyer messages.",
        });
      }

      if (
        product.manufacturing_type === "Imported" &&
        product.edition_type === "Player Edition" &&
        margin > 0.25
      ) {
        output.push({
          id: `${product.id}-margin`,
          productId: product.id,
          productName: product.product_name,
          sizeLabel: forecast.sizeLabel,
          reason: "High-margin product — prioritize this in your next supplier order.",
          urgency: forecast.demandSpikeScore >= 65 ? "Medium" : "Low",
          action: "Prioritize this item in your next supplier order and bundle with related jerseys.",
          impact: "Improves profit per order when buyers choose premium editions.",
          type: "high_margin",
          currentStock: forecast.stock,
          recentInquiries: forecast.recentInquiries,
          trendSignal: product.trend_signal,
          marginPercent: Math.round(margin * 100),
          nextStep: "Reserve budget for premium restock and pair it with strong-performing team demand.",
        });
      }

      if (!productHasUrgentStockSignal && forecast.demandSpikeScore < 55) {
        output.push({
          id: `${product.id}-hold`,
          productId: product.id,
          productName: product.product_name,
          sizeLabel: forecast.sizeLabel,
          reason: "Demand is steady for now, so extra stock is not urgent.",
          urgency: "Low",
          action: "Hold stock for now; demand is not strong enough.",
          impact: "Protects cash flow by avoiding overbuying before demand becomes clearer.",
          type: "hold",
          currentStock: forecast.stock,
          recentInquiries: forecast.recentInquiries,
          trendSignal: product.trend_signal,
          marginPercent: Math.round(margin * 100),
          nextStep: "Monitor search demand and chat inquiries before the next purchase cycle.",
        });
      }
    }

    return output.sort((left, right) => {
      const order = { High: 0, Medium: 1, Low: 2 };
      return order[left.urgency] - order[right.urgency];
    });
  }, [products]);

  const filteredRecommendations = recommendations.filter((recommendation) =>
    matchesFilter(recommendation, activeFilter, Boolean(reviewedIds[recommendation.id])),
  );

  const summary = useMemo(() => {
    const activeRecommendations = recommendations.filter((recommendation) => !reviewedIds[recommendation.id]);
    return {
      urgent: activeRecommendations.filter((recommendation) => recommendation.urgency === "High").length,
      restock: activeRecommendations.filter((recommendation) =>
        ["out_of_stock", "preorder", "low_stock"].includes(recommendation.type),
      ).length,
      promote: activeRecommendations.filter((recommendation) =>
        ["promote", "high_margin"].includes(recommendation.type),
      ).length,
      hold: activeRecommendations.filter((recommendation) => recommendation.type === "hold").length,
    };
  }, [recommendations, reviewedIds]);

  return (
    <>
      <PageHeader
        title="AI Stock Advisor"
        subtitle="Actionable restock, promotion, and inventory alerts based on your products and demand signals."
      />

      <Card className="mb-4 border-accent/40 bg-accent/5">
        <CardContent className="flex items-start gap-3 p-4">
          <Brain className="mt-0.5 h-5 w-5 text-primary" />
          <div className="text-sm">
            <div className="font-semibold text-foreground">Seller-ready inventory guidance</div>
            <div className="text-muted-foreground">
              Your AI advisor reviews stock, margin, customer interest, and demand signals to suggest
              what to restock, promote, or hold — without guessing prices or inventing products.
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile title="Urgent actions" value={summary.urgent} accent="bg-destructive/10 text-destructive border-destructive/20" />
        <SummaryTile title="Restock soon" value={summary.restock} accent="bg-warning/10 text-warning-foreground border-warning/30" />
        <SummaryTile title="Promote this week" value={summary.promote} accent="bg-primary/10 text-primary border-primary/20" />
        <SummaryTile title="Safe to hold" value={summary.hold} accent="bg-muted text-muted-foreground border-border" />
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {(["All", "High Priority", "Restock", "Promote", "Hold", "Reviewed"] as AdvisorFilter[]).map(
          (filter) => (
            <Button
              key={filter}
              type="button"
              size="sm"
              variant={activeFilter === filter ? "default" : "outline"}
              className="transition-all duration-200 hover:scale-[1.02]"
              onClick={() => setActiveFilter(filter)}
            >
              {filter}
            </Button>
          ),
        )}
      </div>

      <div className="grid gap-4">
        {filteredRecommendations.map((recommendation) => {
          const reviewed = Boolean(reviewedIds[recommendation.id]);
          const expanded = Boolean(expandedIds[recommendation.id]);
          const Icon = getRecommendationIcon(recommendation.type);
          const priorityStyles = getPriorityStyles(recommendation.urgency);

          return (
            <Card
              key={recommendation.id}
              className={`relative overflow-hidden border transition-all duration-200 ${priorityStyles.card} ${reviewed ? "opacity-70" : ""}`}
            >
              <div className={`absolute inset-y-0 left-0 w-1 ${reviewed ? "bg-success" : priorityStyles.accent}`} />
              <CardContent className="p-4">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                  <div className="flex min-w-[160px] items-start gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-background shadow-sm">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="space-y-2">
                      <Badge
                        variant="outline"
                        className={
                          reviewed
                            ? "border-success/30 bg-success/10 text-success"
                            : priorityStyles.badge
                        }
                      >
                        {reviewed ? "Reviewed" : recommendation.urgency}
                      </Badge>
                      <div className="text-xs uppercase tracking-wider text-muted-foreground">
                        {getTypeLabel(recommendation.type)}
                      </div>
                    </div>
                  </div>

                  <div className="grid flex-1 gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                    <div className="space-y-3">
                      <div>
                        <div className="text-lg font-semibold text-foreground">
                          {recommendation.productName}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Size: {recommendation.sizeLabel}
                        </div>
                      </div>

                      <div className="grid gap-3 text-sm md:grid-cols-3">
                        <InfoBlock label="Reason" value={recommendation.reason} />
                        <InfoBlock label="Suggested action" value={recommendation.action} accent />
                        <InfoBlock label="Business impact" value={recommendation.impact} />
                      </div>

                      <div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="px-0 text-primary transition-all duration-200 hover:scale-[1.02] hover:bg-transparent"
                          onClick={() =>
                            setExpandedIds((current) => ({
                              ...current,
                              [recommendation.id]: !current[recommendation.id],
                            }))
                          }
                        >
                          {expanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
                          {expanded ? "Hide details" : "Why?"}
                        </Button>
                        {expanded && (
                          <div className="mt-2 rounded-lg border border-border bg-background/80 p-3 text-sm text-foreground/90">
                            <div className="mb-2 font-medium">Why this matters</div>
                            <div className="mb-3 text-muted-foreground">
                              {recommendation.productName} {recommendation.sizeLabel !== "-" ? `${recommendation.sizeLabel}` : ""}
                              {" "}has {recommendation.currentStock} pcs available while customer interest is at {recommendation.recentInquiries} recent inquiries. If this item slips out of stock, buyers may leave without ordering.
                            </div>
                            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
                              <DetailPill label="Current stock" value={`${recommendation.currentStock} pcs`} />
                              <DetailPill label="Customer interest" value={`${recommendation.recentInquiries} inquiries`} />
                              <DetailPill label="Trend signal" value={recommendation.trendSignal} />
                              <DetailPill label="Margin" value={`${recommendation.marginPercent}%`} />
                              <DetailPill label="Next step" value={recommendation.nextStep} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 xl:items-end">
                      <Button
                        asChild
                        size="sm"
                        className="w-full transition-all duration-200 hover:scale-[1.02] xl:w-[160px]"
                      >
                        <Link to="/inventory">View Product</Link>
                      </Button>
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="w-full transition-all duration-200 hover:scale-[1.02] xl:w-[160px]"
                      >
                        <Link to="/inventory">
                          <Pencil className="mr-1 h-4 w-4" /> Edit Stock
                        </Link>
                      </Button>
                      <Button
                        type="button"
                        variant={reviewed ? "secondary" : "outline"}
                        size="sm"
                        className="w-full transition-all duration-200 hover:scale-[1.02] xl:w-[160px]"
                        onClick={() =>
                          setReviewedIds((current) =>
                            current[recommendation.id]
                              ? current
                              : { ...current, [recommendation.id]: true },
                          )
                        }
                        disabled={reviewed}
                      >
                        {reviewed ? "Reviewed" : "Mark Reviewed"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full transition-all duration-200 hover:scale-[1.02] xl:w-[160px]"
                        onClick={async () => {
                          const note = `${recommendation.productName} (${recommendation.sizeLabel}) - ${recommendation.action}`;
                          try {
                            await navigator.clipboard.writeText(note);
                            toast.success("Supplier note copied");
                          } catch {
                            toast.error("Could not copy supplier note");
                          }
                        }}
                      >
                        <Copy className="mr-1 h-4 w-4" /> Copy Supplier Note
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {filteredRecommendations.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No advisor cards match this filter right now.
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function SummaryTile({
  title,
  value,
  accent,
}: {
  title: string;
  value: number;
  accent: string;
}) {
  return (
    <Card className={`border ${accent}`}>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider">{title}</div>
        <div className="mt-2 text-3xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function InfoBlock({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={accent ? "font-medium text-primary" : "text-foreground/90"}>{value}</div>
    </div>
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-[12px] text-foreground">{value}</div>
    </div>
  );
}
