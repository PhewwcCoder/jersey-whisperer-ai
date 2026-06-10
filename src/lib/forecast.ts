import { getBestTrendForProduct, getTrendScoreForProduct, type LocalTrendSignal } from "./trend-signals";
import { computeNewsScore, type NewsEvent } from "./news-score";
import type { Product, TrendSignal, Variant } from "./types";

type UrgencyLabel =
  | "CRITICAL RESTOCK REQUIRED"
  | "MEDIUM REPLENISHMENT"
  | "HOLD STATUS";

export interface ForecastResult {
  product_id: string;
  product_name: string;
  team: string;
  typeLabel: string;
  sizeLabel: string;
  stock: number;
  recentInquiries: number;
  recentSales: number;
  demandSpikeScore: number;
  urgencyLabel: UrgencyLabel;
  urgencyColor: string;
  breakdown: {
    customerConversation: number;
    confirmedOrders: number;
    customerQuery: number;
    marketTrend: number;
    stockReductionVelocity: number;
    sportsNews: number;
    profitMargin: number;
    manualStar: number;
  };
  matchedTrendKeyword?: string;
  recommendation: string;
  marginPercent: number;
  score: number;
  demand: "No Action" | "Low" | "Medium" | "High" | "Spike";
  action: "Buy Now" | "Restock Soon" | "Preorder / Restock" | "Monitor" | "Promote" | "Hold";
  explanation: string;
  suggested_restock_quantity: number;
  priority_sizes: string[];
  query_count: number;
  trend_signal: TrendSignal;
  trend_reason: string;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function safeVariants(product: Product): Variant[] {
  if (!Array.isArray(product.variants)) return [];
  return product.variants.map((variant) => ({
    id: variant?.id ?? crypto.randomUUID(),
    size: variant?.size ?? "M",
    stock_quantity: Number.isFinite(variant?.stock_quantity) ? variant.stock_quantity : 0,
    low_stock_threshold: Number.isFinite(variant?.low_stock_threshold)
      ? variant.low_stock_threshold
      : 3,
    buy_price: Number.isFinite(variant?.buy_price) ? variant.buy_price : 0,
    selling_price: Number.isFinite(variant?.selling_price) ? variant.selling_price : 0,
    status: variant?.status ?? "Available",
    stocked_date: variant?.stocked_date,
    possible_restock_date: variant?.possible_restock_date,
    notes: variant?.notes,
  }));
}

function sumStock(variants: Variant[]) {
  return variants.reduce((total, variant) => total + Math.max(variant.stock_quantity, 0), 0);
}

function getAverageMargin(variants: Variant[]) {
  const valid = variants.filter((variant) => variant.selling_price > 0);
  if (!valid.length) return 0;
  const totalMargin = valid.reduce((sum, variant) => {
    return sum + (variant.selling_price - variant.buy_price) / variant.selling_price;
  }, 0);
  return clamp01(totalMargin / valid.length);
}

// Customer signal — ONE combined velocity score (the new DSS uses a single S_customer,
// not the old sOrder/sQuery split). Every event contributes a recency-decayed magnitude:
// a query = 1, a confirmed sale = its order quantity (>=1). Keeps the EXISTING logic:
// 14-day recency decay (lambda = ln2/14) + the saturating form raw/(raw + kappa) with
// kappa = median raw across the catalog. sOrder/sQuery are still computed separately,
// purely to populate the breakdown display.
// For DEMO: confirmed sale recorded when seller taps "Confirm order" button.
// TODO: production = NLP detect seller confirmation phrases (EN/Banglish/Bangla:
//       "confirmed","ok vai confirmed","apnar payment hoyeche","পেমেন্ট হয়েছে") +
//       bKash/Nagad mention, deduped to one confirmation per conversation thread.
// Defaults to 0 (no demand signal) if no events.
const CONV_LAMBDA = 0.0495; // ln(2) / 14

// Recency-decayed raw sum for a single bucket. `confirmed` selects which event type;
// events use their quantity (>=1) as magnitude when supplied; this lets Botpress
// distinct-customer counts participate in the same event-based scoring model.
function rawForBucket(events: Product["events"], confirmed: boolean, now: number): number {
  let raw = 0;
  for (const event of events ?? []) {
    if (confirmed ? event.type !== "confirmed_sale" : event.type !== "query") continue;
    const ageDays = (now - event.timestamp) / 86400000;
    const magnitude =
      Number.isFinite(event.quantity) && (event.quantity as number) > 0
        ? (event.quantity as number)
        : 1;
    raw += magnitude * Math.exp(-CONV_LAMBDA * ageDays);
  }
  return raw;
}

function medianOrDefault(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return med === 0 ? fallback : med;
}

function computeCustomerScores(
  product: Product,
  allProducts: Product[],
  now: number = Date.now(),
): { sOrder: number; sQuery: number } {
  const rawOrder = rawForBucket(product.events, true, now);
  const rawQuery = rawForBucket(product.events, false, now);

  // kappa = median raw across the catalog, per bucket (saturation point).
  const kappaOrder = medianOrDefault(
    allProducts.map((p) => rawForBucket(p.events, true, now)),
    5,
  );
  const kappaQuery = medianOrDefault(
    allProducts.map((p) => rawForBucket(p.events, false, now)),
    5,
  );

  return {
    sOrder: clamp01(rawOrder / (rawOrder + kappaOrder)),
    sQuery: clamp01(rawQuery / (rawQuery + kappaQuery)),
  };
}

// Combined recency-decayed velocity across BOTH event types (query + confirmed sale).
// This is the single S_customer the new composite scores (one factor, variable weight).
function rawCustomerVelocity(events: Product["events"], now: number): number {
  return rawForBucket(events, true, now) + rawForBucket(events, false, now);
}

function computeCustomerScore(
  product: Product,
  allProducts: Product[],
  now: number = Date.now(),
): number {
  const raw = rawCustomerVelocity(product.events, now);
  // kappa = median combined raw across the catalog (same saturation point logic).
  const kappa = medianOrDefault(
    allProducts.map((p) => rawCustomerVelocity(p.events, now)),
    5,
  );
  return clamp01(raw / (raw + kappa));
}

// A confirmed sale_event for the product flexes the customer weight 0.20 → 0.35
// (deterministic + demo-safe). Phrase-based chat confirmation is what WRITES these
// sale_events in production; the weight keys purely off their existence here.
function hasConfirmedPurchase(product: Product): boolean {
  return (product.events ?? []).some((event) => event.type === "confirmed_sale");
}

// Compute S_stock: stock-reduction urgency via days-of-supply, reacting to the RECENT
// sales rate. The fix: avg_daily_sales divides units sold by the number of days the
// product has ACTUALLY been selling (days_active), not a fixed 14 — so a product that
// just started moving ("sold 2 yesterday, 4 left") reads a real ~2/day velocity instead
// of being diluted to ~0 by the full window.
//   days_active     = max(1, min(WINDOW_DAYS, days_since_first_sale_in_window))
//   avg_daily_sales = units_sold_in_window / days_active
//   DoS             = stock_now / max(avg_daily_sales, ε)
//   S_stock         = clamp(1 - DoS / DOS_TARGET, 0, 1)   // DOS_TARGET = 14 (unchanged)
// No recent sales → avg_daily_sales 0 → DoS huge → S_stock 0 (nothing is depleting).
const STOCK_WINDOW_DAYS = 14;
const DOS_TARGET = 14;
const STOCK_EPSILON = 1e-6;

function computeStockReductionVelocity(product: Product, now: number = Date.now()) {
  const variants = safeVariants(product);
  const stock = sumStock(variants);

  const windowStart = now - STOCK_WINDOW_DAYS * 86400000;
  let unitsSold = 0;
  let firstSaleTs = Infinity;
  for (const event of product.events ?? []) {
    if (event.type !== "confirmed_sale") continue;
    if (event.timestamp < windowStart) continue;
    const qty =
      Number.isFinite(event.quantity) && (event.quantity as number) > 0
        ? (event.quantity as number)
        : 1;
    unitsSold += qty;
    if (event.timestamp < firstSaleTs) firstSaleTs = event.timestamp;
  }

  const daysSinceFirstSale =
    firstSaleTs === Infinity ? 0 : (now - firstSaleTs) / 86400000;
  const daysActive = Math.max(1, Math.min(STOCK_WINDOW_DAYS, daysSinceFirstSale));
  const avgDailySales = unitsSold / daysActive;
  const dos = stock / Math.max(avgDailySales, STOCK_EPSILON);
  return clamp01(1 - dos / DOS_TARGET);
}

function getDemandLabel(score: number): ForecastResult["demand"] {
  if (score >= 80) return "Spike";
  if (score >= 65) return "High";
  if (score >= 50) return "Medium";
  if (score >= 35) return "Low";
  return "No Action";
}

function getUrgency(score: number) {
  if (score >= 80) {
    return {
      label: "CRITICAL RESTOCK REQUIRED" as const,
      color: "bg-destructive/15 text-destructive border-destructive/30",
    };
  }
  if (score >= 65) {
    return {
      label: "MEDIUM REPLENISHMENT" as const,
      color: "bg-warning/15 text-warning-foreground border-warning/40",
    };
  }
  return {
    label: "HOLD STATUS" as const,
    color: "bg-muted text-muted-foreground border-border",
  };
}

function getPrioritySizes(variants: Variant[]) {
  const lowOrOut = variants.filter(
    (variant) => variant.stock_quantity <= Math.max(variant.low_stock_threshold, 3),
  );
  const base = lowOrOut.length ? lowOrOut : variants;
  return [...new Set(base.map((variant) => variant.size))];
}

function getAction(score: number, stock: number): ForecastResult["action"] {
  if (stock === 0) return "Preorder / Restock";
  if (score >= 80) return "Buy Now";
  if (score >= 65) return "Restock Soon";
  if (score >= 50) return "Monitor";
  if (score >= 35) return "Promote";
  return "Hold";
}

function inferTrendSignalFromScore(score: number): TrendSignal {
  if (score >= 0.85) return "High";
  if (score >= 0.65) return "Medium";
  if (score > 0.2) return "Low";
  return "None";
}

function estimateRecentSales(product: Product, recentInquiries: number, signals?: LocalTrendSignal[]) {
  const popularity = Number.isFinite(product.popularity_score)
    ? (product.popularity_score as number) / 100
    : 0.45;
  const marketTrend = getTrendScoreForProduct(product, signals);
  return Math.min(
    10,
    Math.max(0, Math.round(recentInquiries * 0.35 + popularity * 3 + marketTrend * 2)),
  );
}

function queryCount(product: Product): number {
  return Number.isFinite(product.query_count) ? Math.max(0, product.query_count as number) : 0;
}

function productWithQueryCountEvent(product: Product, now = Date.now()): Product {
  const recentInquiries = queryCount(product);
  if (recentInquiries <= 0) return product;

  const existingEvents = product.events ?? [];
  if (existingEvents.some((event) => event.type === "query")) return product;

  return {
    ...product,
    events: [
      ...existingEvents,
      {
        type: "query",
        timestamp: now,
        quantity: recentInquiries,
      },
    ],
  };
}

function getRecommendation(args: {
  score: number;
  stock: number;
  prioritySizes: string[];
  matchedTrendKeyword?: string;
}) {
  const trendSuffix = args.matchedTrendKeyword
    ? ` Search demand is clustering around "${args.matchedTrendKeyword}".`
    : "";

  if (args.stock === 0) {
    return `Restock before the next supplier cycle and keep preorder open.${trendSuffix}`;
  }
  if (args.score >= 80) {
    return `Restock before the next supplier cycle and keep preorder open.${trendSuffix}`;
  }
  if (args.score >= 65) {
    return `Restock soon, prioritizing ${args.prioritySizes.join("/") || "core sizes"} while demand stays active.${trendSuffix}`;
  }
  if (args.score >= 50) {
    return `Promote this week and monitor stock movement before placing a larger supplier order.${trendSuffix}`;
  }
  return `Hold stock for now and monitor demand before committing additional buying.${trendSuffix}`;
}

function getSuggestedRestockQuantity(score: number, stock: number) {
  if (score >= 80) return Math.max(12, 20 - stock);
  if (score >= 65) return Math.max(8, 14 - stock);
  if (score >= 50) return Math.max(6, 10 - stock);
  return Math.max(4, 6 - stock);
}

function buildReasons(
  score: ReturnType<typeof calculateDemandSpikeScore>,
  product: Product,
  stock: number,
) {
  const reasons: string[] = [];
  if (score.breakdown.customerConversation >= 0.6) {
    reasons.push("Customer conversation is active (queries + confirmed sales).");
  }
  if (score.breakdown.marketTrend >= 0.7) {
    reasons.push("Market trend demand is active in live SerpApi data.");
  }
  if (score.breakdown.stockReductionVelocity >= 0.7) {
    reasons.push("Stock reduction velocity indicates strong turnover.");
  }
  if (score.breakdown.sportsNews >= 0.7) {
    reasons.push("Sports/news attention is rising around this team/player.");
  }
  if (score.breakdown.profitMargin >= 0.5) {
    reasons.push("Profit margin is healthy enough to justify stronger focus.");
  }
  if (!reasons.length) {
    reasons.push(`Demand is steady for ${product.team_country_club}, but not urgent yet.`);
  }
  return reasons.slice(0, 3);
}

export function calculateDemandSpikeScore(
  product: Product,
  recentInquiries: number,
  recentSales: number,
  signals?: LocalTrendSignal[],
  allProducts: Product[] = [],
  newsEvents: NewsEvent[] = [],
) {
  const variants = safeVariants(product);
  const stock = sumStock(variants);
  const averageMargin = getAverageMargin(variants);
  const bestTrend = getBestTrendForProduct(product, signals);

  // DSS composite — six-weight model, NO normalization: DSS = 100 × Σ(wᵢ·Sᵢ).
  // The CUSTOMER weight flexes with purchase: 0.25 with no confirmed sale, 0.45 once a
  // confirmed sale exists. This makes "a purchase unlock the full range" — and it is
  // intentional:
  //   • confirmed purchase → weights sum to exactly 1.00 → max DSS 100
  //   • query-only         → weights sum to 0.80         → max DSS 80
  //   • no customer signal → max DSS ~55 (trend+stock+news+margin+rating only)
  // Frozen pieces are untouched: computeNewsScore, BASE_M, LAMBDA, tier lists.
  // Weight-sum check (on-purchase, customer-first tune):
  //   0.45 + 0.15 + 0.20 + 0.13 + 0.04 + 0.03 = 1.00
  //   (customer + trend + stock + news + margin + rating)
  const hasPurchase = hasConfirmedPurchase(product);
  const W_CUSTOMER = hasPurchase ? 0.45 : 0.25; // flexes with a confirmed sale_event
  const W_TREND = 0.15;
  const W_STOCK = 0.2;
  const W_NEWS = 0.13;
  const W_MARGIN = 0.04;
  const W_RATING = 0.03;

  const sCustomer = computeCustomerScore(product, allProducts);
  const { sOrder, sQuery } = computeCustomerScores(product, allProducts); // breakdown display only
  const sTrend = clamp01(getTrendScoreForProduct(product, signals));
  const sStock = computeStockReductionVelocity(product);
  const sNews = clamp01(computeNewsScore(product, newsEvents));
  const sMargin = clamp01(averageMargin / 0.5);
  const sRating = product.starRating ? clamp01(product.starRating / 5) : 0;

  const weighted =
    W_CUSTOMER * sCustomer +
    W_TREND * sTrend +
    W_STOCK * sStock +
    W_NEWS * sNews +
    W_MARGIN * sMargin +
    W_RATING * sRating;
  const demandSpikeScore = Math.round(weighted * 100); // no normalization — see comment above

  const urgency = getUrgency(demandSpikeScore);
  const prioritySizes = getPrioritySizes(variants);
  const recommendation = getRecommendation({
    score: demandSpikeScore,
    stock,
    prioritySizes,
    matchedTrendKeyword: bestTrend?.keyword,
  });

  return {
    demandSpikeScore,
    urgencyLabel: urgency.label,
    urgencyColor: urgency.color,
    breakdown: {
      // customerConversation = the single combined S_customer scored by the composite;
      // confirmedOrders / customerQuery stay as the split sub-buckets (display only).
      customerConversation: sCustomer,
      confirmedOrders: sOrder,
      customerQuery: sQuery,
      marketTrend: sTrend,
      stockReductionVelocity: sStock,
      sportsNews: sNews,
      profitMargin: sMargin,
      manualStar: sRating,
    },
    matchedTrendKeyword: bestTrend?.keyword,
    recommendation,
  };
}

export function forecastProduct(
  product: Product,
  signals?: LocalTrendSignal[],
  allProducts: Product[] = [],
  newsEvents: NewsEvent[] = [],
): ForecastResult {
  const variants = safeVariants(product);
  const stock = sumStock(variants);
  const recentInquiries = queryCount(product);
  const recentSales = estimateRecentSales(product, recentInquiries, signals);
  const now = Date.now();
  const scoringProduct = productWithQueryCountEvent(product, now);
  const scoringProducts = (allProducts.length ? allProducts : [product]).map((entry) =>
    productWithQueryCountEvent(entry, now),
  );
  const dss = calculateDemandSpikeScore(
    scoringProduct,
    recentInquiries,
    recentSales,
    signals,
    scoringProducts,
    newsEvents,
  );
  const bestTrend = getBestTrendForProduct(product, signals);
  const averageMargin = getAverageMargin(variants);
  const trendScore = getTrendScoreForProduct(product, signals);
  const action = getAction(dss.demandSpikeScore, stock);
  const suggestedRestockQuantity = getSuggestedRestockQuantity(dss.demandSpikeScore, stock);
  const sellerReasons = buildReasons(dss, product, stock);

  return {
    product_id: product.id,
    product_name: product.product_name,
    team: product.team_country_club,
    typeLabel: `${product.kit_type} / ${product.edition_type}`,
    sizeLabel: variants.map((variant) => variant.size).join(", ") || "-",
    stock,
    recentInquiries,
    recentSales,
    demandSpikeScore: dss.demandSpikeScore,
    urgencyLabel: dss.urgencyLabel,
    urgencyColor: dss.urgencyColor,
    breakdown: dss.breakdown,
    matchedTrendKeyword: dss.matchedTrendKeyword,
    recommendation: dss.recommendation,
    marginPercent: Math.round(averageMargin * 100),
    score: dss.demandSpikeScore,
    demand: getDemandLabel(dss.demandSpikeScore),
    action,
    explanation: sellerReasons.join(" "),
    suggested_restock_quantity: suggestedRestockQuantity,
    priority_sizes: getPrioritySizes(variants),
    query_count: recentInquiries,
    trend_signal: inferTrendSignalFromScore(trendScore),
    trend_reason:
      bestTrend?.explanation ||
      product.trend_reason ||
      "No cached Bangladesh trend snapshot matched this product.",
  };
}
