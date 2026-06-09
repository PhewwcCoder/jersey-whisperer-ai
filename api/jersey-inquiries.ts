// api/jersey-inquiries.ts - read-only Botpress jersey inquiry rollups.
//
// The browser calls this endpoint to pull inquiry counts into the inventory/forecast
// experience. It uses the Supabase service key server-side only; do not expose that
// key through VITE_* variables.

export const config = {
  runtime: "nodejs",
  maxDuration: 15,
};

interface SupabaseEnv {
  url: string;
  key: string;
}

interface JerseyInquiryCount {
  jersey_key: string;
  team: string;
  player: string | null;
  jersey_type: string | null;
  season: string | null;
  mentions: number;
  distinct_customers: number;
  last_asked_at: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function supabaseEnv(): SupabaseEnv | null {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

function safeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function rowToCount(row: Record<string, unknown>): JerseyInquiryCount | null {
  const team = cleanText(row.team);
  if (!team) return null;
  const player = cleanText(row.player);
  const jerseyType = cleanText(row.jersey_type);
  const season = cleanText(row.season);
  return {
    jersey_key:
      cleanText(row.jersey_key) ??
      [team, player ?? "any_player", jerseyType ?? "any_kit", season ?? "any_season"].join("|"),
    team,
    player,
    jersey_type: jerseyType,
    season,
    mentions: safeInt(row.mentions),
    distinct_customers: safeInt(row.distinct_customers),
    last_asked_at: cleanText(row.last_asked_at),
  };
}

async function fetchCounts(sb: SupabaseEnv, limit: number): Promise<JerseyInquiryCount[]> {
  const primarySelect =
    "jersey_key,team,player,jersey_type,season,mentions,distinct_customers,last_asked_at";
  const fallbackSelect = "team,mentions,distinct_customers,last_asked_at";
  const base = `${sb.url}/rest/v1/jersey_inquiry_counts`;
  const headers = { apikey: sb.key, Authorization: `Bearer ${sb.key}` };

  for (const select of [primarySelect, fallbackSelect]) {
    const url = new URL(base);
    url.searchParams.set("select", select);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (select === primarySelect && [400, 404].includes(res.status)) continue;
      throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const rows = (await res.json()) as Record<string, unknown>[];
    return rows.map(rowToCount).filter((row): row is JerseyInquiryCount => Boolean(row));
  }

  return [];
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed. Use GET." }, 405);
    }

    const sb = supabaseEnv();
    if (!sb) {
      return jsonResponse({ ok: false, error: "server not configured" }, 500);
    }

    const requestUrl = new URL(request.url);
    const limit = Math.min(500, Math.max(1, safeInt(requestUrl.searchParams.get("limit")) || 100));

    try {
      const counts = await fetchCounts(sb, limit);
      return jsonResponse({ ok: true, counts });
    } catch (err) {
      console.error("[jersey-inquiries] read failed:", (err as Error).message);
      return jsonResponse({ ok: false, error: "read_failed", counts: [] }, 500);
    }
  },
};
