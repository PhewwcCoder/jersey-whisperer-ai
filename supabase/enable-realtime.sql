-- Enable Supabase Realtime for the live dashboard subscriptions.
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run),
-- or use the per-table "Enable Realtime" toggle in Table Editor.
-- Verify afterwards with: node scripts/realtime-smoke-test.mjs  (expect 3× PASS)

alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.jersey_inquiry_events;
alter publication supabase_realtime add table public.forecast_scores;

-- If a table is already in the publication, the corresponding line errors with
-- "relation ... is already member of publication" — safe to ignore, just run
-- the remaining lines.
