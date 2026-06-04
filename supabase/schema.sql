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
