/**
 * THROWAWAY DIAGNOSTIC — Google AI Mode football-news pipeline (end-to-end).
 *
 * Verifies the REAL pipeline with live data WITHOUT writing to Supabase and WITHOUT
 * modifying any refresh file:
 *   1. loads SERPAPI_KEY + GEMINI_API_KEY from .env.local (masked),
 *   2. calls SerpApi google_ai_mode with the SAME query the real code uses,
 *   3. prints the RAW first-3 text_blocks so you can see real field names,
 *   4. runs the (copied) extractNewsText() — reports chars + citation corpus size,
 *   5. sends the text to Gemini with the REAL prompt, prints raw + parsed events,
 *   6. applies the citation gate and shows kept vs uncited-dropped.
 *
 * The extraction/parse/prompt/gate logic below is COPIED verbatim from
 * api/football-news-refresh.ts (its internals are not exported, and that file must
 * not be modified). If you change the real file, mirror the change here.
 *
 * Run:  npx tsx scripts/test-football-news.ts
 */

import { readFileSync } from "node:fs";

const SERPAPI_SEARCH = "https://serpapi.com/search";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// ── COPIED from football-news-refresh.ts (keep in sync) ───────────────────────
const NEWS_QUERY_A =
  "Search the web for today's breaking football transfer news, official signings, and high-profile rumors involving superstars at elite global clubs (e.g., Real Madrid, Man City, Barcelona, Arsenal, etc.). List the top 5 most impactful player movements or rumors dominating global headlines right now. For each, name the exact Player Edition jersey that will see an immediate demand spike globally and locally.";
const NEWS_QUERY_B =
  "Search the web for the latest major match victories, league titles, or cup trophies won by top-tier European clubs. Identify the 3–5 club teams experiencing the highest post-victory fan celebration and media hype right now. List the winning team's current jersey (Home/Away/Special Edition) that I should immediately stock to capitalize on this winning momentum.";
const NEWS_QUERY_C =
  "Search the web for recent results in major, competitive international football tournaments (e.g., World Cup qualifiers, Euros, Copa America, Nations League—strictly exclude friendly matches). Identify the top 3 national teams that just won crucial matches or advanced significantly, triggering global fan hype. State which national team jerseys I need to stock right now to meet the sudden surge in international fan demand.";
const MAX_NEWS_CHARS = 4000;

type NewsEventType =
  | "trophy"
  | "transfer"
  | "wc_final"
  | "kit_release"
  | "retirement"
  | "performance";

const VALID_TYPES: ReadonlySet<string> = new Set<NewsEventType>([
  "trophy",
  "transfer",
  "wc_final",
  "kit_release",
  "retirement",
  "performance",
]);

interface ExtractedNews {
  text: string;
  blockCount: number;
  sources: string[];
  citedCorpus: string;
}

// Recursive walker mirroring the real extractNewsText (google_ai_mode shape).
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

  const recordSnippet = (text: string, b: Record<string, unknown>) => {
    if (!text) return;
    parts.push(text);
    const links = b.snippet_links;
    if (Array.isArray(links) && links.length) citedParts.push(text.toLowerCase());
  };

  const captureCodeBlock = (b: Record<string, unknown>) => {
    pushString(asString(b.snippet) || asString(b.code) || asString(b.text));
  };

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

  let text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_NEWS_CHARS) text = text.slice(0, MAX_NEWS_CHARS);

  return { text, blockCount, sources: [...sources].slice(0, 12), citedCorpus: citedParts.join("\n") };
}

interface ParsedEvent {
  type: NewsEventType;
  team: string;
  secondary_team: string | null;
  player: string | null;
  headline: string;
  context: string | null;
  date: string | null;
}

// Merge N extracted-news results (copied from the real file; 3-query cap = 12000).
function mergeNews(parts: ExtractedNews[]): ExtractedNews {
  const cap = MAX_NEWS_CHARS * 3;
  let text = parts.map((p) => p.text).filter(Boolean).join("\n\n");
  if (text.length > cap) text = text.slice(0, cap);
  return {
    text,
    blockCount: parts.reduce((sum, p) => sum + p.blockCount, 0),
    sources: [...new Set(parts.flatMap((p) => p.sources))].slice(0, 18),
    citedCorpus: parts.map((p) => p.citedCorpus).filter(Boolean).join("\n"),
  };
}

function buildGeminiPrompt(newsText: string): string {
  const today = new Date().toISOString().slice(0, 10);
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

function safeParseEvents(raw: string, opts?: { strict?: boolean }): ParsedEvent[] {
  if (!raw) {
    if (opts?.strict) throw new Error("parser returned empty output");
    return [];
  }
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
      if (!VALID_TYPES.has(type) || !team) continue;
      events.push({
        type: type as NewsEventType,
        team,
        secondary_team:
          typeof e.secondary_team === "string" && e.secondary_team.trim()
            ? e.secondary_team.trim()
            : null,
        player: typeof e.player === "string" && e.player.trim() ? e.player.trim() : null,
        headline: typeof e.headline === "string" ? e.headline.trim() : "",
        context:
          typeof e.context === "string" && e.context.trim() ? e.context.trim().slice(0, 140) : null,
        date: typeof e.date === "string" && e.date.trim() ? e.date.trim() : null,
      });
    }
    return events;
  } catch (err) {
    if (opts?.strict) throw err instanceof Error ? err : new Error(String(err));
    console.error("[diag] JSON parse failed:", err);
    return [];
  }
}

interface DeepSeekUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

// PRIMARY parser (mirrors football-news-refresh.ts): DeepSeek deepseek-v4-flash with
// json_object mode, strict parse so unparseable output throws → caller falls back to Gemini.
async function parseEventsWithDeepSeek(newsText: string, deepSeekKey: string): Promise<ParsedEvent[]> {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepSeekKey}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildGeminiPrompt(newsText) },
      ],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = (await res.json()) as DeepSeekUpstream;
  if (payload.error) throw new Error(`DeepSeek error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  return safeParseEvents(content, { strict: true });
}

// Citation gate (copied from the real file).
function entityCited(name: string | null, corpus: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (!n) return false;
  if (corpus.includes(n)) return true;
  return n.split(/\s+/).filter((t) => t.length > 3).some((t) => corpus.includes(t));
}
function gateByCitation(events: ParsedEvent[], corpus: string): { kept: ParsedEvent[]; dropped: number } {
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
// ── end copied block ──────────────────────────────────────────────────────────

// ── env loading (no dotenv dependency) ────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const name = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[name] = value;
    }
  } catch (error) {
    console.error("Could not read .env.local:", (error as Error).message);
  }
  return out;
}

function mask(key: string | undefined): string {
  if (!key) return "MISSING";
  return `present (${key.slice(0, 4)}...)`;
}

interface GeminiUpstream {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

function line() {
  console.log("─".repeat(72));
}

async function main() {
  let apiCalls = 0;

  line();
  console.log("GOOGLE AI MODE FOOTBALL-NEWS PIPELINE DIAGNOSTIC (throwaway)");
  line();

  const env = loadEnv();
  const serpKey = env.SERPAPI_KEY;
  const geminiKey = env.GEMINI_API_KEY;
  const deepSeekKey = env.DEEPSEEK_API_KEY;
  console.log(`SERPAPI_KEY      : ${mask(serpKey)}`);
  console.log(`DEEPSEEK_API_KEY : ${mask(deepSeekKey)}`);
  console.log(`GEMINI_API_KEY   : ${mask(geminiKey)}`);
  if (!serpKey || (!deepSeekKey && !geminiKey)) {
    console.error("Need SERPAPI_KEY and at least one of DEEPSEEK_API_KEY / GEMINI_API_KEY — aborting.");
    process.exit(1);
  }

  // ── Step 1: THREE SerpApi google_ai_mode calls (A=transfers, B=club, C=intl) ─
  const fetchAiMode = async (label: string, query: string) => {
    console.log(`\n[${label}] query: ${query}`);
    const params = new URLSearchParams({ engine: "google_ai_mode", q: query, api_key: serpKey });
    const r = await fetch(`${SERPAPI_SEARCH}?${params.toString()}`);
    apiCalls += 1;
    console.log(`[${label}] HTTP status: ${r.status}`);
    const body = await r.text();
    let d: Record<string, unknown> | null = null;
    try {
      d = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      d = null;
    }
    if (!d) {
      console.error(`[${label}] non-JSON body (first 400): ${body.slice(0, 400)}`);
      return extractNewsText({});
    }
    if (d.error) console.log(`[${label}] SerpApi error: ${JSON.stringify(d.error)}`);
    const blocks = Array.isArray(d.text_blocks) ? (d.text_blocks as unknown[]) : [];
    console.log(`[${label}] text_blocks: ${blocks.length}, references: ${Array.isArray(d.references) ? (d.references as unknown[]).length : 0}`);
    return extractNewsText(d);
  };

  line();
  console.log("STEP 1 — SerpApi google_ai_mode (3 queries)");
  line();
  const a = await fetchAiMode("A transfers", NEWS_QUERY_A);
  const b = await fetchAiMode("B club trophies", NEWS_QUERY_B);
  const c = await fetchAiMode("C international", NEWS_QUERY_C);

  // ── Step 2: merge + run the REAL extraction/merge logic ─────────────────────
  line();
  console.log("STEP 2 — mergeNews() combined output");
  line();
  const extracted = mergeNews([a, b, c]);
  console.log(`blocks walked    : ${extracted.blockCount}`);
  console.log(`chars extracted  : ${extracted.text.length}`);
  console.log(`citation corpus  : ${extracted.citedCorpus.length} chars`);
  console.log(`sources captured : ${JSON.stringify(extracted.sources)}`);
  console.log("\nFirst 500 chars of extracted text:");
  console.log(extracted.text.slice(0, 500) || "(EMPTY — extraction field names likely wrong)");

  if (!extracted.text) {
    line();
    console.log("REPORT");
    line();
    console.log("(a) Text extraction: FAILED — 0 chars. Inspect the RAW blocks above and");
    console.log("    update extractNewsText() field names in football-news-refresh.ts.");
    console.log(`(c) Total API calls used: ${apiCalls} (1 SerpApi, 0 Gemini).`);
    line();
    return;
  }

  // ── Step 3: parse — DeepSeek primary, Gemini fallback (mirrors real pipeline) ─
  line();
  console.log("STEP 3 — parse (DeepSeek deepseek-v4-flash primary → Gemini fallback)");
  line();
  let events: ParsedEvent[] = [];
  let parserUsed = "none";
  if (deepSeekKey) {
    try {
      events = await parseEventsWithDeepSeek(extracted.text, deepSeekKey);
      apiCalls += 1;
      parserUsed = "DeepSeek (deepseek-v4-flash)";
      console.log("parsed with DeepSeek (deepseek-v4-flash)");
    } catch (dsErr) {
      apiCalls += 1; // the DeepSeek attempt still consumed a call
      console.warn("DeepSeek failed, falling back to Gemini:", (dsErr as Error).message);
    }
  }
  if (parserUsed === "none") {
    if (!geminiKey) {
      console.error("No Gemini fallback key — cannot parse.");
    } else {
      const geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(extracted.text) }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
        }),
      });
      apiCalls += 1;
      console.log(`Gemini HTTP status: ${geminiRes.status}`);
      const geminiBody = (await geminiRes.json()) as GeminiUpstream;
      if (geminiBody.error) console.log(`Gemini error: ${JSON.stringify(geminiBody.error)}`);
      const geminiRaw = (geminiBody.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p?.text ?? "")
        .join("")
        .trim();
      console.log("\nRAW Gemini text response:");
      console.log(geminiRaw || "(empty)");
      events = safeParseEvents(geminiRaw);
      parserUsed = "Gemini (fallback)";
    }
  }
  console.log(`\nparser used: ${parserUsed}`);
  console.log("Parsed + validated event array:");
  console.log(JSON.stringify(events, null, 2));

  // ── Step 4: citation gate ───────────────────────────────────────────────────
  line();
  console.log("STEP 4 — citation gate");
  line();
  const gated = gateByCitation(events, extracted.citedCorpus);
  console.log(`kept ${gated.kept.length} cited events, dropped ${gated.dropped} uncited events`);
  console.log(JSON.stringify(gated.kept, null, 2));

  // ── Report ──────────────────────────────────────────────────────────────────
  line();
  console.log("REPORT");
  line();
  console.log(
    `(a) Text extraction: ${extracted.text.length > 50 ? "WORKED" : "WEAK"} — ` +
      `${extracted.text.length} chars from ${extracted.blockCount} blocks; ` +
      `citation corpus ${extracted.citedCorpus.length} chars.`,
  );
  console.log(
    `(b) ${parserUsed} parsed ${events.length}, citation-gated to ${gated.kept.length}: ` +
      (gated.kept.length
        ? gated.kept
            .map((e) => `${e.type}:${e.team}${e.player ? `/${e.player}` : ""}${e.date ? ` @${e.date}` : ""}${e.context ? ` [ctx: ${e.context}]` : ""}`)
            .join(", ")
        : "none kept"),
  );
  console.log(`(c) Total API calls used: ${apiCalls} (3 SerpApi + 1 parse via ${parserUsed}).`);
  line();
}

main().catch((error) => {
  console.error("Diagnostic failed:", error);
  process.exit(1);
});
