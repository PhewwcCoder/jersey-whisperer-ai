// Computes the DSS scores exactly as the deployed Forecast Preview does:
// real scoring code (bundled from src/lib via scripts/dss-entry.ts) + real
// production data (products, inquiry counts, BD trend cache, news events).
// Usage: node scripts/compute-dss.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

execSync(
  'npx esbuild scripts/dss-entry.ts --bundle --format=esm --platform=node --outfile=scripts/.dss-bundle.mjs --loader:.tsx=tsx --jsx=automatic ' +
    '--define:import.meta.env.VITE_SUPABASE_URL=\'""\' --define:import.meta.env.VITE_SUPABASE_ANON_KEY=\'""\'',
  { stdio: "pipe", cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
);
const { forecastProduct, applyJerseyInquiryCountsToProducts } = await import(
  pathToFileURL(new URL("./.dss-bundle.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href
);

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const admin = createClient(env.VITE_SUPABASE_URL || env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// 1. products — same parse path as parseProductRow (type JSON wins)
const { data: rows } = await admin
  .from("products")
  .select("*")
  .order("created_at", { ascending: false });
const seen = new Set();
const products = [];
for (const row of rows ?? []) {
  if (!row.type) continue;
  let parsed;
  try {
    parsed = JSON.parse(row.type);
  } catch {
    continue;
  }
  const product = {
    ...parsed,
    id: row.id,
    team_country_club: parsed.team_country_club ?? row.team,
    created_at: parsed.created_at ?? row.created_at,
  };
  const key = `${product.product_name}|${product.team_country_club}`;
  if (seen.has(key)) continue; // dedupeProductsByIdentity keeps newest
  seen.add(key);
  products.push(product);
}

// 2. inquiry counts — same public API the browser calls
const counts = (
  await (await fetch("https://jersey-whisperer-ai.vercel.app/api/jersey-inquiries?limit=500")).json()
).counts ?? [];
const withCounts = applyJerseyInquiryCountsToProducts(products, counts);

// 3. BD trend cache — same mapping as fetchTrendSignalsFromSupabase
const { data: trendRows } = await admin
  .from("trend_signals")
  .select("*")
  .eq("geo", "BD")
  .order("fetched_at", { ascending: false });
const signals = (trendRows ?? []).map((row) => ({
  id: row.id,
  keyword: row.keyword,
  geo: row.geo || "BD",
  channel: row.channel || "web",
  language: row.language || "en",
  momentum: row.momentum || "stable",
  growthWeight: Number(row.growth_weight) || 0,
  matchedTeam: row.matched_team || undefined,
  matchedPlayer: row.matched_player || undefined,
  explanation: row.explanation || "",
}));

// 4. news events
const { data: newsEvents } = await admin.from("news_events").select("*");

const forecasts = withCounts
  .map((p) => forecastProduct(p, signals, withCounts, newsEvents ?? []))
  .sort((a, b) => b.demandSpikeScore - a.demandSpikeScore);

for (const f of forecasts.slice(0, 12)) {
  const mark = f.team === "Barcelona" ? "  ◀◀◀ BARCELONA" : "";
  console.log(`${String(f.demandSpikeScore).padStart(3)}  ${f.product_name} (${f.team})${mark}`);
}
process.exit(0);
