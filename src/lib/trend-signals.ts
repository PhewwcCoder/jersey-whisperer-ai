import type { Product } from "./types";

export interface LocalTrendSignal {
  keyword: string;
  channel: "web" | "image" | "news" | "shopping";
  language: "en" | "bn" | "banglish";
  momentum: "breakout" | "rising" | "stable";
  growthWeight: number;
  geo: "BD";
  matchedTeam?: string;
  matchedPlayer?: string;
  explanation: string;
}

export const localTrendSignals: LocalTrendSignal[] = [
  {
    keyword: "argentina player edition jersey 2026",
    channel: "web",
    language: "en",
    momentum: "breakout",
    growthWeight: 0.95,
    geo: "BD",
    matchedTeam: "Argentina",
    explanation: "World Cup conversation is driving premium Argentina kit intent in Bangladesh.",
  },
  {
    keyword: "messi jersey bd",
    channel: "web",
    language: "banglish",
    momentum: "breakout",
    growthWeight: 0.92,
    geo: "BD",
    matchedPlayer: "Messi",
    matchedTeam: "Argentina",
    explanation: "Bangladesh buyers are searching direct Messi jersey queries with local purchase intent.",
  },
  {
    keyword: "আর্জেন্টিনা জার্সি",
    channel: "web",
    language: "bn",
    momentum: "rising",
    growthWeight: 0.88,
    geo: "BD",
    matchedTeam: "Argentina",
    explanation: "Bangla-language demand is rising for Argentina jersey terms.",
  },
  {
    keyword: "argentina jersey",
    channel: "image",
    language: "en",
    momentum: "stable",
    growthWeight: 0.85,
    geo: "BD",
    matchedTeam: "Argentina",
    explanation: "Image-led browsing suggests strong visual product discovery around Argentina kits.",
  },
  {
    keyword: "real madrid mbappe jersey",
    channel: "web",
    language: "en",
    momentum: "rising",
    growthWeight: 0.82,
    geo: "BD",
    matchedTeam: "Real Madrid",
    matchedPlayer: "Mbappe",
    explanation: "Real Madrid plus Mbappe interest is climbing and can lift adjacent club kit demand.",
  },
  {
    keyword: "portugal new jersey",
    channel: "web",
    language: "en",
    momentum: "rising",
    growthWeight: 0.8,
    geo: "BD",
    matchedTeam: "Portugal",
    explanation: "New Portugal kit searches are trending up among football jersey buyers.",
  },
  {
    keyword: "barcelona jersey",
    channel: "web",
    language: "en",
    momentum: "rising",
    growthWeight: 0.75,
    geo: "BD",
    matchedTeam: "Barcelona",
    explanation: "Barcelona remains a steady search cluster with growth from younger fan demand.",
  },
  {
    keyword: "জার্সি ডিজাইন",
    channel: "web",
    language: "bn",
    momentum: "rising",
    growthWeight: 0.7,
    geo: "BD",
    explanation: "Generic jersey design interest indicates broader category curiosity in Bangladesh.",
  },
  {
    keyword: "brazil jersey bd",
    channel: "web",
    language: "banglish",
    momentum: "stable",
    growthWeight: 0.68,
    geo: "BD",
    matchedTeam: "Brazil",
    explanation: "Brazil demand is stable with persistent local buyer intent in Bangladesh.",
  },
  {
    keyword: "fabrilife jersey",
    channel: "web",
    language: "en",
    momentum: "breakout",
    growthWeight: 0.9,
    geo: "BD",
    explanation: "Local jersey category attention is being amplified by Bangladesh apparel search behavior.",
  },
];

function normalize(value: string | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesLoose(haystack: string, needle: string) {
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  const haystackCompact = haystack.replace(/\s+/g, "");
  const needleCompact = needle.replace(/\s+/g, "");
  return haystackCompact.includes(needleCompact);
}

function buildProductSearchText(product: Product) {
  return normalize(
    [
      product.product_name,
      product.team_country_club,
      product.player_name,
      product.font_name,
      product.kit_type,
      product.edition_type,
      product.manufacturing_type,
      product.source_country,
    ].join(" "),
  );
}

function keywordMatchStrength(product: Product, trend: LocalTrendSignal) {
  const haystack = buildProductSearchText(product);
  const keyword = normalize(trend.keyword);
  const matchedTeam = normalize(trend.matchedTeam);
  const matchedPlayer = normalize(trend.matchedPlayer);
  const team = normalize(product.team_country_club);
  const player = normalize(product.player_name);
  const font = normalize(product.font_name);

  let score = 0;

  if (matchedTeam && (includesLoose(team, matchedTeam) || includesLoose(haystack, matchedTeam))) {
    score += 4;
  }

  if (
    matchedPlayer &&
    (includesLoose(player, matchedPlayer) ||
      includesLoose(font, matchedPlayer) ||
      includesLoose(haystack, matchedPlayer))
  ) {
    score += 3;
  }

  if (keyword && includesLoose(haystack, keyword)) {
    score += 3;
  } else if (keyword) {
    const keywordTokens = keyword.split(" ").filter((token) => token.length > 2);
    const hits = keywordTokens.filter((token) => includesLoose(haystack, token)).length;
    if (hits >= Math.max(2, Math.floor(keywordTokens.length / 2))) {
      score += 2;
    } else if (hits > 0 && !matchedTeam && !matchedPlayer) {
      score += 1;
    }
  }

  return score;
}

export function getMatchingTrendsForProduct(
  product: Product,
  signals: LocalTrendSignal[] = localTrendSignals,
) {
  return signals
    .map((trend) => ({ trend, score: keywordMatchStrength(product, trend) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.trend.growthWeight - left.trend.growthWeight;
    })
    .map((entry) => entry.trend);
}

export function getBestTrendForProduct(product: Product, signals?: LocalTrendSignal[]) {
  return getMatchingTrendsForProduct(product, signals)[0];
}

export function getTrendScoreForProduct(product: Product, signals?: LocalTrendSignal[]) {
  // Default to 0.5 (neutral) so unmatched products are not penalised vs. matched ones
  return getBestTrendForProduct(product, signals)?.growthWeight ?? 0.5;
}

// Map a free-text search query (e.g. "argentina jersey 2026", "messi jersey bd")
// to a tracked team. Reuses the SAME hardcoded alias list (`localTrendSignals`)
// and matching helpers (`normalize` / `includesLoose`) as product↔trend matching,
// with the same weighting as keywordMatchStrength (team +4, player +3, keyword +2).
// Returns undefined when the query matches no known team — i.e. a discovery /
// "stock this next" candidate the UI can flag as an opportunity. No new team list.
export function matchQueryToTeam(query: string): string | undefined {
  const q = normalize(query);
  if (!q) return undefined;

  let best: { team: string; score: number } | undefined;
  for (const signal of localTrendSignals) {
    if (!signal.matchedTeam) continue;
    const team = normalize(signal.matchedTeam);
    const player = normalize(signal.matchedPlayer);
    const keyword = normalize(signal.keyword);

    let score = 0;
    if (team && includesLoose(q, team)) score += 4;
    if (player && includesLoose(q, player)) score += 3;
    if (keyword && includesLoose(q, keyword)) score += 2;

    if (score > 0 && (!best || score > best.score)) {
      best = { team: signal.matchedTeam, score };
    }
  }
  return best?.team;
}
