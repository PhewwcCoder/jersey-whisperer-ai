// api/football-news-refresh.ts — Google AI Mode football news → DeepSeek/Gemini parse → news_events
// Server-side only. Uses process.env.SERPAPI_KEY (news) + process.env.DEEPSEEK_API_KEY
// (primary parser, model from DEEPSEEK_MODEL env, default deepseek-chat), then
// process.env.OPENROUTER_API_KEY if configured, with process.env.GEMINI_API_KEY as the
// final fallback. Fills the trophy/results gap that API-Football's free tier blocks.
// SerpApi's google_ai_mode engine returns a written summary with inline citations; the
// parser ONLY STRUCTURES that text into events (never sources/invents them), and a
// citation gate drops any event not traceable to a real source link. DeepSeek is primary
// because response_format:json_object forces valid JSON; on error/unparseable output we
// fall back through OpenRouter to Gemini.
// Everything fails safe: any error writes nothing, keeps existing rows, never crashes.

import {
  resolveTier,
  isKnownEntity,
  TIER_LISTS,
  NATIONAL_TEAM_MAP,
  type NewsEventType,
  type Tier,
} from "../src/lib/news-score.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const SERPAPI_SEARCH = "https://serpapi.com/search";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL_DEFAULT = "openai/gpt-oss-120b:free";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL_DEFAULT = "deepseek-chat";

// THREE retrieval queries — each asks google_ai_mode to REPORT factual events (it
// returns a written summary with citations). The "name the jersey to stock" guidance
// only steers retrieval toward jersey-demand events; the parser captures any jersey
// recommendation into the DISPLAY-ONLY `context` field and NOWHERE scoring reads. All
// three responses are merged into ONE parse (DeepSeek primary → Gemini fallback).
const NEWS_QUERY_A =
  "Search the web for the most important football transfer news, official player signings, confirmed transfers, and major transfer rumors from the last 7 days, focusing on superstar players and elite global clubs (Real Madrid, Barcelona, Manchester United, Manchester City, Liverpool, Arsenal, Bayern Munich, Paris Saint-Germain, Inter Miami, Al Nassr) and marquee players (Lionel Messi, Cristiano Ronaldo, Kylian Mbappe, Erling Haaland, Vinicius Junior, Jude Bellingham, Mohamed Salah, Neymar). Also include any newly released or leaked club or player-edition jerseys or kits this week. List the top 5 most impactful moves or kit releases, and for each name the exact club or player-edition jersey that will see an immediate demand spike globally and in South Asia.";
const NEWS_QUERY_B =
  "Search the web for major football club results from the last 7 days: league titles, Champions League or Europa League or domestic cup trophies, and high-profile match victories among top European and globally popular clubs (Real Madrid, Barcelona, Manchester United, Manchester City, Liverpool, Arsenal, Bayern Munich, Paris Saint-Germain, Juventus, Inter Milan, AC Milan, Atletico Madrid). Identify the 3 to 5 clubs with the strongest post-result fan momentum and media hype right now, and for each name the current club jersey (Home, Away, or Third) most likely to sell on the back of that result.";
const NEWS_QUERY_C =
  "Search the web for competitive international football results from the last 7 days — World Cup 2026 qualifiers, UEFA Nations League, Copa America, Euro qualifiers, and continental tournament matches — strictly excluding friendly matches. Give special attention to national teams with large fan followings in Bangladesh and South Asia: Argentina, Brazil, Portugal, France, Germany, Spain, England, Italy, and Bangladesh. Identify the top 3 national teams that just won crucial matches, qualified, or advanced significantly, and for each name the national team jersey that fans will rush to buy.";

const MAX_NEWS_CHARS = 4000;
const CACHE_WINDOW_HOURS = 20;

// Magnitude rubric (matches the existing news-score rubric; no scoring math changed).
const BASE_M: Record<NewsEventType, number> = {
  trophy: 0.7,
  transfer: 0.6,
  wc_final: 0.5,
  kit_release: 0.4,
  retirement: 0.3,
  performance: 0.4,
};

const VALID_TYPES: ReadonlySet<string> = new Set<NewsEventType>([
  "trophy",
  "transfer",
  "wc_final",
  "kit_release",
  "retirement",
  "performance",
]);

// Validate a Gemini-extracted YYYY-MM-DD into a real ISO timestamp for event_date.
// Falls back to `fallbackIso` (now) if missing, malformed, not a real calendar date,
// or implausible (more than ~2 days in the future, or older than 1 year). Keeping the
// date real makes the 7-day decay accurate; keeping it sane stops a hallucinated
// "2027-..." from parking an event permanently at full freshness.
function validEventDate(raw: string | null, fallbackIso: string): string {
  if (!raw) return fallbackIso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return fallbackIso;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Reject non-real dates (e.g. 2026-02-31 rolls over to March).
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return fallbackIso;
  }
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return fallbackIso;
  const now = Date.now();
  const TWO_DAYS = 2 * 86400000;
  const ONE_YEAR = 365 * 86400000;
  if (ms > now + TWO_DAYS || ms < now - ONE_YEAR) return fallbackIso;
  return dt.toISOString();
}

// ---------------------------------------------------------------------------
// Step 1 — Fetch news via SerpApi google_ai_mode; flatten text_blocks to plain text
// AND build a citation corpus. The AI Mode answer NESTS lists inside list items
// (text_blocks → list[] → text_blocks → list[] …), so the walker recurses. A snippet
// backed by snippet_links[].link is "cited"; the top-level references[] array is also
// citation evidence. The citation corpus later gates events to real sources.
// ---------------------------------------------------------------------------
interface ExtractedNews {
  text: string; // flattened plain text fed to Gemini
  blockCount: number;
  sources: string[]; // reference titles/sources, for provenance + logging
  citedCorpus: string; // lowercased text of source-linked snippets + reference titles
}

function extractNewsText(data: unknown): ExtractedNews {
  const parts: string[] = [];
  const citedParts: string[] = [];
  const sources = new Set<string>();
  let blockCount = 0;

  const root = (data ?? {}) as Record<string, unknown>;
  const asString = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  const pushString = (v: unknown) => {
    const s = asString(v);
    if (s) parts.push(s);
  };

  // A snippet backed by snippet_links[].link is CITED — record its text (lowercased)
  // as traceable-to-source evidence for the citation gate.
  const recordSnippet = (text: string, b: Record<string, unknown>) => {
    if (!text) return;
    parts.push(text);
    const links = b.snippet_links;
    if (Array.isArray(links) && links.length) citedParts.push(text.toLowerCase());
  };

  // Optional code_block JSON: supplementary context for Gemini ONLY. We do NOT trust
  // its editorial fields (e.g. retail_action / demand_trigger) and never add it to the
  // citation corpus — citations must come from real source links / references.
  const captureCodeBlock = (b: Record<string, unknown>) => {
    pushString(asString(b.snippet) || asString(b.code) || asString(b.text));
  };

  // Recursive: handles paragraph/heading/list/code_block blocks AND the nested
  // text_blocks-inside-list-items structure AI Mode returns.
  const walk = (block: unknown) => {
    if (typeof block === "string") {
      pushString(block);
      return;
    }
    if (!block || typeof block !== "object") return;
    blockCount += 1;
    const b = block as Record<string, unknown>;
    if (asString(b.type) === "code_block") {
      captureCodeBlock(b);
    } else {
      recordSnippet(asString(b.snippet) || asString(b.text), b);
      pushString(b.title);
      pushString(b.heading);
      pushString(b.paragraph);
    }
    if (Array.isArray(b.list)) for (const item of b.list) walk(item);
    if (Array.isArray(b.text_blocks)) for (const sub of b.text_blocks) walk(sub);
  };

  const blocks = root.text_blocks;
  if (Array.isArray(blocks)) for (const block of blocks) walk(block);

  // Top-level references[] = { title, link, source }. Provenance + citation evidence.
  const refs = root.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const r = ref as Record<string, unknown>;
      const title = asString(r.title);
      const source = asString(r.source);
      const label = title || source || asString(r.link);
      if (label) sources.add(label);
      if (title) citedParts.push(title.toLowerCase());
      if (source) citedParts.push(source.toLowerCase());
    }
  }

  let text = parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > MAX_NEWS_CHARS) text = text.slice(0, MAX_NEWS_CHARS);

  return {
    text,
    blockCount,
    sources: [...sources].slice(0, 12),
    citedCorpus: citedParts.join("\n"),
  };
}

async function fetchGoogleAiModeNews(serpApiKey: string, query: string): Promise<ExtractedNews> {
  const params = new URLSearchParams({
    engine: "google_ai_mode",
    q: query,
    api_key: serpApiKey,
  });
  const url = `${SERPAPI_SEARCH}?${params.toString()}`;
  // Never log the api_key.
  console.log(
    `[football-news] SerpApi google_ai_mode request: ${url.replace(serpApiKey, "REDACTED")}`,
  );

  const res = await fetch(url);
  if (!res.ok) {
    // Include SerpApi's error body so a 401 says WHY (invalid key vs out of searches).
    const body = await res.text().catch(() => "");
    throw new Error(`SerpApi google_ai_mode HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) throw new Error(`SerpApi google_ai_mode error: ${String(data.error)}`);
  return extractNewsText(data);
}

// Merge N extracted-news results into one combined text + one citation corpus
// (keeps the pipeline at a SINGLE parse over all queries' output). With THREE queries
// the merged-text cap is 3 × MAX_NEWS_CHARS = 12000.
function mergeNews(parts: ExtractedNews[]): ExtractedNews {
  const cap = MAX_NEWS_CHARS * 3; // 12000 for the 3-query pipeline
  let text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n");
  if (text.length > cap) text = text.slice(0, cap);
  return {
    text,
    blockCount: parts.reduce((sum, p) => sum + p.blockCount, 0),
    sources: [...new Set(parts.flatMap((p) => p.sources))].slice(0, 18),
    citedCorpus: parts
      .map((p) => p.citedCorpus)
      .filter(Boolean)
      .join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Parse news text into structured events with Gemini (JSON-only)
// ---------------------------------------------------------------------------
interface ParsedEvent {
  type: NewsEventType;
  team: string;
  secondary_team: string | null;
  player: string | null;
  headline: string;
  context: string | null; // DISPLAY-ONLY demand color; NEVER used in scoring.
  date: string | null; // YYYY-MM-DD the event occurred (Gemini-extracted); validated before use.
}

function buildGeminiPrompt(newsText: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD reference for relative dates
  return [
    "You are extracting football demand-signal events from news text. Return ONLY a JSON array, no prose. Each event:",
    "{",
    '  "type": "trophy" | "transfer" | "wc_final" | "kit_release" | "retirement" | "performance",',
    '  "team": "<club or country name>",',
    '  "secondary_team": "<for transfers: destination club, else null>",',
    '  "player": "<player name if relevant, else null>",',
    '  "headline": "<short factual headline, max 12 words>",',
    '  "context": "<optional, max 12 words: brief human-readable demand color, e.g. \'PSG fans celebrating Champions League win\'; null if none>",',
    '  "date": "<the date the event occurred in YYYY-MM-DD format, extracted from the text>"',
    "}",
    `Today's date is ${today}.`,
    "Rules:",
    `- For "date": extract the date the event actually occurred (transfer date, trophy/final date, match date) in YYYY-MM-DD format. If the text gives a relative date ('yesterday', 'this week', 'Saturday'), convert it to an absolute YYYY-MM-DD using today's date (${today}) as reference. If no date is determinable, use today's date (${today}) as fallback.`,
    "- Only include events clearly stated in the text. Do NOT invent or infer.",
    '- Only extract events explicitly stated with enough detail to be a real event (named club + what happened). Skip vague market commentary, opinions, projections, or "demand" analysis. Facts only.',
    '- "trophy" = a club won a league/cup/UCL.',
    "- For national teams in major COMPETITIVE international tournaments (World Cup, Euros, Copa America, Nations League, qualifiers — never friendlies): use 'wc_final' for a tournament-deciding result (a final, a title win, or a result that clinches qualification/advancement); use 'performance' for other competitive international wins (a routine group-stage or qualifier win).",
    "- Map team/player names to their common English names.",
    "- Only emit a 'transfer' if the text clearly states a specific PLAYER (not a manager/coach) has signed for, moved to, or transferred to a named club. Ignore rumors, speculation, 'in talks', 'contact', 'evaluating', 'could move', or manager/coaching changes.",
    "- Only emit a 'transfer' event if the text states the deal is CONFIRMED, official, completed, or done. If the text says 'linked', 'rumored', 'interested', 'in talks', 'could sign', 'target', or 'bid' — DO NOT emit it. Confirmed deals only.",
    "- Only emit a 'transfer' if the player is a well-known footballer. If you don't recognize the player as a notable professional footballer, do NOT emit the event.",
    "- Never infer a 'transfer' from two club names appearing near each other. The text must explicitly state the player moved between clubs.",
    "- For a 'transfer', set player = the player, secondary_team = the destination club.",
    "- If the text states a player scored goals or had a standout performance (e.g. 'X scored 2 goals', hat-trick, decisive goal), emit a 'performance' event with that player and their club. The player must be a well-known footballer.",
    "- For 'wc_final', only include if it refers to the MOST RECENT or upcoming World Cup, not historical tournaments mentioned as background context.",
    "- The 'context' field is optional human-readable color for display only; keep it factual and brief, or null. If the text recommends a specific jersey to stock (e.g. a Home/Away/Player Edition), you may put that recommendation in 'context' — it is DISPLAY-ONLY and never affects scoring. Put it nowhere else.",
    "- If nothing qualifies, return [].",
    "Text:",
    newsText,
  ].join("\n");
}

// Strip code fences / surrounding prose and parse a JSON array. Returns [] on any
// failure UNLESS opts.strict — then it THROWS on empty/unparseable input so the caller
// can fall back to another parser (used by the DeepSeek path; the Gemini path stays
// lenient). A successfully-parsed-but-empty array is NOT a failure: it returns [].
function safeParseEvents(raw: string, opts?: { strict?: boolean }): ParsedEvent[] {
  if (!raw) {
    if (opts?.strict) throw new Error("parser returned empty output");
    return [];
  }
  let text = raw.trim();
  // remove ```json ... ``` or ``` ... ``` fences
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // fall back to the first [...] block if there's stray prose
  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const events: ParsedEvent[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const type = typeof e.type === "string" ? e.type.trim() : "";
      const team = typeof e.team === "string" ? e.team.trim() : "";
      if (!VALID_TYPES.has(type) || !team) continue; // drop malformed / unknown-type rows
      events.push({
        type: type as NewsEventType,
        team,
        secondary_team:
          typeof e.secondary_team === "string" && e.secondary_team.trim()
            ? e.secondary_team.trim()
            : null,
        player: typeof e.player === "string" && e.player.trim() ? e.player.trim() : null,
        headline: typeof e.headline === "string" ? e.headline.trim() : "",
        // DISPLAY-ONLY demand color — captured here but NEVER read by any scorer.
        context:
          typeof e.context === "string" && e.context.trim() ? e.context.trim().slice(0, 140) : null,
        // Raw Gemini date string; validated to a real YYYY-MM-DD at row-build time.
        date: typeof e.date === "string" && e.date.trim() ? e.date.trim() : null,
      });
    }
    return events;
  } catch (err) {
    if (opts?.strict) throw err instanceof Error ? err : new Error(String(err));
    console.error("[football-news] JSON parse failed:", err);
    return [];
  }
}

interface GeminiUpstream {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

interface ChatUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Shared POST-with-retry. DeepSeek and Gemini both intermittently return 503 ("model
// overloaded") or 429 (rate limit) under load; retry those transient statuses up to 3
// times with exponential backoff (1s → 2s → 4s) so they self-heal. Returns the ok
// Response; throws on any non-transient status or exhausted retries (caller falls back
// / fails safe).
async function postWithRetry(label: string, url: string, init: RequestInit): Promise<Response> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    const transient = res.status === 503 || res.status === 429;
    if (transient && attempt < MAX_RETRIES) {
      const backoffMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
      console.warn(
        `[football-news] ${label} ${res.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES}) in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// Classify an OpenRouter failure into a short, log-safe reason code (never the key):
// an HTTP status (postWithRetry throws "... HTTP <status>: ...") → openrouter_http_<status>;
// anything else (empty/unparseable JSON) → openrouter_parse_failed.
function openRouterFallbackReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  return http ? `openrouter_http_${http[1]}` : "openrouter_parse_failed";
}

function deepseekFallbackReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  return http ? `deepseek_http_${http[1]}` : "deepseek_parse_failed";
}

// PRIMARY parser — DeepSeek (model from DEEPSEEK_MODEL env, OpenAI-compatible
// chat/completions). response_format json_object forces structurally-valid JSON. Strict
// parse so any unparseable/empty output THROWS → caller falls back to the next provider.
async function parseEventsWithDeepSeek(
  newsText: string,
  deepseekKey: string,
): Promise<ParsedEvent[]> {
  const model = process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL_DEFAULT;
  const res = await postWithRetry("DeepSeek", DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildGeminiPrompt(newsText) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });
  const payload = (await res.json()) as ChatUpstream;
  if (payload.error) throw new Error(`DeepSeek error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  return safeParseEvents(content, { strict: true });
}

// SECONDARY parser — OpenRouter (model from OPENROUTER_MODEL env, OpenAI-compatible).
// response_format: json_object forces structurally-valid JSON. Strict parse so any
// unparseable/empty output THROWS → caller falls back to Gemini.
async function parseEventsWithOpenRouter(
  newsText: string,
  openRouterKey: string,
): Promise<ParsedEvent[]> {
  const model = process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_MODEL_DEFAULT;
  const res = await postWithRetry("OpenRouter", OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildGeminiPrompt(newsText) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });
  const payload = (await res.json()) as ChatUpstream;
  if (payload.error) throw new Error(`OpenRouter error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  // Strict: json_object may wrap the array as {"events":[...]}; safeParseEvents extracts
  // the inner [...]. On total parse failure it throws → Gemini fallback in the caller.
  return safeParseEvents(content, { strict: true });
}

// FALLBACK parser — Gemini (kept exactly as before, lenient parse + shared retry).
async function parseEventsWithGemini(newsText: string, geminiKey: string): Promise<ParsedEvent[]> {
  const res = await postWithRetry("Gemini", GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(newsText) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 },
    }),
  });
  const payload = (await res.json()) as GeminiUpstream;
  if (payload.error) throw new Error(`Gemini error: ${payload.error.message ?? "unknown"}`);
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  return safeParseEvents(text);
}

// ---------------------------------------------------------------------------
// Transfer player-gate (code-side validation). The Gemini prompt already forbids
// rumor/manager transfers, but we also drop any transfer whose player is not a
// recognized fan-favorite — a no-name transfer doesn't move jersey demand, so it
// must not score. Reuses the existing tier lists + NATIONAL_TEAM_MAP (no dupes).
// ---------------------------------------------------------------------------
// Flattened fan-favorite player names, longest-first so multi-word names
// ("Vinicius Junior") are matched before their shorter forms ("Vinicius").
const KNOWN_PLAYERS: string[] = [
  ...TIER_LISTS.players.most,
  ...TIER_LISTS.players.mid,
  ...TIER_LISTS.players.low,
].sort((a, b) => b.length - a.length);

// Resolve a parsed player name to its canonical tier-list name (case-insensitive,
// loose substring both ways), or null if not a recognized fan-favorite.
function resolveKnownPlayer(name: string | null): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (!n) return null;
  for (const known of KNOWN_PLAYERS) {
    const k = known.toLowerCase();
    if (n === k || n.includes(k) || k.includes(n)) return known;
  }
  return null;
}

// Keep a 'transfer' only if its player is a fan-favorite. Other event types pass
// through unchanged. For a valid transfer: team = player's national team (so the
// national jersey is boosted), secondary_team = destination club (so the club
// jersey is boosted too). Returns the kept events and the dropped-transfer count.
function gateTransfers(events: ParsedEvent[]): { kept: ParsedEvent[]; dropped: number } {
  const kept: ParsedEvent[] = [];
  let dropped = 0;
  for (const ev of events) {
    if (ev.type !== "transfer") {
      kept.push(ev);
      continue;
    }
    const canonical = resolveKnownPlayer(ev.player);
    if (!canonical) {
      dropped += 1;
      continue;
    }
    const destination = ev.secondary_team?.trim() || ev.team;
    const nationalTeam = NATIONAL_TEAM_MAP[canonical] ?? destination;
    kept.push({
      type: "transfer",
      team: nationalTeam,
      secondary_team: destination,
      player: ev.player,
      headline: ev.headline,
      context: ev.context, // display-only, preserved through the gate
      date: ev.date, // real event date, preserved through the gate
    });
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Citation gate (anti-hallucination). Keep an event only if its team, player, or
// destination club can be traced to a source-linked snippet or a references[] entry.
// `corpus` is the lowercased text of all cited snippets + reference titles built in
// extraction. No corpus → trust nothing (drop all). Matches full name or any token
// longer than 3 chars (so "Lionel Messi" matches a corpus that only says "Messi").
// ---------------------------------------------------------------------------
function entityCited(name: string | null, corpus: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (!n) return false;
  if (corpus.includes(n)) return true;
  return n
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .some((t) => corpus.includes(t));
}

function gateByCitation(
  events: ParsedEvent[],
  corpus: string,
): { kept: ParsedEvent[]; dropped: number } {
  if (!corpus) return { kept: [], dropped: events.length };
  const kept: ParsedEvent[] = [];
  let dropped = 0;
  for (const ev of events) {
    const cited =
      entityCited(ev.team, corpus) ||
      entityCited(ev.player, corpus) ||
      entityCited(ev.secondary_team, corpus);
    if (cited) kept.push(ev);
    else dropped += 1;
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Relevance gate (ALL event types). Final filter, applied AFTER the citation gate and
// the confirmed-transfer player-gate. An event of ANY type (trophy/performance/kit_
// release/wc_final/retirement/transfer) is KEPT only if its team, player, OR
// secondary_team resolves (loose matching) to an entry in the curated tier lists
// (players + clubs + national teams). If none of its fields are in the lists, the event
// involves no fan-favorite jersey and is dropped — it must not be stored or scored.
// Examples: "Crystal Palace won a trophy" → dropped; "PSG won a trophy" → kept;
// "Jean-Philippe Mateta performance" → dropped; "Aston Villa won a trophy" → dropped.
// ---------------------------------------------------------------------------
function gateByRelevance(events: ParsedEvent[]): {
  kept: ParsedEvent[];
  droppedNames: string[];
} {
  const kept: ParsedEvent[] = [];
  const droppedNames: string[] = [];
  for (const ev of events) {
    const relevant =
      isKnownEntity(ev.team) || isKnownEntity(ev.player) || isKnownEntity(ev.secondary_team);
    if (relevant) {
      kept.push(ev);
    } else {
      droppedNames.push(`${ev.type}:${ev.team}${ev.player ? `/${ev.player}` : ""}`);
    }
  }
  return { kept, droppedNames };
}

// ---------------------------------------------------------------------------
// Step 3 — Supabase: 20h cache check + upsert (raw fetch, news-refresh pattern)
// ---------------------------------------------------------------------------
function supabaseHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

// Returns the most recent google_ai_mode write timestamp, or null if none / on error.
// Used to enforce the ~once-daily (20h) refresh window. The news_events row
// write-time column is `created_at` (DB default now()); there is NO `fetched_at`
// column, so we select/order by `created_at`.
async function latestNewsTimestamp(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string | null> {
  try {
    const url =
      `${supabaseUrl}/rest/v1/news_events` +
      `?select=created_at&source=eq.google_ai_mode&order=created_at.desc&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders(serviceRoleKey) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`news_events cache check HTTP ${res.status}: ${body}`);
    }
    const rows = (await res.json()) as Array<{ created_at?: string }>;
    if (!rows.length) return null;
    return rows[0].created_at ?? null;
  } catch (err) {
    console.warn("[football-news] cache check failed (will proceed):", err);
    return null;
  }
}

async function upsertNewsEvents(
  supabaseUrl: string,
  serviceRoleKey: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/news_events?on_conflict=type,player,team,event_date`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders(serviceRoleKey),
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`news_events upsert failed (${res.status}): ${text}`);
  }
}

// Probe whether the optional nullable `context` column exists (migration may not be
// applied yet). If absent, we OMIT context from the write so inserts never 400 — the
// events still persist; only the display-only color is skipped until the column exists.
async function newsEventsHasContextColumn(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/news_events?select=context&limit=1`, {
      headers: supabaseHeaders(serviceRoleKey),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core refresh — exported so trends-refresh.ts can call it directly
// ---------------------------------------------------------------------------
export async function refreshFootballNews(opts?: {
  forceRefresh?: boolean;
}): Promise<{ written: number }> {
  // DEMO_MODE: skip all live API calls — seeded rows in Supabase are the source of truth.
  if (process.env.DEMO_MODE === "true") {
    console.log("[football-news] DEMO_MODE — skipping live fetch");
    return { written: 0 };
  }

  const serpApiKey = process.env.SERPAPI_KEY;
  // Diagnostic: presence + length + a SAFE fingerprint (first4…last4 only, never the
  // full value). Compare the fingerprint to your known-good key (0a07…2088): if it
  // differs, `vercel dev` is overriding .env.local with a stale cloud env var.
  {
    const k = process.env.SERPAPI_KEY || "";
    const fp = k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "(too short)";
    console.log("[serpapi] key present:", !!k, "length:", k.length, "fingerprint:", fp);
  }
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (!serpApiKey) {
    console.warn("[football-news] SERPAPI_KEY not configured — skipping");
    return { written: 0 };
  }
  // Need at least one parser. DeepSeek is primary; Gemini is the fallback.
  // If none is configured there's nothing to structure the news with, skip.
  if (!deepseekKey && !openRouterKey && !geminiKey) {
    console.warn(
      "[football-news] no parser key (DEEPSEEK_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY) — skipping",
    );
    return { written: 0 };
  }

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
  const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  )?.trim();
  if (!supabaseUrl || !supabaseKey) {
    console.warn("[football-news] Supabase not configured — skipping");
    return { written: 0 };
  }

  // Step 4 — quota guard: skip if a google_ai_mode event was written < 20h ago.
  // forceRefresh (used by the seed script) bypasses this so seeding always runs fresh.
  if (!opts?.forceRefresh) {
    try {
      const latest = await latestNewsTimestamp(supabaseUrl, supabaseKey);
      if (latest) {
        const ageHours = (Date.now() - new Date(latest).getTime()) / 3600000;
        if (Number.isFinite(ageHours) && ageHours < CACHE_WINDOW_HOURS) {
          console.log(`[football-news] skipped — cached < 20h ago (${ageHours.toFixed(1)}h)`);
          return { written: 0 };
        }
      }
    } catch (err) {
      console.warn("[football-news] cache guard error (proceeding):", err);
    }
  }

  // Step 1 — fetch all THREE queries (3 SerpApi calls) IN PARALLEL.
  const EMPTY_NEWS: ExtractedNews = { text: "", blockCount: 0, sources: [], citedCorpus: "" };
  const queries: Array<{ label: string; q: string }> = [
    { label: "A (transfers)", q: NEWS_QUERY_A },
    { label: "B (club trophies/results)", q: NEWS_QUERY_B },
    { label: "C (international results)", q: NEWS_QUERY_C },
  ];
  const settled = await Promise.allSettled(
    queries.map((entry) => fetchGoogleAiModeNews(serpApiKey, entry.q)),
  );
  let serpCalls = 0;
  const parts: ExtractedNews[] = settled.map((result, i) => {
    if (result.status === "fulfilled") {
      serpCalls += 1;
      return result.value;
    }
    console.error(`[football-news] query ${queries[i].label} failed:`, result.reason);
    return EMPTY_NEWS;
  });
  const news = mergeNews(parts);
  console.log(`[football-news] SerpApi calls used: ${serpCalls}/3`);
  if (!news.text) {
    console.warn("[football-news] no news text extracted — writing nothing");
    return { written: 0 };
  }

  // Step 2 — SINGLE parse. DeepSeek is primary (forces valid JSON via json_object);
  // then OpenRouter if configured; Gemini is the final fallback. Each provider is tried
  // in turn and the first success wins. If all fail/are absent, write nothing.
  let events: ParsedEvent[] | null = null;

  if (!events && deepseekKey) {
    try {
      events = await parseEventsWithDeepSeek(news.text, deepseekKey);
      const model = process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL_DEFAULT;
      console.log(`[football-news] parsed with DeepSeek (${model})`);
    } catch (dsErr) {
      console.warn(
        `[football-news] DeepSeek failed → next provider · reason=${deepseekFallbackReason(dsErr)}`,
      );
    }
  }

  if (!events && openRouterKey) {
    try {
      events = await parseEventsWithOpenRouter(news.text, openRouterKey);
      const model = process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_MODEL_DEFAULT;
      console.log(`[football-news] parsed with OpenRouter (${model})`);
    } catch (orErr) {
      console.warn(
        `[football-news] OpenRouter failed → next provider · reason=${openRouterFallbackReason(orErr)}`,
      );
    }
  }

  if (!events && geminiKey) {
    try {
      events = await parseEventsWithGemini(news.text, geminiKey);
      console.log("[football-news] parsed with Gemini (fallback)");
    } catch (gErr) {
      console.warn("[football-news] Gemini fallback failed:", gErr);
    }
  }

  if (!events) {
    console.error("[football-news] all parsers failed/absent — writing nothing");
    return { written: 0 };
  }
  const parsedCount = events.length;

  // Citation gate (anti-hallucination): keep only events traceable to a source link.
  const cited = gateByCitation(events, news.citedCorpus);
  events = cited.kept;

  // Player-gate transfers (drop unconfirmed/non-favorite transfers; normalize team).
  const gated = gateTransfers(events);
  events = gated.kept;

  // Final relevance gate (ALL event types): drop any event whose team/player/secondary
  // is not a curated fan-favorite. Runs AFTER the citation + transfer gates.
  const relevance = gateByRelevance(events);
  events = relevance.kept;
  if (relevance.droppedNames.length) {
    console.log(
      `[football-news] dropped ${relevance.droppedNames.length} events ` +
        `(team/player not in tier lists): [${relevance.droppedNames.join(", ")}]`,
    );
  }

  const droppedTotal = cited.dropped + gated.dropped + relevance.droppedNames.length;
  console.log(
    `[football-news] queries: 3, parsed ${parsedCount} from ${news.blockCount} blocks, ` +
      `kept ${events.length} events, dropped ${droppedTotal} (uncited/unconfirmed/non-favorite/off-list) ` +
      `[uncited ${cited.dropped}, transfer-gate ${gated.dropped}, relevance ${relevance.droppedNames.length}] ` +
      `· sources: [${news.sources.join(", ")}]`,
  );
  if (!events.length) return { written: 0 };

  // Step 3 — resolve tier + magnitude, build rows, upsert (no deletes).
  const hasContext = await newsEventsHasContextColumn(supabaseUrl, supabaseKey);
  const nowIso = new Date().toISOString();
  const rows: Record<string, unknown>[] = events.map((ev) => {
    const tierName = ev.player ?? ev.team;
    const tier: Tier = resolveTier(tierName);
    const row: Record<string, unknown> = {
      type: ev.type,
      player: ev.player,
      team: ev.team,
      secondary_team: ev.secondary_team,
      event_date: validEventDate(ev.date, nowIso),
      tier,
      base_m: BASE_M[ev.type],
      source: "google_ai_mode",
      geo: "WW",
    };
    if (hasContext) row.context = ev.context; // display-only; omitted if column absent
    return row;
  });

  try {
    await upsertNewsEvents(supabaseUrl, supabaseKey, rows);
    console.log(
      `[football-news] wrote ${rows.length} events to news_events (source=google_ai_mode` +
        `${hasContext ? ", with context" : ", context column absent — run migration"})`,
    );
  } catch (err) {
    console.error("[football-news] upsert failed — existing rows untouched:", err);
  }
  return { written: rows.length };
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const handler = {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }
    try {
      await refreshFootballNews();
      return jsonResponse({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[football-news] handler error:", message);
      return jsonResponse({ ok: false, error: message }, 500);
    }
  },
};

export default handler;
