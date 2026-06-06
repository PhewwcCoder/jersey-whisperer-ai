// Football-relevance filter for the related-queries DISPLAY pipeline.
// Goal: keep "Top Searches" / "Rising" boxes football-only — drop cricket noise
// (e.g. "rcb jersey"), other sports, and junk tokens (e.g. "diamu").
//
// DISPLAY-DATA ONLY. This never touches DSS scoring, S_trend, or trend_signals.
// It runs in api/trends-refresh.ts on the BLENDED related-query lists, right
// before the market_discovery insert.
//
// Two-stage classifier:
//   Stage 1 — keyword allow/deny (free, instant, offline). Decides the vast
//             majority of queries with zero AI calls. Handles the demo case
//             with no Gemini key ("rcb jersey" and "diamu" filtered offline).
//   Stage 2 — Gemini fallback, ONLY for genuinely ambiguous queries (matched
//             neither list). Reuses the existing GEMINI_API_KEY — no new key.
//             On any failure → KEEP (tagged uncertain), never crash the refresh.

import { matchQueryToTeam } from "./trend-signals";

// ── Stage 1 keyword lists ────────────────────────────────────────────────────

// Generic football vocabulary. A query containing any of these is ALLOWed.
// The tracked team/club/country/player aliases are handled separately by
// matchQueryToTeam (Argentina, Brazil, Portugal, Real Madrid, Barcelona,
// Messi, Mbappe) so we don't duplicate them here.
export const FOOTBALL_TERMS: string[] = [
  // category words
  "football",
  "soccer",
  "futbol",
  "jersey",
  "kit",
  "fc",
  "cf",
  "world cup",
  "worldcup",
  "champions league",
  "premier league",
  "la liga",
  "laliga",
  "serie a",
  "bundesliga",
  "ligue 1",
  "ucl",
  "epl",
  "fifa",
  // marquee players
  "messi",
  "ronaldo",
  "cristiano",
  "mbappe",
  "neymar",
  "haaland",
  "vinicius",
  "benzema",
  "suarez",
  // common clubs / national teams beyond the tracked alias list
  "real madrid",
  "barcelona",
  "barca",
  "psg",
  "bayern",
  "liverpool",
  "chelsea",
  "arsenal",
  "manchester",
  "man utd",
  "man city",
  "juventus",
  "inter miami",
  "al nassr",
  "al-nassr",
  "argentina",
  "brazil",
  "brasil",
  "portugal",
  "spain",
  "france",
  "germany",
  "england",
  "morocco",
  "saudi",
];

// Non-football sports + league abbreviations. Matched as EXACT tokens (not
// substrings) so short codes like "mi" don't hit "miami"/"messi", and "dc"
// doesn't hit unrelated words. A query with any of these tokens is DENied.
export const NON_FOOTBALL_TOKENS: Set<string> = new Set([
  // cricket (IPL / BPL / PSL teams + the sport itself)
  "cricket",
  "ipl",
  "bpl",
  "psl",
  "rcb",
  "csk",
  "mi",
  "kkr",
  "srh",
  "pbks",
  "lsg",
  "rr",
  "gt",
  "bbl",
  "cpl",
  "t20",
  "odi",
  // basketball
  "nba",
  "basketball",
  "lakers",
  "celtics",
  "warriors",
  // other sports
  "nfl",
  "mlb",
  "baseball",
  "nhl",
  "hockey",
  "rugby",
  "tennis",
  "kabaddi",
  "badminton",
  "volleyball",
]);

export type RelevanceReason =
  | "keyword-allow"
  | "keyword-deny"
  | "keyword-noise"
  | "ai-yes"
  | "ai-no"
  | "ai-uncertain";

export interface FootballRelevanceResult {
  // Final keep decision: keep the query in the boxes when relevant === true.
  relevant: boolean;
  // false only when Stage 2 was needed but Gemini was unavailable/errored.
  certain: boolean;
  reason: RelevanceReason;
  usedAI: boolean;
}

function normalizeQuery(query: string): string {
  return (query ?? "")
    .toLowerCase()
    // keep latin letters/digits and Bangla block; collapse everything else to space
    .replace(/[^a-z0-9ঀ-৿]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Stage 1: pure, synchronous, offline. Returns a decided verdict, or null when
// the query is ambiguous and should escalate to Stage 2 (AI).
export function classifyByKeyword(query: string): FootballRelevanceResult | null {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    // empty / all-symbol query → noise
    return { relevant: false, certain: true, reason: "keyword-noise", usedAI: false };
  }

  const tokens = normalized.split(" ");

  // DENY first — a cricket/other-sport token wins even if "jersey" is present
  // (e.g. "rcb jersey" → cricket).
  if (tokens.some((token) => NON_FOOTBALL_TOKENS.has(token))) {
    return { relevant: false, certain: true, reason: "keyword-deny", usedAI: false };
  }

  // ALLOW — tracked alias match (reuses matchQueryToTeam over localTrendSignals)…
  if (matchQueryToTeam(query)) {
    return { relevant: true, certain: true, reason: "keyword-allow", usedAI: false };
  }
  // …or any generic football term. Multi-word terms use substring; single words
  // use exact-token match to avoid accidental substring hits.
  const compact = normalized.replace(/\s+/g, "");
  const tokenSet = new Set(tokens);
  for (const term of FOOTBALL_TERMS) {
    if (term.includes(" ")) {
      if (normalized.includes(term) || compact.includes(term.replace(/\s+/g, ""))) {
        return { relevant: true, certain: true, reason: "keyword-allow", usedAI: false };
      }
    } else if (tokenSet.has(term)) {
      return { relevant: true, certain: true, reason: "keyword-allow", usedAI: false };
    }
  }

  // NOISE — a single stray token with no football signal (e.g. "diamu").
  // Filtered offline so the demo works with no Gemini key. Multi-token queries
  // with no signal (e.g. "al nassr saudi") are left for the AI to judge.
  if (tokens.length === 1 || normalized.length <= 3) {
    return { relevant: false, certain: true, reason: "keyword-noise", usedAI: false };
  }

  // Ambiguous → escalate to Stage 2.
  return null;
}

// ── Stage 2: Gemini fallback ──────────────────────────────────────────────────

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const AI_TIMEOUT_MS = 8000;

// Per-process cache so the same ambiguous query is classified by AI only once
// (covers within-a-refresh dedup and survives warm-lambda reuse across refreshes).
const aiCache = new Map<string, boolean>();

function getGeminiKey(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.GEMINI_API_KEY;
}

interface GeminiUpstream {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

// Returns true (YES) / false (NO) / null (unavailable or unparseable).
async function classifyWithGemini(query: string): Promise<boolean | null> {
  const key = normalizeQuery(query);
  if (aiCache.has(key)) return aiCache.get(key) as boolean;

  const apiKey = getGeminiKey();
  if (!apiKey) return null; // no key → uncertain, caller keeps the item

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const prompt =
      "Is this search query about a football (soccer) jersey, club, or national team? " +
      `Answer only YES or NO. Query: ${query}`;

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4 },
      }),
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as GeminiUpstream;
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join("")
      .trim()
      .toUpperCase();

    let verdict: boolean | null = null;
    if (text.includes("YES")) verdict = true;
    else if (text.includes("NO")) verdict = false;

    if (verdict !== null) aiCache.set(key, verdict);
    return verdict;
  } catch {
    return null; // network/timeout/abort → uncertain
  } finally {
    clearTimeout(timeoutId);
  }
}

// Public API. Stage 1 keyword decision first; only ambiguous queries reach Gemini.
// Never throws. Keep-on-error: AI failure returns relevant:true, certain:false.
export async function isFootballRelevant(query: string): Promise<FootballRelevanceResult> {
  const keyword = classifyByKeyword(query);
  if (keyword) return keyword;

  const ai = await classifyWithGemini(query);
  if (ai === true) return { relevant: true, certain: true, reason: "ai-yes", usedAI: true };
  if (ai === false) return { relevant: false, certain: true, reason: "ai-no", usedAI: true };

  // Gemini unavailable/errored → KEEP, tagged uncertain (do not drop silently).
  return { relevant: true, certain: false, reason: "ai-uncertain", usedAI: ai !== null };
}
