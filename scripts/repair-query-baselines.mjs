// One-off repair: earlier code REPLACED seeded query_count with the live
// Botpress count, so a team's first real inquiry crashed its customer signal
// (e.g. Bangladesh 42 → 29). This restores each product's demand baseline from
// seed-data and stores it as baseline_query_count; the fixed app code then adds
// live inquiry counts ON TOP. Barcelona's baseline is deliberately 0 (demo
// starts ~33 and climbs from live inquiries only).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SEED_BASELINES = {
  "Argentina 2026 World Cup Version": 18,
  "Brazil 2026 WC Away Kit": 13,
  "Portugal 2026 Away Kit": 9,
  "Barcelona 2026 Home Kit": 0, // pinned low for the judge demo arc
  "Real Madrid 2026 Home Kit": 7,
  "Argentina 2006 Retro Kit": 14,
  "Brazil 2002 Retro Kit": 12,
  "Bangladesh National Team Jersey 2026": 6,
};

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

const { data: rows, error } = await admin.from("products").select("id, team, type");
if (error) throw error;

for (const row of rows ?? []) {
  if (!row.type) continue;
  let parsed;
  try {
    parsed = JSON.parse(row.type);
  } catch {
    continue;
  }
  const baseline =
    SEED_BASELINES[parsed.product_name] ??
    (Number.isFinite(parsed.query_count) ? Math.max(0, parsed.query_count) : 0);
  parsed.baseline_query_count = baseline;
  parsed.query_count = baseline; // live counts get re-added by the app at render
  const { error: patchError } = await admin
    .from("products")
    .update({ type: JSON.stringify(parsed), inquiries_7d: baseline })
    .eq("id", row.id);
  console.log(
    patchError
      ? `FAILED ${row.id}: ${patchError.message}`
      : `baseline ${String(baseline).padStart(2)}  ${parsed.product_name}`,
  );
}
process.exit(0);
