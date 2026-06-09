/**
 * Botpress conversation backfill → jersey-inquiry counts.
 *
 * Pulls EVERY conversation + message for the bot via the Botpress Cloud API, keeps
 * only incoming (customer) text messages, asks DeepSeek which jersey each one is about
 * (messages are usually Banglish, e.g. "argentinar lagto", "home 2xl lagto 2026 er"),
 * and UPSERTs one row per message into Supabase `jersey_inquiry_events`. The
 * `jersey_inquiry_counts` VIEW then gives "how many times each jersey was asked for".
 *
 * Idempotent: rows conflict on Botpress `message_id` (do-nothing), so re-running only
 * adds messages that appeared since last run — never double-counts.
 *
 * Env (.env.local):
 *   BOTPRESS_PAT            bp_pat_...   (Personal Access Token)
 *   BOTPRESS_BOT_ID         <bot uuid>
 *   DEEPSEEK_API_KEY        sk-...       (api.deepseek.com)
 *   SUPABASE_URL            https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   (service role; falls back to VITE_SUPABASE_ANON_KEY)
 *
 * Run:  npm run botpress:backfill
 *       npm run botpress:backfill:dry
 *       npx tsx scripts/scrape-botpress.ts --dry --limit=5 --since=2026-06-01
 */

import { readFileSync } from "node:fs";

const BOTPRESS_API = "https://api.botpress.cloud/v1/chat";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
// Real DeepSeek model id (was "deepseek-v4-flash", which is not a real model and 400'd).
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";
const DRY_RUN = process.argv.includes("--dry");
const CONVERSATION_LIMIT = numberFlag(["--limit", "--conversation-limit"]);
const SINCE = dateFlag("--since");

function flagValue(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact !== -1) return process.argv[exact + 1];
  const prefix = `${name}=`;
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix));
  return withEquals ? withEquals.slice(prefix.length) : undefined;
}

function numberFlag(names: string[]): number | undefined {
  for (const name of names) {
    const value = flagValue(name);
    if (!value) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function dateFlag(name: string): number | undefined {
  const value = flagValue(name);
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── env loading (mirrors scripts/test-football-news.ts; no dotenv dependency) ──
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
  return key ? `present (${key.slice(0, 6)}...)` : "MISSING";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Botpress API ───────────────────────────────────────────────────────────────
interface BpConversation {
  id: string;
  channel?: string;
  integration?: string;
  messageCount?: number;
}
interface BpMessage {
  id: string;
  conversationId: string;
  createdAt: string;
  direction: "incoming" | "outgoing";
  type: string;
  payload?: { text?: string };
}

function bpHeaders(pat: string, botId: string): Record<string, string> {
  return { Authorization: `Bearer ${pat}`, "x-bot-id": botId };
}

async function bpGet<T>(url: string, pat: string, botId: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: bpHeaders(pat, botId) });
    if (res.ok) return (await res.json()) as T;
    // 429/5xx → back off and retry; everything else is fatal.
    if (res.status === 429 || res.status >= 500) {
      const wait = 800 * (attempt + 1);
      console.warn(`  Botpress ${res.status} on ${url} — retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Botpress HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`Botpress GET failed after retries: ${url}`);
}

// Page through conversations (nextToken pagination). Botpress currently caps pages
// at 20 conversations, so the loop matters even when a larger limit is requested.
async function listAllConversations(
  pat: string,
  botId: string,
  maxConversations?: number,
): Promise<BpConversation[]> {
  const all: BpConversation[] = [];
  let nextToken: string | undefined;
  do {
    const url = new URL(`${BOTPRESS_API}/conversations`);
    url.searchParams.set("limit", "20");
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const page = await bpGet<{ conversations: BpConversation[]; meta?: { nextToken?: string } }>(
      url.toString(),
      pat,
      botId,
    );
    all.push(...(page.conversations ?? []));
    if (maxConversations && all.length >= maxConversations) {
      const limited = all.slice(0, maxConversations);
      process.stdout.write(`\r  conversations fetched: ${limited.length}`);
      return limited;
    }
    nextToken = page.meta?.nextToken;
    process.stdout.write(`\r  conversations fetched: ${all.length}`);
  } while (nextToken);
  process.stdout.write("\n");
  return all;
}

// Page through ALL messages of one conversation.
async function listAllMessages(
  conversationId: string,
  pat: string,
  botId: string,
): Promise<BpMessage[]> {
  const all: BpMessage[] = [];
  let nextToken: string | undefined;
  do {
    const url = new URL(`${BOTPRESS_API}/messages`);
    url.searchParams.set("conversationId", conversationId);
    url.searchParams.set("limit", "100");
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const page = await bpGet<{ messages: BpMessage[]; meta?: { nextToken?: string } }>(
      url.toString(),
      pat,
      botId,
    );
    all.push(...(page.messages ?? []));
    nextToken = page.meta?.nextToken;
  } while (nextToken);
  return all;
}

// ── DeepSeek extraction ─────────────────────────────────────────────────────────
interface CustomerMsg {
  messageId: string;
  conversationId: string;
  channel: string;
  text: string;
  askedAt: string;
}
interface Extracted {
  team: string | null;
  player: string | null;
  jersey_type: string | null;
  season: string | null;
}

// One conversation's customer messages, IN ORDER. The prompt tells DeepSeek to carry
// the team forward across the conversation so a follow-up like "away 2022 ase?" (which
// names no team) still resolves to the team mentioned earlier in the same chat.
function buildConversationPrompt(msgs: CustomerMsg[]): string {
  const numbered = msgs.map((m, i) => `${i}. ${m.text.replace(/\s+/g, " ").trim()}`).join("\n");
  return [
    "You analyze ONE customer's messages to a Bangladeshi football-jersey shop's chatbot.",
    "All messages below are from the SAME customer in the SAME conversation, in time order.",
    "Messages are often in Banglish (Bengali written in English letters) or English. Examples:",
    '  "argentinar lagto" = wants the Argentina jersey',
    '  "home 2xl lagto 2026 er" = wants the 2026 Home jersey in size 2XL',
    '  "away 2022 shal er wc ase?" = asking if the 2022 World Cup Away jersey is available',
    '  "messi r jersey ase?" = asking about a Messi jersey',
    "",
    "For EACH numbered message decide which football jersey (team/player) it is about.",
    "Return ONLY a JSON object of this exact shape:",
    '{ "items": [ { "i": <number>, "team": <string|null>, "player": <string|null>, "jersey_type": <"home"|"away"|"third"|"retro"|null>, "season": <string|null> } ] }',
    "Rules:",
    "- One result object per input message, keyed by its number `i`. Include every message.",
    "- CRITICAL — use conversation context: if an EARLIER message named a team and a LATER",
    "  message is a follow-up about a jersey (asks only about size/kit/year/availability/price",
    '  without re-naming the team), assign that SAME team to the later message. Example:',
    '  "argentinar lagto" then "away 2022 ase?" → BOTH are team "Argentina".',
    '- "team": canonical ENGLISH club/country name (e.g. "Argentina", "Real Madrid", "Brazil").',
    '  If only a player is named, infer the team if obvious (Messi→Argentina, Ronaldo→Portugal).',
    "- Only assign a team to a message that is ITSELF asking about a jersey (its price,",
    "  availability, size, kit, year, or variant). For greetings, thanks, payment/delivery,",
    "  or messages asking for something OTHER than that team (e.g. 'anything cheaper than",
    "  Brazil?'), set team, player, jersey_type and season all to null.",
    '- "jersey_type": home/away/third/retro only if stated (or carried from context), else null.',
    '- "season": any year/edition mentioned or carried from context (e.g. "2026", "2022 WC"), else null.',
    "- Do NOT invent teams. Only output a team the customer actually referred to.",
    "Messages:",
    numbered,
  ].join("\n");
}

interface DeepSeekUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

function normalizeTeam(team: string | null): string | null {
  if (!team || typeof team !== "string") return null;
  const t = team.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "none") return null;
  // Title-case each word so "argentina" and "Argentina" collapse to one bucket.
  return t
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function cleanField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.toLowerCase() !== "null" ? s : null;
}

// Extract one conversation's messages with full intra-conversation context.
async function extractConversation(
  msgs: CustomerMsg[],
  deepSeekKey: string,
): Promise<Map<string, Extracted>> {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepSeekKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildConversationPrompt(msgs) },
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

  const out = new Map<string, Extracted>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn("  DeepSeek returned unparseable JSON for a conversation — skipping it.");
    return out;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const idx = typeof o.i === "number" ? o.i : Number(o.i);
    const msg = msgs[idx];
    if (!msg) continue;
    out.set(msg.messageId, {
      team: normalizeTeam(cleanField(o.team)),
      player: cleanField(o.player),
      jersey_type: cleanField(o.jersey_type),
      season: cleanField(o.season),
    });
  }
  return out;
}

// ── Supabase write (raw PostgREST, mirrors api/classify-jerseys.ts) ──────────────
interface EventRow {
  message_id: string;
  conversation_id: string;
  channel: string;
  raw_text: string;
  team: string | null;
  player: string | null;
  jersey_type: string | null;
  season: string | null;
  source: string;
  asked_at: string;
}

async function upsertEvents(
  rows: EventRow[],
  sbUrl: string,
  sbKey: string,
): Promise<number> {
  if (!rows.length) return 0;
  let written = 0;
  // Chunk to keep request bodies reasonable.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(
      `${sbUrl}/rest/v1/jersey_inquiry_events?on_conflict=message_id`,
      {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          // merge-duplicates: message_id is UNIQUE, so this updates the existing row
          // for a message rather than inserting a second one — re-running the backfill
          // refreshes the extraction WITHOUT ever double-counting.
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      },
    );
    if (!res.ok) {
      console.error(`  Supabase upsert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    } else {
      written += chunk.length;
    }
  }
  return written;
}

// ── main ─────────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();
  const pat = env.BOTPRESS_PAT;
  const botId = env.BOTPRESS_BOT_ID;
  const deepSeekKey = env.DEEPSEEK_API_KEY;
  const sbUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL)?.replace(/\/$/, "");
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

  console.log("Botpress jersey-inquiry backfill" + (DRY_RUN ? "  [DRY RUN — no DB writes]" : ""));
  console.log(`  BOTPRESS_PAT     : ${mask(pat)}`);
  console.log(`  BOTPRESS_BOT_ID  : ${botId || "MISSING"}`);
  console.log(`  DEEPSEEK_API_KEY : ${mask(deepSeekKey)}`);
  console.log(`  SUPABASE_URL     : ${sbUrl || "MISSING"}`);
  console.log(`  SUPABASE key     : ${mask(sbKey)}`);
  console.log(`  limit            : ${CONVERSATION_LIMIT ?? "all conversations"}`);
  console.log(`  since            : ${SINCE ? new Date(SINCE).toISOString() : "all history"}`);

  if (!pat || !botId) {
    console.error("Need BOTPRESS_PAT and BOTPRESS_BOT_ID — aborting.");
    process.exit(1);
  }
  if (!deepSeekKey) {
    console.error("Need DEEPSEEK_API_KEY — aborting.");
    process.exit(1);
  }
  if (!DRY_RUN && (!sbUrl || !sbKey)) {
    console.error("Need SUPABASE_URL + a Supabase key (or pass --dry) — aborting.");
    process.exit(1);
  }

  // 1) Pull every conversation, then every message, keep incoming text only.
  console.log("\nStep 1 — fetching conversations…");
  const conversations = await listAllConversations(pat, botId, CONVERSATION_LIMIT);
  console.log(`  ${conversations.length} conversations total.`);

  console.log("Step 2 — fetching messages + grouping customer texts by conversation…");
  // Keep messages grouped per conversation and IN ORDER so extraction has context.
  const convGroups: CustomerMsg[][] = [];
  const customerMsgs: CustomerMsg[] = [];
  let done = 0;
  for (const conv of conversations) {
    done += 1;
    if (conv.messageCount === 0) continue; // skip empty webchat test sessions
    const messages = await listAllMessages(conv.id, pat, botId);
    const group: CustomerMsg[] = [];
    for (const m of messages) {
      const text = m.payload?.text?.trim();
      if (SINCE && Date.parse(m.createdAt) < SINCE) continue;
      if (m.direction === "incoming" && m.type === "text" && text) {
        group.push({
          messageId: m.id,
          conversationId: m.conversationId,
          channel: conv.integration || conv.channel || "unknown",
          text,
          askedAt: m.createdAt,
        });
      }
    }
    if (group.length) {
      // Botpress returns newest-first; sort ascending so context flows forward.
      group.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
      convGroups.push(group);
      customerMsgs.push(...group);
    }
    if (done % 20 === 0 || done === conversations.length) {
      process.stdout.write(`\r  conversations processed: ${done}/${conversations.length}, customer messages: ${customerMsgs.length}`);
    }
  }
  process.stdout.write("\n");
  console.log(`  ${customerMsgs.length} customer text messages across ${convGroups.length} conversations.`);

  if (!customerMsgs.length) {
    console.log("Nothing to extract. Done.");
    return;
  }

  // 3) DeepSeek extraction — one call per conversation, with intra-conversation context
  //    so follow-up messages inherit the team named earlier in the same chat.
  console.log(`Step 3 — extracting jerseys with DeepSeek (${DEEPSEEK_MODEL}, per-conversation)…`);
  const extractions = new Map<string, Extracted>();
  let extractedConvs = 0;
  for (const group of convGroups) {
    try {
      const got = await extractConversation(group, deepSeekKey);
      for (const [k, v] of got) extractions.set(k, v);
    } catch (err) {
      console.warn(`  conversation ${group[0]?.conversationId} failed: ${(err as Error).message}`);
    }
    extractedConvs += 1;
    process.stdout.write(`\r  extracted ${extractedConvs}/${convGroups.length} conversations`);
  }
  process.stdout.write("\n");

  // 4) Build rows + tally.
  const rows: EventRow[] = customerMsgs.map((m) => {
    const e = extractions.get(m.messageId) ?? { team: null, player: null, jersey_type: null, season: null };
    return {
      message_id: m.messageId,
      conversation_id: m.conversationId,
      channel: m.channel,
      raw_text: m.text,
      team: e.team,
      player: e.player,
      jersey_type: e.jersey_type,
      season: e.season,
      source: "backfill",
      asked_at: m.askedAt,
    };
  });

  const tally = new Map<string, number>();
  for (const r of rows) if (r.team) tally.set(r.team, (tally.get(r.team) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  console.log("\nJersey demand (this run):");
  if (ranked.length === 0) {
    console.log("  (no jersey requests detected)");
  } else {
    for (const [team, n] of ranked) console.log(`  ${String(n).padStart(4)}  ×  ${team}`);
  }
  const withTeam = rows.filter((r) => r.team).length;
  console.log(`\n  ${withTeam}/${rows.length} messages were jersey requests across ${ranked.length} teams.`);

  // 5) Write.
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Skipping Supabase write. Re-run without --dry to persist.");
    return;
  }
  console.log("\nStep 4 — writing to Supabase (idempotent on message_id)…");
  const written = await upsertEvents(rows, sbUrl as string, sbKey as string);
  console.log(`  upserted ${written} event rows.`);
  console.log("\nDone. Read public.jersey_inquiry_counts for the live ranking.");
}

main().catch((error) => {
  console.error("\nBackfill failed:", error);
  process.exit(1);
});
