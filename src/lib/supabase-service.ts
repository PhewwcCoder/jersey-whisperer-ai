import type { ForecastResult } from "./forecast";
import { forecastProduct } from "./forecast";
import { seedProducts } from "./seed-data";
import { getSupabaseClient } from "./supabase";
import {
  emptyMarketDiscovery,
  scoreRising,
  scoreTop,
  type MarketDiscovery,
} from "./market-signals";
import { localTrendSignals, type LocalTrendSignal } from "./trend-signals";
import type { Product, Variant } from "./types";

const STORAGE_KEY = "jerseybecho_products_v4";

export interface StoredTrendSignal extends LocalTrendSignal {
  id?: string;
  source?: string;
  fetched_at?: string;
}

export interface SemanticSearchHit {
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface JerseyInquiryCount {
  jersey_key: string;
  team: string;
  player: string | null;
  jersey_type: string | null;
  season: string | null;
  mentions: number;
  distinct_customers: number;
  last_asked_at: string | null;
}

type ProductRow = {
  id: string;
  team: string;
  type: string | null;
  size: string | null;
  stock: number | null;
  wholesale_cost: number | null;
  retail_price: number | null;
  inquiries_7d: number | null;
  sales_7d: number | null;
  created_at: string | null;
};

// Max wait before a Supabase call falls back to demo/empty. 5s tolerates cold-start
// latency on the live Vercel site (the first call also pays the dynamic supabase-js
// import + BD→Supabase round-trip); 1.8s was tripping the mount fetches.
const SUPABASE_TIMEOUT_MS = 5000;

async function withSupabaseTimeout<T>(
  label: string,
  operation: () => Promise<T>,
  fallback: T,
  timeoutMs = SUPABASE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.warn(`[Supabase] ${label} skipped`, error);
    return fallback;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeCount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function safeVariants(product: Product): Variant[] {
  return Array.isArray(product.variants) ? product.variants : [];
}

function sanitizeProduct(candidate: Partial<Product> & { id?: string }): Product {
  return {
    id: candidate.id ?? crypto.randomUUID(),
    product_name: candidate.product_name ?? "Imported product",
    team_country_club: candidate.team_country_club ?? "Unknown",
    player_name: candidate.player_name ?? "",
    font_name: candidate.font_name ?? "",
    has_print: candidate.has_print ?? true,
    patch_available: candidate.patch_available ?? false,
    season_year: typeof candidate.season_year === "number" ? candidate.season_year : 2026,
    kit_type: candidate.kit_type ?? "Home",
    edition_type: candidate.edition_type ?? "Player Edition",
    manufacturing_type: candidate.manufacturing_type ?? "Imported",
    source_country: candidate.source_country ?? "Thailand",
    supplier_name: candidate.supplier_name ?? "",
    product_image_url: candidate.product_image_url ?? "",
    trend_signal: candidate.trend_signal ?? "None",
    trend_reason: candidate.trend_reason ?? "",
    popularity_score: safeNumber(candidate.popularity_score, 60),
    query_count: safeNumber(candidate.query_count, 0),
    baseline_query_count:
      typeof candidate.baseline_query_count === "number" &&
      Number.isFinite(candidate.baseline_query_count)
        ? Math.max(0, candidate.baseline_query_count)
        : undefined,
    // CustomerEvents (query / confirmed_sale) drive S_customer and stock
    // reduction velocity in the DSS — dropping them here would reset live
    // scores on every Supabase refetch.
    events: Array.isArray(candidate.events)
      ? candidate.events.filter(
          (event) =>
            (event?.type === "query" ||
              event?.type === "confirmed_sale" ||
              event?.type === "restock") &&
            Number.isFinite(event?.timestamp),
        )
      : undefined,
    created_at: candidate.created_at ?? new Date().toISOString(),
    variants: Array.isArray(candidate.variants) && candidate.variants.length
      ? candidate.variants
      : [
          {
            id: crypto.randomUUID(),
            size: "M",
            stock_quantity: 0,
            low_stock_threshold: 3,
            buy_price: 0,
            selling_price: 0,
            status: "Available",
          },
        ],
  };
}

function normalizeDemandText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countDemand(count: JerseyInquiryCount): number {
  return safeCount(count.distinct_customers || count.mentions);
}

function seasonMatches(product: Product, season: string | null): boolean {
  if (!season) return true;
  const year = /\b(19|20)\d{2}\b/.exec(season)?.[0];
  if (!year) return true;
  return String(product.season_year) === year;
}

function playerMatches(product: Product, player: string | null): boolean {
  if (!player) return true;
  const playerNeedle = normalizeDemandText(player);
  if (!playerNeedle) return true;
  const productText = normalizeDemandText(
    [product.player_name, product.font_name, product.product_name].filter(Boolean).join(" "),
  );
  return productText.includes(playerNeedle);
}

function jerseyTypeMatches(product: Product, jerseyType: string | null): boolean {
  if (!jerseyType) return true;
  return normalizeDemandText(product.kit_type) === normalizeDemandText(jerseyType);
}

function countMatchesProduct(product: Product, count: JerseyInquiryCount): boolean {
  if (normalizeDemandText(product.team_country_club) !== normalizeDemandText(count.team)) {
    return false;
  }
  return (
    playerMatches(product, count.player) &&
    jerseyTypeMatches(product, count.jersey_type) &&
    seasonMatches(product, count.season)
  );
}

function inquiryCountForProduct(product: Product, counts: JerseyInquiryCount[]): number {
  return counts.reduce((sum, count) => {
    if (!countMatchesProduct(product, count)) return sum;
    return sum + countDemand(count);
  }, 0);
}

export function applyJerseyInquiryCountsToProducts(
  products: Product[],
  counts: JerseyInquiryCount[],
): Product[] {
  if (!counts.length) return products;

  let changed = false;
  const next = products.map((product) => {
    const botpressCount = inquiryCountForProduct(product, counts);
    if (botpressCount <= 0) return product;

    // Live Botpress inquiries ADD to the seeded demand baseline instead of
    // replacing it. Replacement made the FIRST real inquiry for a team CRASH
    // its score: seeded query_count (e.g. Bangladesh 6) was overwritten with
    // the live count (1), wiping the customer signal. The baseline is captured
    // once from the pre-Botpress query_count and persisted, so re-applies stay
    // idempotent and every new inquiry strictly increases the count.
    const baseline = safeCount(product.baseline_query_count ?? product.query_count);
    const nextCount = baseline + botpressCount;
    if (product.baseline_query_count !== undefined && safeCount(product.query_count) === nextCount) {
      return product;
    }

    changed = true;
    return {
      ...product,
      baseline_query_count: baseline,
      query_count: nextCount,
    };
  });

  return changed ? next : products;
}

function readProductsFromBrowserStorage() {
  if (typeof window === "undefined") return seedProducts;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedProducts;
    const parsed = JSON.parse(raw) as Product[];
    return Array.isArray(parsed) ? parsed.map((product) => sanitizeProduct(product)) : seedProducts;
  } catch {
    return seedProducts;
  }
}

// DSS scoring reads CustomerEvents inside a 14-day window; persist the recent
// ones (30d, capped) in the type JSON so live score inputs survive a Supabase
// round-trip (realtime refetch, page reload, other devices).
const EVENT_RETENTION_DAYS = 30;
const EVENT_RETENTION_MAX = 100;

function recentCustomerEvents(product: Product) {
  const cutoff = Date.now() - EVENT_RETENTION_DAYS * 86400000;
  return (product.events ?? [])
    .filter((event) => Number.isFinite(event.timestamp) && event.timestamp >= cutoff)
    .slice(-EVENT_RETENTION_MAX);
}

function summarizeProductForStorage(product: Product) {
  const variants = safeVariants(product);
  const sizes = variants.map((variant) => variant.size).join(", ");
  const buyValues = variants.map((variant) => variant.buy_price);
  const sellValues = variants.map((variant) => variant.selling_price);
  const totalStock = variants.reduce((sum, variant) => sum + Math.max(variant.stock_quantity, 0), 0);

  return {
    id: product.id,
    team: product.team_country_club,
    type: JSON.stringify({
      product_name: product.product_name,
      team_country_club: product.team_country_club,
      player_name: product.player_name,
      font_name: product.font_name,
      has_print: product.has_print,
      patch_available: product.patch_available,
      season_year: product.season_year,
      kit_type: product.kit_type,
      edition_type: product.edition_type,
      manufacturing_type: product.manufacturing_type,
      source_country: product.source_country,
      supplier_name: product.supplier_name,
      product_image_url: product.product_image_url,
      trend_signal: product.trend_signal,
      trend_reason: product.trend_reason,
      popularity_score: product.popularity_score,
      query_count: product.query_count,
      baseline_query_count: product.baseline_query_count,
      events: recentCustomerEvents(product),
      created_at: product.created_at,
      variants: product.variants,
    }),
    size: sizes || null,
    stock: totalStock,
    wholesale_cost: average(buyValues),
    retail_price: average(sellValues),
    inquiries_7d: safeNumber(product.query_count, 0),
    sales_7d: forecastProduct(product).recentSales,
    created_at: product.created_at,
  };
}

function parseProductRow(row: ProductRow): Product {
  if (row.type) {
    try {
      const parsed = JSON.parse(row.type) as Partial<Product>;
      return sanitizeProduct({
        ...parsed,
        id: row.id,
        team_country_club: parsed.team_country_club ?? row.team,
        created_at: parsed.created_at ?? row.created_at ?? new Date().toISOString(),
      });
    } catch {
      // Fall through to minimal reconstruction.
    }
  }

  const size = (row.size?.split(",")[0]?.trim() || "M") as Variant["size"];
  return sanitizeProduct({
    id: row.id,
    product_name: `${row.team} Jersey`,
    team_country_club: row.team,
    created_at: row.created_at ?? new Date().toISOString(),
    query_count: safeNumber(row.inquiries_7d, 0),
    variants: [
      {
        id: crypto.randomUUID(),
        size,
        stock_quantity: safeNumber(row.stock, 0),
        low_stock_threshold: 3,
        buy_price: safeNumber(row.wholesale_cost, 0),
        selling_price: safeNumber(row.retail_price, 0),
        status: safeNumber(row.stock, 0) === 0 ? "Out of Stock" : "Available",
      },
    ],
  });
}

function buildProductEmbeddingContent(product: Product) {
  const variants = safeVariants(product);
  return [
    product.product_name,
    product.team_country_club,
    product.player_name,
    product.font_name,
    product.kit_type,
    product.edition_type,
    product.manufacturing_type,
    product.source_country,
    variants.map((variant) => `${variant.size} stock ${variant.stock_quantity}`).join(" "),
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildTrendEmbeddingContent(trendSignal: StoredTrendSignal) {
  return [
    trendSignal.keyword,
    trendSignal.geo,
    trendSignal.channel,
    trendSignal.language,
    trendSignal.momentum,
    trendSignal.matchedTeam,
    trendSignal.matchedPlayer,
    trendSignal.explanation,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function generateDemoEmbedding384(text: string): number[] {
  let seed = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }

  const vector: number[] = [];
  for (let index = 0; index < 384; index += 1) {
    seed = Math.imul(seed ^ (index + 1), 2246822519);
    const normalized = ((seed >>> 0) / 4294967295) * 2 - 1;
    vector.push(normalized);
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  let numerator = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    numerator += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator ? numerator / denominator : 0;
}

function detectLanguage(text: string) {
  if (/[\u0980-\u09ff]/.test(text)) return "bn";
  if (/\b(vai|ase|ache|bd|jersey)\b/i.test(text)) return "banglish";
  return "en";
}

// Stable logical identity for a product (independent of its DB id). Seed products
// are assigned a fresh crypto.randomUUID() on every boot, so re-seeding / resetDemo
// upserts (onConflict: "id") never collide with prior rows and the products table
// accumulates multiple rows for the same kit. Those duplicates have different ids
// but identical attributes → identical DSS → the same card repeats in the Top 10.
// We collapse them here on READ (keeping the first = newest, since the query is
// ordered created_at desc). DB rows are left untouched — no user data is deleted.
function productIdentitySignature(product: Product): string {
  const sizes = safeVariants(product)
    .map((variant) => variant.size)
    .filter(Boolean)
    .sort()
    .join(",");
  return [
    product.team_country_club,
    product.product_name,
    product.kit_type,
    product.edition_type,
    product.season_year,
    product.player_name ?? "",
    product.font_name ?? "",
    sizes,
  ]
    .map((part) => String(part).trim().toLowerCase())
    .join("|");
}

function dedupeProductsByIdentity(products: Product[]): Product[] {
  const seen = new Set<string>();
  const unique: Product[] = [];
  for (const product of products) {
    const signature = productIdentitySignature(product);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(product);
  }
  return unique;
}

export async function fetchProductsFromSupabase() {
  return withSupabaseTimeout("fetch products", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!data) return [];
    // Dedupe logical duplicates (same kit re-seeded under new ids) so each unique
    // product appears once. Keeps the first occurrence (newest by created_at).
    return dedupeProductsByIdentity((data as ProductRow[]).map((row) => parseProductRow(row)));
  }, []);
}

export async function fetchJerseyInquiryCounts(): Promise<JerseyInquiryCount[]> {
  if (typeof window === "undefined") return [];

  try {
    const res = await fetch("/api/jersey-inquiries?limit=500", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      ok?: boolean;
      counts?: JerseyInquiryCount[];
    };
    return payload.ok && Array.isArray(payload.counts) ? payload.counts : [];
  } catch (error) {
    console.warn("[Botpress inquiries] count read skipped", error);
    return [];
  }
}

export async function upsertProductToSupabase(product: Product) {
  return withSupabaseTimeout("upsert product", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    const row = summarizeProductForStorage(product);
    const { error } = await supabase.from("products").upsert(row, { onConflict: "id" });
    if (error) throw error;
    void createProductEmbeddingRecord(product);
    return true;
  }, false);
}

export async function deleteProductFromSupabase(productId: string) {
  return withSupabaseTimeout("delete product", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    const { error } = await supabase.from("products").delete().eq("id", productId);
    if (error) throw error;
    return true;
  }, false);
}

export async function fetchTrendSignalsFromSupabase(
  geo = "BD",
): Promise<StoredTrendSignal[]> {
  return withSupabaseTimeout("fetch trend signals", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return [];
    // Per-geo cache read: only this market's cached momentum rows.
    const { data, error } = await supabase
      .from("trend_signals")
      .select("*")
      .eq("geo", geo)
      .order("fetched_at", { ascending: false });

    if (error) throw error;
    if (!data) return [];

    return data.map((row) => ({
      id: row.id as string,
      keyword: row.keyword as string,
      geo: ((row.geo as string) || "BD") as "BD",
      channel: ((row.channel as string) || "web") as LocalTrendSignal["channel"],
      language: ((row.language as string) || "en") as LocalTrendSignal["language"],
      momentum: ((row.momentum as string) || "stable") as LocalTrendSignal["momentum"],
      growthWeight: safeNumber(row.growth_weight, 0),
      matchedTeam: (row.matched_team as string) || undefined,
      matchedPlayer: (row.matched_player as string) || undefined,
      explanation: (row.explanation as string) || "",
      source: (row.source as string) || undefined,
      fetched_at: (row.fetched_at as string) || undefined,
    }));
  }, []);
}

// Reads market-discovery rows (GEO_MAP + RELATED_QUERIES) for one geo, written by
// api/trends-refresh. Returns an EMPTY (non-live) result when that geo has no cached rows —
// the caller decides whether to show the demo snapshot (DEMO_GEO only) or an empty-state.
export async function fetchMarketDiscoveryFromSupabase(geo = "BD"): Promise<MarketDiscovery> {
  return withSupabaseTimeout<MarketDiscovery>(
    "fetch market discovery",
    async () => {
      const supabase = await getSupabaseClient();
      if (!supabase) return emptyMarketDiscovery;

      const { data, error } = await supabase
        .from("market_discovery")
        .select("*")
        .eq("geo", geo)
        .order("score", { ascending: false });

      if (error) throw error;
      if (!data || !data.length) return emptyMarketDiscovery;

      const related: MarketDiscovery["related"] = [];
      let fetchedAt: string | undefined;

      for (const row of data) {
        const kind = row.kind as string;
        const rawValue = safeNumber(row.raw_value, 0);
        const rowFetchedAt = (row.fetched_at as string) || undefined;
        if (rowFetchedAt && (!fetchedAt || rowFetchedAt > fetchedAt)) fetchedAt = rowFetchedAt;

        if (kind === "related_top" || kind === "related_rising") {
          const bucket = kind === "related_rising" ? "rising" : "top";
          related.push({
            query: (row.label as string) || "",
            value: rawValue,
            score: safeNumber(
              row.score,
              bucket === "rising" ? scoreRising(rawValue) : scoreTop(rawValue),
            ),
            bucket,
          });
        }
      }

      return { live: true, fetchedAt, related };
    },
    emptyMarketDiscovery,
  );
}

export async function fetchNewsEventsFromSupabase(): Promise<import("./news-score").NewsEvent[]> {
  return withSupabaseTimeout(
    "fetch news events",
    async () => {
      const supabase = await getSupabaseClient();
      if (!supabase) return [];

      // Sort by created_at so newly inserted rows always appear first, regardless of
      // event_date (which can be null/backdated).
      const queryOnce = async (): Promise<import("./news-score").NewsEvent[]> => {
        const { data, error } = await supabase
          .from("news_events")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return (data ?? []) as import("./news-score").NewsEvent[];
      };

      // One retry: an empty first read on a cold connection retries once after 800ms.
      let rows = await queryOnce();
      if (rows.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        rows = await queryOnce();
      }
      return rows;
    },
    [],
    8000, // news fetch gets a longer budget than the 5s default (cold start + retry)
  );
}

export async function seedTrendSignalsToSupabase(signals: LocalTrendSignal[]) {
  return withSupabaseTimeout("seed trend signals", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return [];
    const existing = await fetchTrendSignalsFromSupabase();
    const existingKeys = new Set(existing.map((signal) => `${signal.keyword}::${signal.channel}`));
    const missing = signals.filter(
      (signal) => !existingKeys.has(`${signal.keyword}::${signal.channel}`),
    );

    if (!missing.length) return existing;

    const { data, error } = await supabase
      .from("trend_signals")
      .insert(
        missing.map((signal) => ({
          keyword: signal.keyword,
          geo: signal.geo,
          channel: signal.channel,
          language: signal.language,
          momentum: signal.momentum,
          growth_weight: signal.growthWeight,
          matched_team: signal.matchedTeam ?? null,
          matched_player: signal.matchedPlayer ?? null,
          explanation: signal.explanation,
        })),
      )
      .select("*");

    if (error) throw error;
    if (data) {
      const seeded = data.map((row) => ({
        id: row.id as string,
        keyword: row.keyword as string,
        geo: ((row.geo as string) || "BD") as "BD",
        channel: ((row.channel as string) || "web") as LocalTrendSignal["channel"],
        language: ((row.language as string) || "en") as LocalTrendSignal["language"],
        momentum: ((row.momentum as string) || "stable") as LocalTrendSignal["momentum"],
        growthWeight: safeNumber(row.growth_weight, 0),
        matchedTeam: (row.matched_team as string) || undefined,
        matchedPlayer: (row.matched_player as string) || undefined,
        explanation: (row.explanation as string) || "",
        source: (row.source as string) || undefined,
        fetched_at: (row.fetched_at as string) || undefined,
      }));

      void Promise.allSettled(
        seeded.map((signal) =>
          createTrendEmbeddingRecord({
            ...signal,
          }),
        ),
      );
      return [...seeded, ...existing];
    }

    return existing;
  }, []);
}

export async function saveForecastScoreToSupabase(
  productId: string,
  scoreObject: Pick<
    ForecastResult,
    "demandSpikeScore" | "urgencyLabel" | "recommendation" | "breakdown"
  >,
) {
  return withSupabaseTimeout("save forecast score", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    const { error } = await supabase.from("forecast_scores").insert({
      product_id: productId,
      demand_spike_score: scoreObject.demandSpikeScore,
      urgency_label: scoreObject.urgencyLabel,
      trend_score: scoreObject.breakdown.marketTrend,
      query_score: scoreObject.breakdown.customerConversation,
      stock_risk_score: scoreObject.breakdown.stockReductionVelocity,
      margin_score: scoreObject.breakdown.profitMargin,
      sales_velocity_score: scoreObject.breakdown.sportsNews,
      recommendation: scoreObject.recommendation,
    });
    if (error) throw error;
    return true;
  }, false);
}

export async function saveChatLogToSupabase(
  customerMessage: string,
  aiReply: string,
  matchedProductId?: string,
) {
  return withSupabaseTimeout("save chat log", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    const { error } = await supabase.from("chat_logs").insert({
      customer_message: customerMessage,
      ai_reply: aiReply,
      matched_product_id: matchedProductId ?? null,
      language: detectLanguage(customerMessage),
    });
    if (error) throw error;
    return true;
  }, false);
}

export async function createProductEmbeddingRecord(product: Product) {
  return withSupabaseTimeout("create product embedding", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    const content = buildProductEmbeddingContent(product);
    const metadata = {
      product_name: product.product_name,
      team: product.team_country_club,
      kit_type: product.kit_type,
      edition_type: product.edition_type,
      source_country: product.source_country,
    };
    const embedding = generateDemoEmbedding384(content);

    await supabase.from("product_embeddings").delete().eq("product_id", product.id);
    const { error } = await supabase.from("product_embeddings").insert({
      product_id: product.id,
      content,
      metadata,
      embedding,
    });
    if (error) throw error;
    return true;
  }, false);
}

export async function createTrendEmbeddingRecord(trendSignal: StoredTrendSignal) {
  return withSupabaseTimeout("create trend embedding", async () => {
    const supabase = await getSupabaseClient();
    if (!supabase) return false;
    let trendSignalId = trendSignal.id;

    if (!trendSignalId) {
      const { data, error } = await supabase
        .from("trend_signals")
        .select("id")
        .eq("keyword", trendSignal.keyword)
        .eq("channel", trendSignal.channel)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      trendSignalId = (data?.id as string | undefined) ?? undefined;
    }

    if (!trendSignalId) return false;

    const content = buildTrendEmbeddingContent(trendSignal);
    const metadata = {
      keyword: trendSignal.keyword,
      matched_team: trendSignal.matchedTeam ?? null,
      matched_player: trendSignal.matchedPlayer ?? null,
      momentum: trendSignal.momentum,
      source: trendSignal.source ?? "cached_google_trends_style_snapshot",
    };
    const embedding = generateDemoEmbedding384(content);

    await supabase.from("trend_embeddings").delete().eq("trend_signal_id", trendSignalId);
    const { error } = await supabase.from("trend_embeddings").insert({
      trend_signal_id: trendSignalId,
      content,
      metadata,
      embedding,
    });
    if (error) throw error;
    return true;
  }, false);
}

export function semanticProductSearchLocalFallback(query: string): SemanticSearchHit[] {
  const queryEmbedding = generateDemoEmbedding384(query);
  const products = readProductsFromBrowserStorage();

  return products
    .map((product) => {
      const content = buildProductEmbeddingContent(product);
      const similarity = cosineSimilarity(queryEmbedding, generateDemoEmbedding384(content));
      return {
        id: product.id,
        content,
        similarity,
        metadata: {
          product_name: product.product_name,
          team: product.team_country_club,
          type: `${product.kit_type} / ${product.edition_type}`,
        },
      };
    })
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 5);
}

export function semanticTrendSearchLocalFallback(query: string): SemanticSearchHit[] {
  const queryEmbedding = generateDemoEmbedding384(query);

  return localTrendSignals
    .map((signal) => {
      const content = buildTrendEmbeddingContent(signal);
      const similarity = cosineSimilarity(queryEmbedding, generateDemoEmbedding384(content));
      return {
        id: signal.keyword,
        content,
        similarity,
        metadata: {
          keyword: signal.keyword,
          matched_team: signal.matchedTeam ?? null,
          matched_player: signal.matchedPlayer ?? null,
          momentum: signal.momentum,
        },
      };
    })
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 5);
}
