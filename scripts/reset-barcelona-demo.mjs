// One-off demo-data reset: remove TEST sale/restock events from Barcelona
// product rows so the DSS returns to its organic baseline (real inquiries kept).
// The score stays fully live — judges see it climb from this clean start.
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

const { data: rows, error } = await admin
  .from("products")
  .select("id, team, type")
  .eq("team", "Barcelona");
if (error) throw error;

for (const row of rows ?? []) {
  let parsed;
  try {
    parsed = JSON.parse(row.type);
  } catch {
    console.log(`skip ${row.id} (no parseable type JSON)`);
    continue;
  }
  const hadEvents = Array.isArray(parsed.events) ? parsed.events.length : 0;
  delete parsed.events;
  const { error: patchError } = await admin
    .from("products")
    .update({ type: JSON.stringify(parsed), sales_7d: 0 })
    .eq("id", row.id);
  console.log(
    patchError
      ? `FAILED ${row.id}: ${patchError.message}`
      : `reset ${row.id} (${parsed.product_name ?? row.team}) — removed ${hadEvents} test events`,
  );
}
process.exit(0);
