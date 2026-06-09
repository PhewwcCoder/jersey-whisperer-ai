// api/botpress-inquiry.ts — live jersey-inquiry capture for the Botpress chatbot.
//
// Add ONE "Execute Code" card in your Botpress flow, right after the user message is
// received, that POSTs the incoming message here. This endpoint asks DeepSeek which
// jersey the message is about and UPSERTs a row into Supabase `jersey_inquiry_events`
// (idempotent on message_id). The `jersey_inquiry_counts` view then keeps growing on
// its own — same data the backfill (scripts/scrape-botpress.ts) writes.
//
// Expected POST body (JSON):
//   { messageId, text, conversationId?, channel?, askedAt? }
// Optional security: set BOTPRESS_WEBHOOK_SECRET in env and send it as the
// `x-webhook-secret` header from Botpress; requests without a matching secret are 401.
//
// Env: DEEPSEEK_API_KEY, SUPABASE_URL (or VITE_SUPABASE_URL),
//      SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY), BOTPRESS_WEBHOOK_SECRET?

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

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
      model: DEEPSEEK_MODEL,
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

function supabaseEnv(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim().replace(/\/$/, "");
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
    const res = await fetch(url, { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } });
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

    const deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const sb = supabaseEnv();
    if (!deepSeekKey || !sb) {
      console.error("[botpress-inquiry] missing DEEPSEEK_API_KEY or Supabase env");
      return jsonResponse({ ok: false, error: "server not configured" }, 500);
    }

    let extracted: Extracted = { team: null, player: null, jersey_type: null, season: null };
    try {
      extracted = await extractOne(text, deepSeekKey);
    } catch (err) {
      // Still record the message (team=null) so it is not silently lost.
      console.warn("[botpress-inquiry] extraction failed, recording raw:", (err as Error).message);
    }

    const conversationId = cleanField(body.conversationId);
    // Context fallback: this message reads like a jersey follow-up (it specifies a kit
    // or season) but named no team — inherit the team from earlier in the conversation.
    if (!extracted.team && (extracted.jersey_type || extracted.season)) {
      const inherited = await lastTeamForConversation(sb, conversationId);
      if (inherited) extracted.team = inherited;
    }

    try {
      await upsertEvent(sb, {
        message_id: messageId,
        conversation_id: conversationId,
        channel: cleanField(body.channel) ?? "webhook",
        raw_text: text,
        team: extracted.team,
        player: extracted.player,
        jersey_type: extracted.jersey_type,
        season: extracted.season,
        source: "webhook",
        asked_at: cleanField(body.askedAt) ?? new Date().toISOString(),
      });
    } catch (err) {
      console.error("[botpress-inquiry] DB write failed:", (err as Error).message);
      return jsonResponse({ ok: false, error: "db_write_failed" }, 500);
    }

    return jsonResponse({ ok: true, team: extracted.team });
  },
};
