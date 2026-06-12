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

import { matchQueryToTeam } from "./trend-signals.js";

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

// ── Stage 2: DeepSeek (batched, primary) → Gemini (per-query) fallback ────────

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const AI_TIMEOUT_MS = 8000;
const DEEPSEEK_BATCH_TIMEOUT_MS = 15000;

// Per-process cache so the same ambiguous query is classified by AI only once
// (covers within-a-refresh dedup and survives warm-lambda reuse across refreshes).
const aiCache = new Map<string, boolean>();

function getGeminiKey(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.GEMINI_API_KEY;
}

function getDeepSeekKey(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.DEEPSEEK_API_KEY;
}

interface DeepSeekUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

// ONE batched DeepSeek call for every ambiguous query (vs one Gemini call per query).
// Returns a map keyed by normalized query, or null when DeepSeek is unavailable/failed
// so the caller can fall back to per-query Gemini.
async function classifyBatchWithDeepSeek(queries: string[]): Promise<Map<string, boolean> | null> {
  const apiKey = getDeepSeekKey();
  if (!apiKey || !queries.length) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_BATCH_TIMEOUT_MS);
  try {
    const prompt = [
      "For EACH search query decide if it is about a football (soccer) jersey, club, or",
      "national team. Cricket/basketball/other sports, shops, and random words are false.",
      'Return ONLY JSON: {"verdicts":[{"query":string,"football":boolean}]}.',
      "Echo each query back verbatim. Queries:",
      JSON.stringify(queries),
    ].join("\n");

    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
        messages: [
          { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      console.warn(`[football-filter] DeepSeek batch HTTP ${response.status} → Gemini fallback`);
      return null;
    }
    const payload = (await response.json()) as DeepSeekUpstream;
    const content = (payload.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return null;
    const parsed = JSON.parse(content) as { verdicts?: unknown };
    const rawList = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    const out = new Map<string, boolean>();
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.query !== "string" || typeof r.football !== "boolean") continue;
      const key = normalizeQuery(r.query);
      out.set(key, r.football);
      aiCache.set(key, r.football);
    }
    return out;
  } catch (err) {
    console.warn("[football-filter] DeepSeek batch failed → Gemini fallback:", err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
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

// Batched public API for the refresh pipeline. Same verdict semantics as
// isFootballRelevant, but wall-time bounded: Stage 1 keyword for everything, then ONE
// DeepSeek call for all ambiguous queries, then per-query Gemini IN PARALLEL only for
// what DeepSeek couldn't decide. Returns a map keyed by the RAW query string passed in.
// Never throws; unresolved queries are kept (relevant:true, certain:false).
export async function classifyFootballRelevance(
  queries: string[],
): Promise<Map<string, FootballRelevanceResult>> {
  const results = new Map<string, FootballRelevanceResult>();
  const ambiguous: string[] = [];

  for (const query of queries) {
    if (results.has(query)) continue;
    const keyword = classifyByKeyword(query);
    if (keyword) {
      results.set(query, keyword);
      continue;
    }
    const cached = aiCache.get(normalizeQuery(query));
    if (cached !== undefined) {
      results.set(query, {
        relevant: cached,
        certain: true,
        reason: cached ? "ai-yes" : "ai-no",
        usedAI: true,
      });
      continue;
    }
    ambiguous.push(query);
  }

  if (!ambiguous.length) return results;

  // Primary: one batched DeepSeek call for everything ambiguous.
  const batch = await classifyBatchWithDeepSeek(ambiguous);
  const leftover: string[] = [];
  for (const query of ambiguous) {
    const verdict = batch?.get(normalizeQuery(query));
    if (verdict === undefined) {
      leftover.push(query);
      continue;
    }
    results.set(query, {
      relevant: verdict,
      certain: true,
      reason: verdict ? "ai-yes" : "ai-no",
      usedAI: true,
    });
  }

  // Fallback: per-query Gemini, in parallel (each call has its own 8s timeout).
  if (leftover.length) {
    const verdicts = await Promise.all(leftover.map((query) => classifyWithGemini(query)));
    leftover.forEach((query, i) => {
      const ai = verdicts[i];
      if (ai === true) {
        results.set(query, { relevant: true, certain: true, reason: "ai-yes", usedAI: true });
      } else if (ai === false) {
        results.set(query, { relevant: false, certain: true, reason: "ai-no", usedAI: true });
      } else {
        // Both providers unavailable → KEEP, tagged uncertain (do not drop silently).
        results.set(query, {
          relevant: true,
          certain: false,
          reason: "ai-uncertain",
          usedAI: ai !== null,
        });
      }
    });
  }

  return results;
}
