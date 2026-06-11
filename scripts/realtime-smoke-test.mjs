// One-shot smoke test: is Supabase Realtime enabled for the three tables the
// live dashboard subscribes to? Subscribes with the ANON key (same as the
// browser), then performs a harmless write per table with the service key:
//   • jersey_inquiry_events: INSERT with team=null (ignored by inquiry counts), then DELETE
//   • forecast_scores:       INSERT with product_id=null, then DELETE
//   • products:              real value change — bumps inquiries_7d by 1, then restores it
// Prints PASS/FAIL per table. Cleans up after itself.
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

const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const anon = createClient(url, env.VITE_SUPABASE_ANON_KEY);
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY);

const TABLES = ["jersey_inquiry_events", "forecast_scores", "products"];
const received = new Set();

const channel = anon.channel("realtime-smoke-test");
for (const table of TABLES) {
  channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
    received.add(`${payload.table}`);
  });
}

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("subscribe timeout")), 10000);
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      clearTimeout(timeout);
      resolve();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      clearTimeout(timeout);
      reject(new Error(`channel status: ${status}`));
    }
  });
});
console.log("channel SUBSCRIBED — performing test writes…");

const testId = `realtime-smoke-${Date.now()}`;

// 1. inquiry event (team null → invisible to inquiry counts)
await admin.from("jersey_inquiry_events").insert({
  message_id: testId,
  raw_text: "realtime smoke test (auto-deleted)",
  team: null,
  source: "realtime-smoke-test",
});

// 2. forecast score (product_id null)
const { data: fsRow } = await admin
  .from("forecast_scores")
  .insert({ product_id: null, demand_spike_score: 1, urgency_label: "smoke-test" })
  .select("id")
  .single();

// 3. products: REAL value change on a column that exists in the live table
//    (id, team, type, size, stock, wholesale_cost, retail_price, inquiries_7d,
//    sales_7d, created_at) — bump inquiries_7d, restored in cleanup below.
const { data: prod, error: prodReadError } = await admin
  .from("products")
  .select("id, inquiries_7d")
  .limit(1)
  .single();
if (prodReadError) console.error("products read failed:", prodReadError.message);
if (prod) {
  const { error } = await admin
    .from("products")
    .update({ inquiries_7d: (prod.inquiries_7d ?? 0) + 1 })
    .eq("id", prod.id);
  if (error) console.error("products update failed:", error.message);
}

await new Promise((resolve) => setTimeout(resolve, 6000));

for (const table of TABLES) {
  console.log(`${received.has(table) ? "PASS" : "FAIL"}  realtime event received: ${table}`);
}

// cleanup
await admin.from("jersey_inquiry_events").delete().eq("message_id", testId);
if (fsRow?.id) await admin.from("forecast_scores").delete().eq("id", fsRow.id);
if (prod) {
  // restore the original inquiries_7d value
  await admin.from("products").update({ inquiries_7d: prod.inquiries_7d ?? 0 }).eq("id", prod.id);
}
await anon.removeChannel(channel);
process.exit(0);
