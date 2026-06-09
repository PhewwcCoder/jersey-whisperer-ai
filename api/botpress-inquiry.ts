// api/botpress-inquiry.ts — live jersey-inquiry capture for the Botpress chatbot.
//
// Add ONE "Execute Code" card in your Botpress flow, right after the user message is
// received, that POSTs the incoming message here. This endpoint resolves which jersey
// the message is about (DeepSeek when DEEPSEEK_API_KEY is set, else/also a deterministic
// keyword fallback for the common teams) and UPSERTs a row into Supabase
// `jersey_inquiry_events` (idempotent on message_id). The `jersey_inquiry_counts` view
// then keeps growing on its own — same data the backfill (scripts/scrape-botpress.ts) writes.
//
// Expected POST body (JSON):
//   { messageId, text, conversationId?, channel?, askedAt? }
// Optional security: set BOTPRESS_WEBHOOK_SECRET in env and send it as the
// `x-webhook-secret` header from Botpress; requests without a matching secret are 401.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY (or
//      VITE_SUPABASE_ANON_KEY) are REQUIRED. DEEPSEEK_API_KEY and BOTPRESS_WEBHOOK_SECRET
//      are optional. DEEPSEEK_MODEL overrides the default model (deepseek-chat).

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
// Real DeepSeek model id (overridable via DEEPSEEK_MODEL env). "deepseek-v4-flash" was
// not a real model, so every extract call 400'd and the row was stored with team=null.
const DEEPSEEK_MODEL_DEFAULT = "deepseek-chat";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface Extracted {
  team: string | null;
  player: string | null;
  jersey_type: string | null;
  season: string | null;
}

function normalizeTeam(team: string | null): string | null {
  if (!team || typeof team !== "string") return null;
  const t = team.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "none") return null;
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

// Single-message version of the prompt used by scripts/scrape-botpress.ts (keep in sync).
function buildExtractPrompt(text: string): string {
  return [
    "You analyze a customer message sent to a Bangladeshi football-jersey shop's chatbot.",
    "Messages are often in Banglish (Bengali in English letters) or English. Examples:",
    '  "argentinar lagto" = wants the Argentina jersey',
    '  "home 2xl lagto 2026 er" = wants the 2026 Home jersey, size 2XL',
    '  "away 2022 shal er wc ase?" = asking if the 2022 World Cup Away jersey is available',
    '  "messi r jersey ase?" = asking about a Messi jersey',
    "",
    "Decide if the customer is asking about a specific football jersey (team or player).",
    "Return ONLY a JSON object of this exact shape:",
    '{ "team": <string|null>, "player": <string|null>, "jersey_type": <"home"|"away"|"third"|"retro"|null>, "season": <string|null> }',
    "Rules:",
    '- "team": canonical ENGLISH club/country name (e.g. "Argentina", "Real Madrid", "Brazil").',
    "  If only a player is named, infer the team if obvious (Messi→Argentina, Ronaldo→Portugal), else null.",
    "- If the message is NOT about a jersey (greeting, thanks, payment/delivery, random text), set all four to null.",
    '- "jersey_type": home/away/third/retro only if clearly stated, else null.',
    '- "season": any year/edition mentioned (e.g. "2026", "2022 WC"), else null.',
    "- Do NOT invent a team. Only output a team you are confident the customer referred to.",
    "Message:",
    text.replace(/\s+/g, " ").trim(),
  ].join("\n");
}

interface DeepSeekUpstream {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function extractOne(text: string, deepSeekKey: string): Promise<Extracted> {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepSeekKey}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL_DEFAULT,
      messages: [
        { role: "system", content: "You output only valid JSON, no prose, no markdown fences." },
        { role: "user", content: buildExtractPrompt(text) },
      ],
      temperature: 0,
      max_tokens: 256,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = (await res.json()) as DeepSeekUpstream;
  if (payload.error) throw new Error(`DeepSeek error: ${payload.error.message ?? "unknown"}`);
  const content = (payload.choices?.[0]?.message?.content ?? "").trim();
  const o = JSON.parse(content) as Record<string, unknown>;
  return {
    team: normalizeTeam(cleanField(o.team)),
    player: cleanField(o.player),
    jersey_type: cleanField(o.jersey_type),
    season: cleanField(o.season),
  };
}

// ── Deterministic keyword fallback ────────────────────────────────────────────
// Used when DeepSeek is unavailable (no key / HTTP error) OR returns no team. Covers
// the clubs/countries sellers ask about most. Matching is on lowercased, punctuation-
// stripped text, so Banglish suffixes still hit (e.g. "argentinar" contains "argentina",
// "madrider" contains "madrid"). First match wins; multi-word aliases are listed first.
const TEAM_ALIASES: Array<{ team: string; aliases: string[] }> = [
  { team: "Real Madrid", aliases: ["real madrid", "madrid", "rma"] },
  {
    team: "Manchester United",
    aliases: ["manchester united", "man united", "man utd", "man u", "manutd"],
  },
  { team: "Manchester City", aliases: ["manchester city", "man city", "mancity"] },
  { team: "Inter Miami", aliases: ["inter miami", "miami"] },
  { team: "Barcelona", aliases: ["barcelona", "barca", "barça", "fcb"] },
  { team: "Liverpool", aliases: ["liverpool", "lfc"] },
  { team: "Arsenal", aliases: ["arsenal", "gunners"] },
  { team: "Chelsea", aliases: ["chelsea", "cfc"] },
  { team: "PSG", aliases: ["psg", "paris saint-germain", "paris saint germain", "paris sg"] },
  { team: "Argentina", aliases: ["argentina", "albiceleste"] },
  { team: "Portugal", aliases: ["portugal"] },
  { team: "Brazil", aliases: ["brazil", "brasil"] },
  { team: "Germany", aliases: ["germany", "deutschland"] },
];

// Player → team inference (mirrors the DeepSeek prompt's Messi→Argentina etc.).
const PLAYER_TEAM: Array<{ player: string; team: string; aliases: string[] }> = [
  { player: "Messi", team: "Argentina", aliases: ["messi"] },
  { player: "Ronaldo", team: "Portugal", aliases: ["ronaldo", "cr7"] },
  { player: "Neymar", team: "Brazil", aliases: ["neymar"] },
];

function detectJerseyType(t: string): string | null {
  if (/\bhome\b/.test(t)) return "home";
  if (/\baway\b/.test(t)) return "away";
  if (/\bthird\b|\b3rd\b/.test(t)) return "third";
  if (/\bretro\b/.test(t)) return "retro";
  return null;
}

function detectSeason(t: string): string | null {
  const year = /\b(20\d{2})\b/.exec(t);
  return year ? year[1] : null;
}

function keywordExtract(rawText: string): Extracted {
  const t = rawText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  let team: string | null = null;
  let player: string | null = null;

  for (const entry of TEAM_ALIASES) {
    if (entry.aliases.some((a) => t.includes(a))) {
      team = entry.team;
      break;
    }
  }
  for (const entry of PLAYER_TEAM) {
    if (entry.aliases.some((a) => t.includes(a))) {
      player = entry.player;
      if (!team) team = entry.team;
      break;
    }
  }
  return { team, player, jersey_type: detectJerseyType(t), season: detectSeason(t) };
}

function supabaseEnv(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
    ?.trim()
    .replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

// Most-recent non-null team already recorded for this conversation. Lets a live
// follow-up message that names no team (e.g. "away 2022 ase?") inherit the team the
// customer mentioned earlier — the single-message equivalent of the backfill's
// per-conversation context.
async function lastTeamForConversation(
  sb: { url: string; key: string },
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const url =
      `${sb.url}/rest/v1/jersey_inquiry_events` +
      `?select=team&conversation_id=eq.${encodeURIComponent(conversationId)}` +
      `&team=not.is.null&order=asked_at.desc&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ team?: string }>;
    return rows[0]?.team ?? null;
  } catch {
    return null;
  }
}

async function upsertEvent(
  sb: { url: string; key: string },
  row: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${sb.url}/rest/v1/jersey_inquiry_events?on_conflict=message_id`, {
    method: "POST",
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return jsonResponse({ ok: true });
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405);
    }

    // Optional shared-secret gate.
    const secret = process.env.BOTPRESS_WEBHOOK_SECRET?.trim();
    if (secret && request.headers.get("x-webhook-secret") !== secret) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }

    const messageId = cleanField(body.messageId);
    const text = cleanField(body.text);
    if (!messageId || !text) {
      return jsonResponse({ ok: false, error: "messageId and text are required" }, 400);
    }

    // Supabase is the only HARD requirement. DeepSeek is optional — without it (or if it
    // errors) the deterministic keyword extractor still resolves common teams.
    const sb = supabaseEnv();
    if (!sb) {
      console.error(
        "[botpress-inquiry] missing_supabase_env — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      );
      return jsonResponse({ ok: false, error: "missing_supabase_env" }, 500);
    }
    const deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const conversationId = cleanField(body.conversationId);
    const channel = cleanField(body.channel) ?? "webhook";

    console.log(
      `[botpress-inquiry] method=${request.method} bodyKeys=[${Object.keys(body).join(",")}]` +
        ` messageId=${messageId} channel=${channel} deepseek=${Boolean(deepSeekKey)}`,
    );
    console.log(`[botpress-inquiry] text="${text.slice(0, 160)}"`);

    // 1) DeepSeek (when configured). 2) keyword fallback fills any gaps, or is the whole
    // result when DeepSeek is absent/failed. Extraction never blocks the write.
    let extracted: Extracted = { team: null, player: null, jersey_type: null, season: null };
    let via = "keyword";
    if (deepSeekKey) {
      try {
        extracted = await extractOne(text, deepSeekKey);
        via = "deepseek";
      } catch (err) {
        console.warn(
          "[botpress-inquiry] DeepSeek extraction failed, using keyword fallback:",
          (err as Error).message,
        );
      }
    }

    const kw = keywordExtract(text);
    if (!extracted.team && kw.team) {
      extracted.team = kw.team;
      via = via === "deepseek" ? "deepseek+keyword" : "keyword";
    }
    extracted.player ??= kw.player;
    extracted.jersey_type ??= kw.jersey_type;
    extracted.season ??= kw.season;

    // Context fallback: a jersey follow-up that names a kit/season but no team inherits
    // the team mentioned earlier in the same conversation.
    if (!extracted.team && (extracted.jersey_type || extracted.season)) {
      const inherited = await lastTeamForConversation(sb, conversationId);
      if (inherited) {
        extracted.team = inherited;
        via += "+context";
      }
    }

    console.log(
      `[botpress-inquiry] extracted team=${extracted.team ?? "null"} player=${extracted.player ?? "null"}` +
        ` type=${extracted.jersey_type ?? "null"} season=${extracted.season ?? "null"} via=${via}`,
    );

    try {
      await upsertEvent(sb, {
        message_id: messageId,
        conversation_id: conversationId,
        channel,
        raw_text: text,
        team: extracted.team,
        player: extracted.player,
        jersey_type: extracted.jersey_type,
        season: extracted.season,
        source: "webhook",
        asked_at: cleanField(body.askedAt) ?? new Date().toISOString(),
      });
    } catch (err) {
      const detail = (err as Error).message;
      console.error("[botpress-inquiry] db_write_failed:", detail);
      // `detail` is the Supabase status + body slice (no secrets) — e.g. relation
      // "jersey_inquiry_events" does not exist → run supabase/jersey_inquiry.sql.
      return jsonResponse({ ok: false, error: "db_write_failed", detail }, 500);
    }

    console.log(
      `[botpress-inquiry] stored message_id=${messageId} team=${extracted.team ?? "null"}`,
    );
    return jsonResponse({ ok: true, stored: true, team: extracted.team, messageId });
  },
};
