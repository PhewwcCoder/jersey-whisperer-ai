// Supabase Realtime subscription helper for live dashboard/forecast updates.
//
// ─── IMPORTANT: Supabase Realtime must be ENABLED for these tables ───────────
// In the Supabase dashboard: Table Editor → select each table → "Enable
// Realtime" toggle must be ON (or Database → Publications → add the tables to
// the supabase_realtime publication) for:
//   • public.forecast_scores
//   • public.jersey_inquiry_events
//   • public.products
// Without this, subscriptions connect but never receive postgres_changes
// events. Realtime also respects RLS — the hackathon "allow all" policies on
// these tables let the anon key receive row payloads.
// ──────────────────────────────────────────────────────────────────────────────
//
// No new dependencies: realtime ships inside @supabase/supabase-js, which the
// app already lazy-loads via getSupabaseClient().
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "./supabase";

export type TableChangePayload = RealtimePostgresChangesPayload<Record<string, unknown>>;

/**
 * Subscribe to postgres_changes on a public table. Returns a cleanup function
 * for useEffect — always call it on unmount so the channel is removed.
 * Safe no-op when Supabase is not configured (e.g. missing env in a fork).
 */
export function subscribeToTableChanges(
  channelName: string,
  table: string,
  onChange: (payload: TableChangePayload) => void,
): () => void {
  if (!isSupabaseConfigured || typeof window === "undefined") return () => {};

  let cancelled = false;
  let channel: RealtimeChannel | null = null;

  void getSupabaseClient().then((supabase) => {
    if (!supabase || cancelled) return;
    channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload: TableChangePayload) => {
          if (!cancelled) onChange(payload);
        },
      )
      .subscribe();
  });

  return () => {
    cancelled = true;
    if (channel) {
      const open = channel;
      channel = null;
      void getSupabaseClient().then((supabase) => {
        if (supabase) void supabase.removeChannel(open);
      });
    }
  };
}
