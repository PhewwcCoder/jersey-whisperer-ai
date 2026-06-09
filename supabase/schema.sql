create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  type text,
  size text,
  stock integer default 0,
  wholesale_cost numeric default 0,
  retail_price numeric default 0,
  inquiries_7d integer default 0,
  sales_7d integer default 0,
  created_at timestamptz default now()
);

create table if not exists public.trend_signals (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  geo text default 'BD',
  channel text,
  language text,
  momentum text,
  growth_weight numeric,
  matched_team text,
  matched_player text,
  explanation text,
  source text default 'cached_google_trends_style_snapshot',
  fetched_at timestamptz default now()
);

-- Market-discovery signals from SerpApi Google Trends (GEO_MAP + RELATED_QUERIES).
-- Kept SEPARATE from trend_signals so geo-region / related-query rows never leak
-- into per-product DSS scoring. One table, discriminated by `kind`.
create table if not exists public.market_discovery (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                       -- 'geo_map' | 'related_top' | 'related_rising'
  team text,                                -- team for geo_map; null for related queries
  label text not null,                      -- region/location (geo_map) or query text (related)
  score numeric,                            -- normalized 0..1 (S_geo / S_top / S_rising)
  raw_value integer,                        -- SerpApi extracted_value (0..100, or breakout)
  geo text,                                 -- market scope: '' = worldwide, 'BD' = Bangladesh
  source text default 'serpapi_google_trends',
  fetched_at timestamptz default now()
);

create table if not exists public.forecast_scores (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  demand_spike_score numeric,
  urgency_label text,
  trend_score numeric,
  query_score numeric,
  stock_risk_score numeric,
  margin_score numeric,
  sales_velocity_score numeric,
  recommendation text,
  calculated_at timestamptz default now()
);

create table if not exists public.chat_logs (
  id uuid primary key default gen_random_uuid(),
  customer_message text,
  ai_reply text,
  matched_product_id uuid references public.products(id) on delete set null,
  language text,
  created_at timestamptz default now()
);

create table if not exists public.product_embeddings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding extensions.vector(384),
  created_at timestamptz default now()
);

create table if not exists public.trend_embeddings (
  id uuid primary key default gen_random_uuid(),
  trend_signal_id uuid references public.trend_signals(id) on delete cascade,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding extensions.vector(384),
  created_at timestamptz default now()
);

-- Sports-news demand-signal events (API-Football + google_ai_mode → Gemini parse).
-- Scored by the DSS news rubric (magnitude base_m x tier weight x decay). `context`
-- is DISPLAY-ONLY AI demand color and is never read by any scorer.
create table if not exists public.news_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,                 -- transfer | trophy | wc_final | kit_release | retirement | performance
  player text,
  team text not null,
  secondary_team text,
  event_date timestamptz not null,
  tier text,                          -- most | mid | low
  base_m numeric,
  source text,                        -- api_football | google_ai_mode | demo_seed
  geo text,
  context text,                       -- nullable, DISPLAY-ONLY demand color (not scored)
  created_at timestamptz default now()
);

-- Idempotent migration for already-created news_events tables: add the nullable,
-- display-only context column if it isn't present yet.
alter table public.news_events add column if not exists context text;

create or replace function public.match_product_embeddings(
  query_embedding extensions.vector(384),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  product_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql
stable
as $$
  select
    pe.id,
    pe.product_id,
    pe.content,
    pe.metadata,
    1 - (pe.embedding <=> query_embedding) as similarity
  from public.product_embeddings pe
  where 1 - (pe.embedding <=> query_embedding) > match_threshold
  order by pe.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_trend_embeddings(
  query_embedding extensions.vector(384),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  trend_signal_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql
stable
as $$
  select
    te.id,
    te.trend_signal_id,
    te.content,
    te.metadata,
    1 - (te.embedding <=> query_embedding) as similarity
  from public.trend_embeddings te
  where 1 - (te.embedding <=> query_embedding) > match_threshold
  order by te.embedding <=> query_embedding
  limit match_count;
$$;

create index if not exists products_team_idx on public.products(team);
create index if not exists trend_signals_keyword_idx on public.trend_signals(keyword);
create index if not exists market_discovery_kind_idx on public.market_discovery(kind);
create index if not exists product_embeddings_embedding_hnsw_idx
  on public.product_embeddings using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists trend_embeddings_embedding_hnsw_idx
  on public.trend_embeddings using hnsw (embedding extensions.vector_cosine_ops);

alter table public.products enable row level security;
alter table public.trend_signals enable row level security;
alter table public.market_discovery enable row level security;
alter table public.forecast_scores enable row level security;
alter table public.chat_logs enable row level security;
alter table public.product_embeddings enable row level security;
alter table public.trend_embeddings enable row level security;

drop policy if exists "hackathon_products_all" on public.products;
create policy "hackathon_products_all" on public.products
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_trend_signals_all" on public.trend_signals;
create policy "hackathon_trend_signals_all" on public.trend_signals
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_market_discovery_all" on public.market_discovery;
create policy "hackathon_market_discovery_all" on public.market_discovery
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_forecast_scores_all" on public.forecast_scores;
create policy "hackathon_forecast_scores_all" on public.forecast_scores
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_chat_logs_all" on public.chat_logs;
create policy "hackathon_chat_logs_all" on public.chat_logs
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_product_embeddings_all" on public.product_embeddings;
create policy "hackathon_product_embeddings_all" on public.product_embeddings
  for all to anon using (true) with check (true);

drop policy if exists "hackathon_trend_embeddings_all" on public.trend_embeddings;
create policy "hackathon_trend_embeddings_all" on public.trend_embeddings
  for all to anon using (true) with check (true);

comment on table public.products is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';
comment on table public.trend_signals is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';
comment on table public.forecast_scores is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';
comment on table public.chat_logs is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';
comment on table public.product_embeddings is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';
comment on table public.trend_embeddings is
  'Hackathon demo policy is intentionally permissive. Production must replace anon RLS with merchant-authenticated policies.';

-- ── news_events: sports events feeding S_news (15% of DSS) ──────────────────
create table if not exists public.news_events (
  id            uuid        primary key default gen_random_uuid(),
  type          text        not null,        -- 'transfer' | 'trophy' | 'wc_final' | 'kit_release' | 'retirement' | 'performance'
  player        text,                        -- null for team-only events (trophy, kit)
  team          text        not null,        -- primary team/club/national tagged
  secondary_team text,                       -- transfer: destination club (team = national, secondary = new club)
  event_date    timestamptz not null,        -- exact date (API-Football) or first_seen (SerpApi)
  tier          text        not null,        -- 'most' | 'mid' | 'low'
  base_m        numeric     not null,        -- rubric value BEFORE tier multiplier
  source        text        not null,        -- 'api_football' | 'serpapi' | 'demo_seed'
  geo           text        default 'BD',
  created_at    timestamptz default now(),
  unique(type, player, team, event_date)     -- prevents duplicate upserts
);

create index if not exists news_events_team_idx       on public.news_events(team);
create index if not exists news_events_event_date_idx on public.news_events(event_date);
create index if not exists news_events_source_idx     on public.news_events(source);

-- ── jersey_classifications: durable per-day AI verdicts for Box 3 (AI Stock Picks) ──
-- Replaces the in-memory classify cache so verdicts survive a server restart (the
-- June-11 seed must still be readable for the June-12 demo). One row per (query, day);
-- api/classify-jerseys reads today's rows before calling any LLM, and DEMO_MODE serves
-- the latest day's rows with ZERO outbound LLM/API calls. trend_score is the 20/80
-- blended market score, stored for ranking. Nothing here is fabricated — every row is
-- a real OpenRouter/Gemini verdict produced by the seed run.
create table if not exists public.jersey_classifications (
  query       text    not null,
  is_jersey   boolean not null,
  team        text,
  kind        text,                         -- 'national' | 'club' | null
  trend_score numeric,                      -- 20/80 blended score (for ranking)
  day         date    not null,             -- classification day (per-day cache key)
  created_at  timestamptz default now(),
  primary key (query, day)
);

create index if not exists jersey_classifications_day_idx on public.jersey_classifications(day);

alter table public.jersey_classifications enable row level security;

drop policy if exists "hackathon_jersey_classifications_all" on public.jersey_classifications;
create policy "hackathon_jersey_classifications_all" on public.jersey_classifications
  for all to anon using (true) with check (true);

comment on table public.jersey_classifications is
  'Durable per-day AI jersey verdicts for Box 3. Hackathon policy is permissive — replace with merchant RLS in production.';

alter table public.news_events enable row level security;

drop policy if exists "hackathon_news_events_all" on public.news_events;
create policy "hackathon_news_events_all" on public.news_events
  for all to anon using (true) with check (true);

comment on table public.news_events is
  'Sports events feeding S_news score (15% of DSS). Hackathon policy is permissive — replace with merchant RLS in production.';

-- ── Demo seed rows (non-zero S_news on first load, no API call needed) ───────
insert into public.news_events (type, player, team, secondary_team, event_date, tier, base_m, source) values
  ('transfer',    'Kylian Mbappé',      'France',        'Real Madrid',  now() - interval '5 days',  'most', 0.6, 'demo_seed'),
  ('trophy',       null,                'Real Madrid',    null,           now() - interval '10 days', 'most', 0.7, 'demo_seed'),
  ('performance', 'Vinicius Junior',    'Real Madrid',    null,           now() - interval '2 days',  'most', 0.4, 'demo_seed'),
  ('performance', 'Mohamed Salah',      'Liverpool',      null,           now() - interval '3 days',  'most', 0.4, 'demo_seed'),
  ('wc_final',     null,                'Argentina',      null,           now() - interval '8 days',  'most', 0.5, 'demo_seed'),
  ('retirement',  'Luka Modric',        'Real Madrid',    null,           now() - interval '14 days', 'mid',  0.3, 'demo_seed'),
  ('kit_release',  null,                'Barcelona',      null,           now() - interval '6 days',  'most', 0.4, 'demo_seed')
on conflict (type, player, team, event_date) do nothing;
-- ════════════════════════════════════════════════════════════════════════════
-- Botpress jersey-inquiry tracking
-- Backfilled by scripts/scrape-botpress.ts (history) and appended live by
-- api/botpress-inquiry.ts (Botpress "Execute Code" webhook). One row per customer
-- message that DeepSeek classifies as a jersey request. `message_id` is the Botpress
-- message id and is UNIQUE, so re-running the backfill or replaying a webhook never
-- double-counts the same message.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.jersey_inquiry_events (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,        -- Botpress message id (idempotency key)
  conversation_id text,
  channel text,                           -- webchat | messenger | ...
  raw_text text not null,                 -- the original (often Banglish) customer message
  team text,                              -- canonical English team, e.g. "Argentina" (null = not a jersey request)
  player text,                            -- player name if asked by name, else null
  jersey_type text,                       -- home | away | third | retro | null
  season text,                            -- e.g. "2026", "2022 WC", else null
  source text default 'botpress',          -- backfill | webhook
  asked_at timestamptz,                   -- Botpress message createdAt
  created_at timestamptz default now()
);

create index if not exists jersey_inquiry_events_team_idx on public.jersey_inquiry_events (team);
create index if not exists jersey_inquiry_events_asked_at_idx on public.jersey_inquiry_events (asked_at desc);

drop view if exists public.jersey_inquiry_counts;
drop view if exists public.jersey_inquiry_team_counts;

-- Rollup the dashboard reads. A VIEW (not a counter table) so it is always consistent
-- with the events and never races — both backfill and webhook only ever INSERT events.
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

comment on table public.jersey_inquiry_events is
  'One row per customer jersey request scraped/streamed from Botpress. message_id UNIQUE = idempotent. Hackathon policy is permissive — replace with merchant RLS in production.';
