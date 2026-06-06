// api/news-refresh.ts — API-Football sports event refresh
// Server-side only — uses process.env, never import.meta.env

import {
  resolveTier,
  TIER_LISTS,
  NATIONAL_TEAM_MAP,
  type NewsEventType,
  type Tier,
} from "../src/lib/news-score";

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

// Tracked team IDs for transfers endpoint
const TRACKED_TEAM_IDS: Array<{ name: string; id: number }> = [
  { name: "Real Madrid", id: 541 },
  { name: "Barcelona", id: 529 },
  { name: "Manchester United", id: 33 },
  { name: "Manchester City", id: 50 },
  { name: "Liverpool", id: 40 },
  { name: "Arsenal", id: 42 },
  { name: "Bayern Munich", id: 157 },
  { name: "PSG", id: 85 },
];

// Top 5 leagues for fixture scanning
const LEAGUE_IDS = [39, 140, 135, 78, 61];

// Clubs worth fetching goal events for — must include a tracked player
const HIGH_INTEREST_CLUBS = new Set([...TIER_LISTS.clubs.most, ...TIER_LISTS.clubs.mid]);

// All tracked player names (lowercased for matching)
const ALL_TRACKED_PLAYERS_LOWER = [
  ...TIER_LISTS.players.most,
  ...TIER_LISTS.players.mid,
  ...TIER_LISTS.players.low,
].map((n) => n.toLowerCase());

// ---------------------------------------------------------------------------
// API-Football response shapes
// ---------------------------------------------------------------------------
interface ApiFootballResponse<T> {
  response: T[];
  errors?: unknown;
  results?: number;
}

interface TransferEntry {
  player: { name: string; id: number };
  transfers: Array<{
    date: string;
    type: string;
    teams: {
      in: { name: string; id: number };
      out: { name: string; id: number };
    };
  }>;
}

interface FixtureEntry {
  fixture: { id: number; date: string };
  teams: {
    home: { name: string; id: number };
    away: { name: string; id: number };
  };
}

interface FixtureEventEntry {
  type: string;
  player: { name: string; id: number };
  team: { name: string; id: number };
  time: { elapsed: number };
}

// ---------------------------------------------------------------------------
// Supabase upsert (raw fetch — consistent with trends-refresh.ts pattern)
// ---------------------------------------------------------------------------
async function upsertNewsEvents(
  supabaseUrl: string,
  serviceRoleKey: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return;
  const response = await fetch(
    `${supabaseUrl}/rest/v1/news_events?on_conflict=type,player,team,event_date`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`news_events upsert failed (${response.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// API-Football fetch helpers
// ---------------------------------------------------------------------------
function apiHeaders(apiKey: string) {
  return { "x-apisports-key": apiKey };
}

async function fetchTransfersForTeam(
  teamId: number,
  apiKey: string,
): Promise<ApiFootballResponse<TransferEntry>> {
  const url = `${API_FOOTBALL_BASE}/transfers?team=${teamId}&season=2024`;
  const res = await fetch(url, { headers: apiHeaders(apiKey) });
  if (!res.ok) throw new Error(`transfers HTTP ${res.status} team=${teamId}`);
  return res.json() as Promise<ApiFootballResponse<TransferEntry>>;
}

async function fetchFixturesForLeague(
  leagueId: number,
  from: string,
  to: string,
  apiKey: string,
): Promise<ApiFootballResponse<FixtureEntry>> {
  const url = `${API_FOOTBALL_BASE}/fixtures?league=${leagueId}&season=2024&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: apiHeaders(apiKey) });
  if (!res.ok) throw new Error(`fixtures HTTP ${res.status} league=${leagueId}`);
  return res.json() as Promise<ApiFootballResponse<FixtureEntry>>;
}

async function fetchGoalEventsForFixture(
  fixtureId: number,
  apiKey: string,
): Promise<ApiFootballResponse<FixtureEventEntry>> {
  const url = `${API_FOOTBALL_BASE}/fixtures/events?fixture=${fixtureId}&type=Goal`;
  const res = await fetch(url, { headers: apiHeaders(apiKey) });
  if (!res.ok) throw new Error(`fixture/events HTTP ${res.status} fixture=${fixtureId}`);
  return res.json() as Promise<ApiFootballResponse<FixtureEventEntry>>;
}

// ---------------------------------------------------------------------------
// Core refresh logic — exported so trends-refresh.ts can call it directly
// ---------------------------------------------------------------------------
export async function refreshNewsEvents(): Promise<void> {
  // DEMO_MODE: skip all live API-Football calls — seeded news_events are the source of truth.
  if (process.env.DEMO_MODE === "true") {
    console.log("[news-refresh] DEMO_MODE — skipping live API-Football fetch");
    return;
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    console.warn("[news-refresh] API_FOOTBALL_KEY not configured — skipping");
    return;
  }

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
  const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  )?.trim();
  if (!supabaseUrl || !supabaseKey) {
    console.warn("[news-refresh] Supabase not configured — skipping");
    return;
  }

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];

  let callCount = 0;
  const rows: Record<string, unknown>[] = [];
  const fetchedAt = now.toISOString();

  // -------------------------------------------------------------------------
  // Part A — Transfers (8 calls, one per tracked team)
  // -------------------------------------------------------------------------
  for (const { name: clubName, id: teamId } of TRACKED_TEAM_IDS) {
    try {
      callCount++;
      const data = await fetchTransfersForTeam(teamId, apiKey);
      console.log(
        `[news-refresh] transfers team=${clubName} (call ${callCount}): ${data.response?.length ?? 0} player entries`,
      );

      for (const entry of data.response ?? []) {
        const playerName = entry.player?.name;
        if (!playerName) continue;

        for (const transfer of entry.transfers ?? []) {
          if (!transfer.date || transfer.date < thirtyDaysAgo) continue;

          const destClub = transfer.teams?.in?.name ?? clubName;
          const natTeam = NATIONAL_TEAM_MAP[playerName] ?? destClub;

          const tier =
            resolveTier(playerName) === "low"
              ? resolveTier(destClub) === "low"
                ? "low"
                : resolveTier(destClub)
              : resolveTier(playerName);

          rows.push({
            type: "transfer" as NewsEventType,
            player: playerName,
            team: natTeam,
            secondary_team: destClub,
            event_date: transfer.date,
            tier: tier as Tier,
            base_m: 0.6,
            source: "api_football",
            geo: "WW",
          });
        }
      }
    } catch (err) {
      console.error(`[news-refresh] transfers failed for team=${clubName}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Part B — Fixtures + goal events (5 league calls + up to ~10 event calls)
  // -------------------------------------------------------------------------
  const fixtureIdsToCheck: Array<{ fixtureId: number; fixtureDate: string }> = [];

  for (const leagueId of LEAGUE_IDS) {
    try {
      callCount++;
      const data = await fetchFixturesForLeague(leagueId, sevenDaysAgo, today, apiKey);
      console.log(
        `[news-refresh] fixtures league=${leagueId} (call ${callCount}): ${data.response?.length ?? 0} fixtures`,
      );

      for (const fixture of data.response ?? []) {
        const homeName = fixture.teams?.home?.name ?? "";
        const awayName = fixture.teams?.away?.name ?? "";
        // Only fetch events for fixtures involving high-interest clubs
        if (HIGH_INTEREST_CLUBS.has(homeName) || HIGH_INTEREST_CLUBS.has(awayName)) {
          fixtureIdsToCheck.push({
            fixtureId: fixture.fixture.id,
            fixtureDate: fixture.fixture.date,
          });
        }
      }
    } catch (err) {
      console.error(`[news-refresh] fixtures failed for league=${leagueId}:`, err);
    }
  }

  // Cap at 15 to stay under 30 total calls
  const fixturesToFetch = fixtureIdsToCheck.slice(0, 15);
  for (const { fixtureId, fixtureDate } of fixturesToFetch) {
    try {
      callCount++;
      const data = await fetchGoalEventsForFixture(fixtureId, apiKey);

      for (const event of data.response ?? []) {
        if (event.type !== "Goal") continue;
        const playerName = event.player?.name;
        const teamName = event.team?.name;
        if (!playerName || !teamName) continue;

        const playerLower = playerName.toLowerCase();
        const isTracked = ALL_TRACKED_PLAYERS_LOWER.some(
          (p) => playerLower.includes(p) || p.includes(playerLower),
        );
        if (!isTracked) continue;

        const tier = resolveTier(playerName);
        const eventDateStr = fixtureDate.split("T")[0];

        rows.push({
          type: "performance" as NewsEventType,
          player: playerName,
          team: teamName,
          secondary_team: null,
          event_date: eventDateStr,
          tier,
          base_m: 0.4,
          source: "api_football",
          geo: "WW",
        });
      }
    } catch (err) {
      console.error(`[news-refresh] fixture events failed for fixture=${fixtureId}:`, err);
    }
  }

  console.log(`[news-refresh] total API calls: ${callCount}, events to upsert: ${rows.length}`);

  // Upsert in a single batch — ignoreDuplicates keeps existing seed rows intact
  try {
    await upsertNewsEvents(supabaseUrl, supabaseKey, rows);
    console.log(`[news-refresh] wrote ${rows.length} events to news_events (source=api_football)`);
  } catch (err) {
    // upsertNewsEvents throws with the non-2xx status + response body so write
    // failures are visible here rather than swallowed.
    console.error("[news-refresh] upsert failed:", err);
    // Don't rethrow — caller (trends-refresh) should not fail for this
  }
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
      await refreshNewsEvents();
      return jsonResponse({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[news-refresh] handler error:", message);
      return jsonResponse({ ok: false, error: message }, 500);
    }
  },
};

export default handler;
