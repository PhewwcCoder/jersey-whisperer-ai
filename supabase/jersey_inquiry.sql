-- Botpress jersey-inquiry tracking — run this once in the Supabase SQL editor.
-- (Same block is also appended to schema.sql.) Safe to re-run: all idempotent.

create table if not exists public.jersey_inquiry_events (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,        -- Botpress message id (idempotency key)
  conversation_id text,
  channel text,                           -- webchat | messenger | ...
  raw_text text not null,                 -- original (often Banglish) customer message
  team text,                              -- canonical English team (null = not a jersey request)
  player text,
  jersey_type text,                       -- home | away | third | retro | null
  season text,                            -- e.g. "2026", "2022 WC"
  source text default 'botpress',         -- backfill | webhook
  asked_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists jersey_inquiry_events_team_idx on public.jersey_inquiry_events (team);
create index if not exists jersey_inquiry_events_asked_at_idx on public.jersey_inquiry_events (asked_at desc);

drop view if exists public.jersey_inquiry_counts;
drop view if exists public.jersey_inquiry_team_counts;

create or replace view public.jersey_inquiry_counts as
  select
    concat_ws(
      '|',
      team,
      coalesce(nullif(player, ''), 'any_player'),
      coalesce(nullif(jersey_type, ''), 'any_kit'),
      coalesce(nullif(season, ''), 'any_season')
    )                                      as jersey_key,
    team,
    nullif(player, '')                     as player,
    nullif(jersey_type, '')                as jersey_type,
    nullif(season, '')                     as season,
    count(*)::int                          as mentions,
    count(distinct coalesce(conversation_id, message_id))::int
                                            as distinct_customers,
    max(asked_at)                          as last_asked_at
  from public.jersey_inquiry_events
  where team is not null
  group by
    team,
    nullif(player, ''),
    nullif(jersey_type, ''),
    nullif(season, '')
  order by distinct_customers desc, mentions desc;

create or replace view public.jersey_inquiry_team_counts as
  select
    team,
    count(*)::int                          as mentions,
    count(distinct coalesce(conversation_id, message_id))::int
                                            as distinct_customers,
    max(asked_at)                          as last_asked_at
  from public.jersey_inquiry_events
  where team is not null
  group by team
  order by distinct_customers desc, mentions desc;

alter table public.jersey_inquiry_events enable row level security;
drop policy if exists "hackathon_jersey_inquiry_events_all" on public.jersey_inquiry_events;
create policy "hackathon_jersey_inquiry_events_all" on public.jersey_inquiry_events
  for all to anon using (true) with check (true);
