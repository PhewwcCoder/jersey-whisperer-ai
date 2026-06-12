export type EditionType = "Player Edition" | "Fan Edition" | "Retro Kit";
export type ManufacturingType = "Imported" | "BD-made";
export type SourceCountry = "China" | "Thailand" | "Bangladesh";
export type KitType = "Home" | "Away" | "Third" | "Retro";
export type Size = "S" | "M" | "L" | "XL" | "XXL";
export type Status = "Available" | "Low Stock" | "Out of Stock" | "Preorder";
export type TrendSignal = "None" | "Low" | "Medium" | "High";
export type Channel = "Messenger" | "WhatsApp" | "Manual" | "Instagram";

export type IntentType =
  | "greeting"
  | "availability"
  | "price"
  | "size"
  | "clarification"
  | "delivery"
  | "pickup"
  | "size_chart"
  | "order_status"
  | "custom_print"
  | "exchange"
  | "payment"
  | "material"
  | "discount"
  | "funny"
  | "unknown";

export type ResponseSource =
  | "Inventory"
  | "Shop policy"
  | "General support"
  | "Funny fallback";

export type MissingField =
  | "team_country_club"
  | "kit_type"
  | "edition_type"
  | "size"
  | "font_print"
  | "source_country"
  | "manufacturing_type"
  | "season_year";

export interface Variant {
  id: string;
  size: Size;
  stock_quantity: number;
  low_stock_threshold: number;
  buy_price: number;
  selling_price: number;
  status: Status;
  stocked_date?: string;
  possible_restock_date?: string;
  notes?: string;
}

export interface CustomerEvent {
  // "restock" = inventory replenishment; it offsets confirmed_sale units inside
  // the stock-reduction-velocity window (net depletion) and is ignored by the
  // customer-signal buckets.
  type: "query" | "confirmed_sale" | "restock";
  timestamp: number;
  // Event magnitude. For sales/restocks this is units; for query events this may
  // be a distinct-customer count imported from Botpress. Defaults to 1 when unknown.
  quantity?: number;
}

export interface Product {
  id: string;
  product_name: string;
  team_country_club: string;
  player_name?: string;
  font_name?: string;
  has_print?: boolean;
  patch_available?: boolean;
  season_year: number;
  kit_type: KitType;
  edition_type: EditionType;
  manufacturing_type: ManufacturingType;
  source_country: SourceCountry;
  supplier_name?: string;
  product_image_url?: string;
  trend_signal: TrendSignal;
  trend_reason?: string;
  popularity_score?: number;
  query_count?: number;
  // Captured once from the pre-Botpress (seeded) query_count; live Botpress
  // inquiry counts ADD to this baseline instead of replacing query_count.
  // See applyJerseyInquiryCountsToProducts.
  baseline_query_count?: number;
  created_at: string;
  variants: Variant[];
  events?: CustomerEvent[];
  starRating?: number; // 1–5, seller-set manual market read
}

export interface FallbackMatch {
  product_id: string;
  product_name: string;
  reason: string;
}

export interface ConversationContext {
  lastDetectedTeam?: string;
  lastDetectedKitType?: KitType;
  lastDetectedEdition?: EditionType;
  lastDetectedSize?: Size;
  lastDetectedFontPrint?: string;
  lastDetectedSourceCountry?: SourceCountry;
  lastDetectedManufacturingType?: ManufacturingType;
  lastDetectedYear?: number;
  lastIntent?: IntentType;
  lastMatchedProductId?: string;
}

export interface QueryReasoning {
  original: string;
  normalized: string;
  intent: IntentType;
  response_source: ResponseSource;
  detected_team?: string;
  detected_player?: string;
  detected_font?: string;
  detected_font_print?: string;
  detected_year?: number;
  detected_size?: Size;
  detected_edition?: EditionType;
  detected_source?: SourceCountry;
  detected_manufacturing_type?: ManufacturingType;
  detected_kit?: KitType;
  matched_product_id?: string;
  matched_product_name?: string;
  closest_fallback?: FallbackMatch;
  confidence: number;
  reason: string;
  reply: string;
  missing_fields: MissingField[];
  reused_context?: Partial<ConversationContext>;
  updated_context: ConversationContext;
  candidates?: { product_id: string; name: string; score: number }[];
}
