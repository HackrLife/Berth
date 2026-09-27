-- Berth: governed retrieval and demo-mode usage tracking.
-- Everything lives in its own `berth` schema so it cannot touch other apps
-- in the same Supabase project. The API connects as `berth_app`, a role that
-- can only use this schema and is always subject to row-level security.

create extension if not exists vector with schema extensions;

create schema if not exists berth;

-- Documents uploaded by a visitor (owner) or shipped as samples (owner = 'sample').
create table if not exists berth.documents (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  name text not null,
  chars integer not null default 0,
  chunk_count integer not null default 0,
  redactions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- One row per chunk, with a 512-dimension embedding.
create table if not exists berth.chunks (
  id bigserial primary key,
  document_id uuid not null references berth.documents (id) on delete cascade,
  owner text not null,
  idx integer not null,
  content text not null,
  embedding extensions.vector(512) not null
);

create index if not exists chunks_owner_idx on berth.chunks (owner);
create index if not exists chunks_embedding_idx on berth.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Server-side record of ingestion, retrieval and deletion.
create table if not exists berth.events (
  id bigserial primary key,
  at timestamptz not null default now(),
  owner text not null,
  event text not null,
  detail jsonb not null default '{}'::jsonb
);

-- Daily request counters for demo mode (per visitor and global).
create table if not exists berth.usage (
  day date not null default current_date,
  key text not null,
  count integer not null default 0,
  primary key (day, key)
);

-- Row-level security. The API sets `berth.owner` for each transaction; the
-- database only ever returns that owner's rows plus shared samples.
alter table berth.documents enable row level security;
alter table berth.chunks enable row level security;
alter table berth.events enable row level security;
alter table berth.usage enable row level security;

create or replace function berth.current_owner() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('berth.owner', true), '')
$$;

drop policy if exists documents_read on berth.documents;
create policy documents_read on berth.documents for select
  using (owner = berth.current_owner() or owner = 'sample');
drop policy if exists documents_write on berth.documents;
create policy documents_write on berth.documents for insert
  with check (owner = berth.current_owner());
drop policy if exists documents_update on berth.documents;
create policy documents_update on berth.documents for update
  using (owner = berth.current_owner()) with check (owner = berth.current_owner());
drop policy if exists documents_delete on berth.documents;
create policy documents_delete on berth.documents for delete
  using (owner = berth.current_owner() and owner <> 'sample');

drop policy if exists chunks_read on berth.chunks;
create policy chunks_read on berth.chunks for select
  using (owner = berth.current_owner() or owner = 'sample');
drop policy if exists chunks_write on berth.chunks;
create policy chunks_write on berth.chunks for insert
  with check (owner = berth.current_owner());
drop policy if exists chunks_delete on berth.chunks;
create policy chunks_delete on berth.chunks for delete
  using (owner = berth.current_owner() and owner <> 'sample');

drop policy if exists events_owner on berth.events;
create policy events_owner on berth.events for all
  using (owner = berth.current_owner()) with check (owner = berth.current_owner());

drop policy if exists usage_all on berth.usage;
create policy usage_all on berth.usage for all using (true) with check (true);

-- Similarity search. Runs as the caller, so row-level security applies.
create or replace function berth.match_chunks(
  query_embedding extensions.vector(512),
  match_count integer default 5,
  document_ids uuid[] default null
)
returns table (id bigint, document_id uuid, document_name text, idx integer, content text, similarity double precision)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.document_id, d.name, c.idx, c.content,
         1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity
  from berth.chunks c
  join berth.documents d on d.id = c.document_id
  where document_ids is null or c.document_id = any (document_ids)
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 12)
$$;

-- Increment a usage counter and return the new value.
create or replace function berth.bump_usage(usage_key text) returns integer
language sql volatile security invoker set search_path = '' as $$
  insert into berth.usage (day, key, count) values (current_date, usage_key, 1)
  on conflict (day, key) do update set count = berth.usage.count + 1
  returning count
$$;

-- The restricted role used by the Berth API. Set its password once in the
-- Supabase SQL editor: alter role berth_app with password '...';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'berth_app') then
    create role berth_app login nobypassrls;
  end if;
end
$$;

grant usage on schema berth to berth_app;
grant usage on schema extensions to berth_app;
grant select, insert, update, delete on berth.documents, berth.chunks, berth.events, berth.usage to berth_app;
grant usage, select on all sequences in schema berth to berth_app;
grant execute on function berth.current_owner(), berth.match_chunks(extensions.vector, integer, uuid[]), berth.bump_usage(text) to berth_app;
