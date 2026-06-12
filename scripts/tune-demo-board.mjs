// One-off demo-board tuning (data only, engine untouched):
//   1. Trim the over-restored Argentina baselines (kappa relief for everyone).
//   2. Seed two fresh demo news events (source 'demo' — visible as demo rows in
//      the ?debug=1 provenance) so Bangladesh and Barcelona regain the news
//      freshness that decayed since yesterday.
// Targets: Bangladesh ≈ 42 (pre-bug level), Barcelona ≈ 33 (pinned demo start).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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

// 1. Argentina baseline trim (18→8, 14→6)
const TRIM = {
  "Argentina 2026 World Cup Version": 8,
  "Argentina 2006 Retro Kit": 6,
};
const { data: rows } = await admin.from("products").select("id, type");
for (const row of rows ?? []) {
  if (!row.type) continue;
  let parsed;
  try {
    parsed = JSON.parse(row.type);
  } catch {
    continue;
  }
  const target = TRIM[parsed.product_name];
  if (target === undefined) continue;
  parsed.baseline_query_count = target;
  parsed.query_count = target;
  await admin
    .from("products")
    .update({ type: JSON.stringify(parsed), inquiries_7d: target })
    .eq("id", row.id);
  console.log(`baseline ${target}  ${parsed.product_name}`);
}

// 2. Fresh demo news events (idempotent-ish: delete previous demo-tune rows first)
await admin.from("news_events").delete().eq("source", "demo-tune");
const today = new Date().toISOString();
const { error } = await admin.from("news_events").insert([
  {
    type: "trophy",
    team: "Bangladesh",
    player: null,
    secondary_team: null,
    event_date: today,
    tier: "most",
    base_m: 1.0,
    source: "demo-tune",
    geo: "BD",
    context: "Bangladesh win SAFF Championship — national jersey demand surging",
  },
  {
    type: "transfer",
    team: "Barcelona",
    player: null,
    secondary_team: null,
    event_date: today,
    tier: "most",
    base_m: 1.0,
    source: "demo-tune",
    geo: "BD",
    context: "Barcelona complete marquee signing — home kit interest spiking",
  },
]);
console.log(error ? `news insert FAILED: ${error.message}` : "demo news events inserted");
process.exit(0);
