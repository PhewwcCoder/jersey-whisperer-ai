/**
 * THROWAWAY DIAGNOSTIC — API-Football connectivity check.
 *
 * Does NOT touch app logic, Supabase, scoring, or the refresh flow. It only:
 *   1. loads API_FOOTBALL_KEY from .env.local (masked in logs),
 *   2. calls transfers?team=541 (Real Madrid),
 *   3. calls fixtures?league=39&season=2025&last=5 (Premier League),
 *   4. prints status / errors / results / sample records / quota headers.
 *
 * Run:  npx tsx scripts/test-api-football.ts
 */

import { readFileSync } from "node:fs";

const BASE = "https://v3.football.api-sports.io";

// ── Load API_FOOTBALL_KEY from .env.local (no dotenv dependency) ───────────────
function loadKey(): string | undefined {
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const name = trimmed.slice(0, eq).trim();
      if (name !== "API_FOOTBALL_KEY") continue;
      let value = trimmed.slice(eq + 1).trim();
      // strip optional surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  } catch (error) {
    console.error("Could not read .env.local:", (error as Error).message);
  }
  return undefined;
}

function mask(key: string): string {
  return `${key.slice(0, 4)}...`;
}

function quotaHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.includes("ratelimit") || lower.includes("requests") || lower.includes("limit")) {
      out[name] = value;
    }
  });
  return out;
}

interface ApiEnvelope {
  results?: number;
  errors?: unknown;
  response?: unknown[];
}

async function callEndpoint(path: string, key: string) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { "x-apisports-key": key } });
  const headers = quotaHeaders(res.headers);
  let body: ApiEnvelope | null = null;
  let rawText = "";
  try {
    rawText = await res.text();
    body = rawText ? (JSON.parse(rawText) as ApiEnvelope) : null;
  } catch {
    body = null;
  }
  return { url, status: res.status, headers, body, rawText };
}

// Collect every date-looking string from a record so we can find the newest.
function collectDates(value: unknown, acc: string[]) {
  if (value == null) return;
  if (typeof value === "string") {
    // ISO date or yyyy-mm-dd
    if (/\d{4}-\d{2}-\d{2}/.test(value)) acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDates(item, acc);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectDates(v, acc);
  }
}

function newestDate(records: unknown[]): string | null {
  const dates: string[] = [];
  collectDates(records, dates);
  if (!dates.length) return null;
  return dates
    .map((d) => ({ d, t: new Date(d).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.d)[0] ?? null;
}

function line() {
  console.log("─".repeat(72));
}

async function main() {
  let requestsMade = 0;

  line();
  console.log("API-FOOTBALL DIAGNOSTIC (throwaway)");
  line();

  const key = loadKey();
  console.log(`key present: ${Boolean(key)}${key ? ` (${mask(key)})` : ""}`);
  if (!key) {
    console.error("No API_FOOTBALL_KEY found in .env.local — aborting.");
    process.exit(1);
  }

  // ── 1. Transfers for Real Madrid (team 541) ─────────────────────────────────
  line();
  console.log("CALL 1 — GET /transfers?team=541 (Real Madrid)");
  line();
  const transfers = await callEndpoint("/transfers?team=541", key);
  requestsMade += 1;
  console.log(`HTTP status   : ${transfers.status}`);
  console.log(`errors        : ${JSON.stringify(transfers.body?.errors ?? null)}`);
  console.log(`results count : ${transfers.body?.results ?? "(none)"}`);
  console.log("quota headers :", JSON.stringify(transfers.headers, null, 2));

  const tResponse = Array.isArray(transfers.body?.response) ? transfers.body!.response! : [];
  console.log("\nFirst 2 transfer records (as returned):");
  for (const rec of tResponse.slice(0, 2)) {
    const r = rec as {
      player?: { name?: string };
      transfers?: Array<{ date?: string; teams?: { in?: { name?: string }; out?: { name?: string } } }>;
    };
    const t0 = r.transfers?.[0];
    console.log(
      JSON.stringify(
        {
          player: r.player?.name ?? null,
          date: t0?.date ?? null,
          in: t0?.teams?.in?.name ?? null,
          out: t0?.teams?.out?.name ?? null,
        },
        null,
        2,
      ),
    );
  }
  // Newest ACTUAL transfer date (the transfers[].date field), separate from the
  // record `update` timestamp that newestDate() would otherwise surface.
  const actualTransferDates: string[] = [];
  for (const rec of tResponse) {
    const r = rec as { transfers?: Array<{ date?: string }> };
    for (const t of r.transfers ?? []) {
      if (t.date && /\d{4}-\d{2}-\d{2}/.test(t.date)) actualTransferDates.push(t.date);
    }
  }
  const newestTransferDate = actualTransferDates
    .map((d) => ({ d, t: new Date(d).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t)[0]?.d;
  console.log(`\nNewest ACTUAL transfer date (transfers[].date): ${newestTransferDate ?? "(none)"}`);
  console.log(`Newest any-date string incl. record update ts : ${newestDate(tResponse) ?? "(none)"}`);

  // ── 2. Fixtures for Premier League (league 39), recent ──────────────────────
  line();
  console.log("CALL 2 — GET /fixtures?league=39&season=2025&last=5 (Premier League)");
  line();
  let fixtures = await callEndpoint("/fixtures?league=39&season=2025&last=5", key);
  requestsMade += 1;
  console.log(`HTTP status   : ${fixtures.status}`);
  console.log(`errors        : ${JSON.stringify(fixtures.body?.errors ?? null)}`);
  console.log(`results count : ${fixtures.body?.results ?? "(none)"}`);
  console.log("quota headers :", JSON.stringify(fixtures.headers, null, 2));

  // The free plan rejects recent seasons ("Free plans do not have access to this
  // season, try from 2022 to 2024."). Fall back to 2024 to prove fixtures work
  // at all and see the shape of real fixture data.
  const fixturesPlanBlocked = JSON.stringify(fixtures.body?.errors ?? "").includes("Free plan");
  if ((fixtures.body?.results ?? 0) === 0 && fixturesPlanBlocked) {
    console.log("\n↳ season 2025 blocked on free plan — retrying with season=2024…");
    fixtures = await callEndpoint("/fixtures?league=39&season=2024&last=5", key);
    requestsMade += 1;
    console.log(`HTTP status   : ${fixtures.status}`);
    console.log(`errors        : ${JSON.stringify(fixtures.body?.errors ?? null)}`);
    console.log(`results count : ${fixtures.body?.results ?? "(none)"}`);
  }

  const fResponse = Array.isArray(fixtures.body?.response) ? fixtures.body!.response! : [];
  console.log("\nFirst 2 fixtures (as returned):");
  for (const rec of fResponse.slice(0, 2)) {
    const r = rec as {
      fixture?: { date?: string };
      teams?: { home?: { name?: string }; away?: { name?: string } };
      goals?: { home?: number | null; away?: number | null };
    };
    console.log(
      JSON.stringify(
        {
          date: r.fixture?.date ?? null,
          home: r.teams?.home?.name ?? null,
          away: r.teams?.away?.name ?? null,
          score: `${r.goals?.home ?? "-"} : ${r.goals?.away ?? "-"}`,
        },
        null,
        2,
      ),
    );
  }
  const fixturesNewest = newestDate(fResponse);
  console.log(`\nMost recent date in fixtures response: ${fixturesNewest ?? "(none)"}`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  line();
  console.log("SUMMARY");
  line();
  const authOk = transfers.status === 200 && fixtures.status === 200;
  const transfersErr = JSON.stringify(transfers.body?.errors ?? {});
  const fixturesErr = JSON.stringify(fixtures.body?.errors ?? {});
  // Auth failure (bad/expired key) is distinct from a plan/season scope limit.
  const realAuthError = /token|api[- ]?key|authoriz|invalid.*key/i.test(transfersErr + fixturesErr);
  const planLimited = /Free plan|plan/i.test(transfersErr + fixturesErr);

  console.log(
    `(a) Auth: ${authOk && !realAuthError ? "VALID — key authenticates (HTTP 200, no auth error)" : "PROBLEM — see status/errors above"}` +
      `${planLimited ? "  [note: free-plan season scope limit seen, not an auth failure]" : ""}`,
  );
  console.log(
    `(b) Data: transfers results=${transfers.body?.results ?? 0}, fixtures results=${fixtures.body?.results ?? 0} ` +
      `→ ${(transfers.body?.results ?? 0) > 0 || (fixtures.body?.results ?? 0) > 0 ? "REAL DATA returned" : "EMPTY"}`,
  );
  const overallNewest = [newestTransferDate, fixturesNewest]
    .filter(Boolean)
    .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0];
  console.log(`(c) Most recent record date overall: ${overallNewest ?? "(none)"}`);
  const limitHeader =
    transfers.headers["x-ratelimit-requests-limit"] ||
    transfers.headers["X-RateLimit-Limit"] ||
    fixtures.headers["x-ratelimit-requests-limit"] ||
    "(not reported)";
  const remainingHeader =
    transfers.headers["x-ratelimit-requests-remaining"] ||
    transfers.headers["X-RateLimit-Remaining"] ||
    fixtures.headers["x-ratelimit-requests-remaining"] ||
    "(not reported)";
  console.log(
    `(d) Requests consumed by this test: ${requestsMade}. ` +
      `Daily limit header: ${limitHeader}, remaining today: ${remainingHeader}`,
  );
  line();
}

main().catch((error) => {
  console.error("Diagnostic failed:", error);
  process.exit(1);
});
