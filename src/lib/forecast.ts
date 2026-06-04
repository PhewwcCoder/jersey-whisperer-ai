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
    marketTrend: number;
    stockReductionVelocity: number;
    sportsNews: number;
    profitMargin: number;
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

function getStockReductionRate(stock: number) {
  if (stock === 0) return 1;
  if (stock <= 2) return 0.9;
  if (stock <= 5) return 0.7;
  if (stock <= 8) return 0.45;
  return 0.2;
}

// Compute S_customer: recency-weighted conversation score (queries + confirmed sales).
// RawC = sum of w * exp(-lambda * age_in_days)
//   w_query=1, w_confirmed_sale=6, lambda=0.0495 (14-day half-life: ln(2)/14)
// S_customer = RawC / (RawC + kappa), where kappa = median RawC across catalog.
// For DEMO: confirmed sale recorded when seller taps "Confirm order" button.
// TODO: production = NLP detect seller confirmation phrases (EN/Banglish/Bangla:
//       "confirmed","ok vai confirmed","apnar payment hoyeche","পেমেন্ট হয়েছে") +
//       bKash/Nagad mention.
// Defaults to 0 (no demand signal) if no events.
function computeCustomerConversationScore(
  product: Product,
  allProducts: Product[],
  now: number = Date.now(),
) {
  const LAMBDA = 0.0495; // ln(2) / 14
  const events = product.events ?? [];

  let rawC = 0;
  for (const event of events) {
    const ageMs = now - event.timestamp;
    const ageDays = ageMs / 86400000;
    const weight = event.type === "confirmed_sale" ? 6 : 1;
    rawC += weight * Math.exp(-LAMBDA * ageDays);
  }

  // Compute median rawC across all products
  const allRawCs = allProducts
    .map((p) => {
      const evts = p.events ?? [];
      let rc = 0;
      for (const e of evts) {
        const ageMs = now - e.timestamp;
        const ageDays = ageMs / 86400000;
        const w = e.type === "confirmed_sale" ? 6 : 1;
        rc += w * Math.exp(-LAMBDA * ageDays);
      }
      return rc;
    })
    .sort((a, b) => a - b);

  let kappa = 5; // default fallback
  if (allRawCs.length > 0) {
    const mid = Math.floor(allRawCs.length / 2);
    kappa = allRawCs.length % 2 === 0
      ? (allRawCs[mid - 1] + allRawCs[mid]) / 2
      : allRawCs[mid];
    if (kappa === 0) kappa = 5;
  }

  return clamp01(rawC / (rawC + kappa));
}

// Compute S_stock: stock reduction velocity (days-of-supply).
// avg_daily_depletion = units_sold_trailing_14d / 14
// DoS = stock_now / max(avg_daily_depletion, 1e-6)
// S_stock = clamp(1 - DoS/14, 0, 1)  [DoS_target = 14 days cover]
// Fallback to old proxy if units_sold unavailable.
function computeStockReductionVelocity(product: Product) {
  const variants = safeVariants(product);
  const stock = sumStock(variants);

  // TODO: production = track units_sold_trailing_14d from order history.
  // For DEMO: fall back to the old stock-reduction proxy.
  const oldReduction = getStockReductionRate(stock);
  return oldReduction;
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

  // New DSS model: DSS = 100 * (0.32*S_customer + 0.25*S_trend + 0.20*S_stock + 0.15*S_news + 0.08*S_margin)
  const sCustomer = computeCustomerConversationScore(product, allProducts);
  const sTrend = clamp01(getTrendScoreForProduct(product, signals));
  const sStock = computeStockReductionVelocity(product);
  const sNews = clamp01(computeNewsScore(product, newsEvents));
  const sMargin = clamp01(averageMargin / 0.5);

  const demandSpikeScore = Math.round(
    (0.32 * sCustomer + 0.25 * sTrend + 0.20 * sStock + 0.15 * sNews + 0.08 * sMargin) * 100,
  );

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
      customerConversation: sCustomer,
      marketTrend: sTrend,
      stockReductionVelocity: sStock,
      sportsNews: sNews,
      profitMargin: sMargin,
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
  const recentInquiries = Number.isFinite(product.query_count)
    ? (product.query_count as number)
    : 0;
  const recentSales = estimateRecentSales(product, recentInquiries, signals);
  const dss = calculateDemandSpikeScore(product, recentInquiries, recentSales, signals, allProducts, newsEvents);
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
