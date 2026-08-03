-- Reviewed setup SQL for the server-only shared-state foundation.
--
-- The Supabase CLI is not available in this workspace, so this is deliberately
-- not named as a migration. Before production, create a migration with:
--   supabase migration new shared_state_foundation
-- and copy this reviewed SQL into the generated file.

create table if not exists public.heuknalssi_shared_state (
  namespace text not null check (namespace ~ '^[a-z][a-z0-9_-]{0,31}$'),
  state_key text not null check (char_length(state_key) between 1 and 512),
  state_value jsonb not null,
  expires_at timestamptz not null,
  primary key (namespace, state_key)
);

create index if not exists heuknalssi_shared_state_expires_at_idx
  on public.heuknalssi_shared_state (expires_at);

alter table public.heuknalssi_shared_state enable row level security;
revoke all on table public.heuknalssi_shared_state from public, anon, authenticated;
grant select, insert, update, delete on table public.heuknalssi_shared_state to service_role;

create table if not exists public.heuknalssi_rate_limits (
  bucket_key text primary key check (char_length(bucket_key) = 64),
  request_count integer not null check (request_count >= 0),
  reset_at timestamptz not null
);

create index if not exists heuknalssi_rate_limits_reset_at_idx
  on public.heuknalssi_rate_limits (reset_at);

alter table public.heuknalssi_rate_limits enable row level security;
revoke all on table public.heuknalssi_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.heuknalssi_rate_limits to service_role;

-- Optional cross-device recovery payloads. The user-visible recovery key is
-- hashed in the backend before this table is reached; raw keys are never stored.
create table if not exists public.heuknalssi_device_backups (
  key_hash text primary key check (char_length(key_hash) = 64),
  payload jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  check (pg_column_size(payload) <= 131072)
);

alter table public.heuknalssi_device_backups enable row level security;
revoke all on table public.heuknalssi_device_backups from public, anon, authenticated;
grant select, insert, update, delete on table public.heuknalssi_device_backups to service_role;

create or replace function public.save_device_backup(
  p_key_hash text,
  p_payload jsonb
) returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_at timestamptz := clock_timestamp();
begin
  if char_length(p_key_hash) <> 64 or p_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'backup key hash is invalid' using errcode = '22023';
  end if;
  if p_payload is null or pg_column_size(p_payload) > 131072 then
    raise exception 'backup payload is invalid' using errcode = '22023';
  end if;

  insert into public.heuknalssi_device_backups (
    key_hash,
    payload,
    updated_at
  ) values (
    p_key_hash,
    p_payload,
    v_updated_at
  )
  on conflict (key_hash) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at;

  return v_updated_at;
end;
$$;

create or replace function public.load_device_backup(
  p_key_hash text
) returns table(payload jsonb, updated_at timestamptz)
language sql
security invoker
set search_path = ''
as $$
  select backup.payload, backup.updated_at
  from public.heuknalssi_device_backups as backup
  where backup.key_hash = p_key_hash
    and char_length(p_key_hash) = 64
    and p_key_hash ~ '^[a-f0-9]{64}$';
$$;

create or replace function public.heuknalssi_shared_state_get(
  p_namespace text,
  p_key text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  delete from public.heuknalssi_shared_state
  where namespace = p_namespace
    and state_key = p_key
    and expires_at <= clock_timestamp();

  select state_value
    into v_value
  from public.heuknalssi_shared_state
  where namespace = p_namespace
    and state_key = p_key
    and expires_at > clock_timestamp();

  return v_value;
end;
$$;

create or replace function public.heuknalssi_shared_state_set(
  p_namespace text,
  p_key text,
  p_value jsonb,
  p_ttl_ms bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ttl_ms <= 0 then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  insert into public.heuknalssi_shared_state (
    namespace,
    state_key,
    state_value,
    expires_at
  ) values (
    p_namespace,
    p_key,
    p_value,
    clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
  )
  on conflict (namespace, state_key) do update
    set state_value = excluded.state_value,
        expires_at = excluded.expires_at;

  return p_value;
end;
$$;

create or replace function public.heuknalssi_shared_state_delete(
  p_namespace text,
  p_key text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.heuknalssi_shared_state
  where namespace = p_namespace and state_key = p_key;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.heuknalssi_shared_state_set_if_absent(
  p_namespace text,
  p_key text,
  p_value jsonb,
  p_ttl_ms bigint
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_ttl_ms <= 0 then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  delete from public.heuknalssi_shared_state
  where namespace = p_namespace
    and state_key = p_key
    and expires_at <= clock_timestamp();

  insert into public.heuknalssi_shared_state (
    namespace,
    state_key,
    state_value,
    expires_at
  ) values (
    p_namespace,
    p_key,
    p_value,
    clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
  ) on conflict (namespace, state_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.heuknalssi_shared_state_compare_and_set(
  p_namespace text,
  p_key text,
  p_expected jsonb,
  p_value jsonb,
  p_ttl_ms bigint
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_ttl_ms <= 0 then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  update public.heuknalssi_shared_state
  set state_value = p_value,
      expires_at = clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
  where namespace = p_namespace
    and state_key = p_key
    and state_value = p_expected
    and expires_at > clock_timestamp();

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.heuknalssi_idempotency_begin(
  p_namespace text,
  p_key text,
  p_payload_hash text,
  p_location text,
  p_ttl_ms bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_value jsonb;
begin
  if p_ttl_ms <= 0 then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  delete from public.heuknalssi_shared_state
  where namespace = p_namespace
    and state_key = p_key
    and expires_at <= clock_timestamp();

  insert into public.heuknalssi_shared_state (
    namespace,
    state_key,
    state_value,
    expires_at
  ) values (
    p_namespace,
    p_key,
    jsonb_build_object(
      'state', 'in_progress',
      'payloadHash', p_payload_hash,
      'location', p_location
    ),
    clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
  ) on conflict (namespace, state_key) do nothing;
  get diagnostics v_count = row_count;

  if v_count = 1 then
    return jsonb_build_object('kind', 'started');
  end if;

  select state_value
    into v_value
  from public.heuknalssi_shared_state
  where namespace = p_namespace and state_key = p_key
  for update;

  if v_value ->> 'payloadHash' is distinct from p_payload_hash then
    return jsonb_build_object('kind', 'conflict');
  end if;
  if v_value ->> 'state' = 'completed' then
    return jsonb_build_object(
      'kind', 'replay',
      'response', v_value -> 'response'
    );
  end if;
  return jsonb_build_object(
    'kind', 'in_progress',
    'location', v_value ->> 'location'
  );
end;
$$;

create or replace function public.heuknalssi_idempotency_complete(
  p_namespace text,
  p_key text,
  p_payload_hash text,
  p_response jsonb,
  p_ttl_ms bigint
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_ttl_ms <= 0 then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  update public.heuknalssi_shared_state
  set state_value = state_value || jsonb_build_object(
        'state', 'completed',
        'response', p_response
      ),
      expires_at = clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
  where namespace = p_namespace
    and state_key = p_key
    and state_value ->> 'state' = 'in_progress'
    and state_value ->> 'payloadHash' = p_payload_hash
    and expires_at > clock_timestamp();

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.heuknalssi_idempotency_fail(
  p_namespace text,
  p_key text,
  p_payload_hash text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.heuknalssi_shared_state
  where namespace = p_namespace
    and state_key = p_key
    and state_value ->> 'state' = 'in_progress'
    and state_value ->> 'payloadHash' = p_payload_hash;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.heuknalssi_rate_limit_consume(
  p_bucket_key text,
  p_limit integer,
  p_window_ms bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_reset_at timestamptz;
  v_retry_after integer;
begin
  if p_limit <= 0 or p_window_ms <= 0 then
    raise exception 'limit and window must be positive' using errcode = '22023';
  end if;

  insert into public.heuknalssi_rate_limits (
    bucket_key,
    request_count,
    reset_at
  ) values (
    p_bucket_key,
    0,
    v_now + make_interval(secs => p_window_ms / 1000.0)
  ) on conflict (bucket_key) do nothing;

  select request_count, reset_at
    into v_count, v_reset_at
  from public.heuknalssi_rate_limits
  where bucket_key = p_bucket_key
  for update;

  if v_reset_at <= v_now then
    v_count := 0;
    v_reset_at := v_now + make_interval(secs => p_window_ms / 1000.0);
    update public.heuknalssi_rate_limits
    set request_count = 0, reset_at = v_reset_at
    where bucket_key = p_bucket_key;
  end if;

  if v_count >= p_limit then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_reset_at - v_now)))::integer
    );
    return jsonb_build_object(
      'allowed', false,
      'limit', p_limit,
      'remaining', 0,
      'resetAt', floor(extract(epoch from v_reset_at) * 1000)::bigint,
      'retryAfterSeconds', v_retry_after
    );
  end if;

  v_count := v_count + 1;
  update public.heuknalssi_rate_limits
  set request_count = v_count
  where bucket_key = p_bucket_key;

  return jsonb_build_object(
    'allowed', true,
    'limit', p_limit,
    'remaining', p_limit - v_count,
    'resetAt', floor(extract(epoch from v_reset_at) * 1000)::bigint,
    'retryAfterSeconds', 0
  );
end;
$$;

-- One RPC transaction must insert/update, lock-read, compare, and delete the
-- probe row. Configuration alone can therefore never promote deployment READY.
create or replace function public.heuknalssi_shared_state_probe(
  p_probe_id text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expected jsonb := jsonb_build_object('probeId', p_probe_id);
  v_observed jsonb;
begin
  if char_length(p_probe_id) not between 1 and 128 then
    raise exception 'probe id is invalid' using errcode = '22023';
  end if;

  -- Bound each cleanup so health checks never turn into unbounded table scans.
  with expired as (
    select ctid
    from public.heuknalssi_shared_state
    where expires_at <= clock_timestamp()
    order by expires_at
    limit 500
    for update skip locked
  )
  delete from public.heuknalssi_shared_state as state
  using expired
  where state.ctid = expired.ctid;

  with expired as (
    select ctid
    from public.heuknalssi_rate_limits
    where reset_at <= clock_timestamp()
    order by reset_at
    limit 500
    for update skip locked
  )
  delete from public.heuknalssi_rate_limits as bucket
  using expired
  where bucket.ctid = expired.ctid;

  insert into public.heuknalssi_shared_state (
    namespace,
    state_key,
    state_value,
    expires_at
  ) values (
    'health-probe',
    p_probe_id,
    v_expected,
    clock_timestamp() + interval '1 minute'
  )
  on conflict (namespace, state_key) do update
    set state_value = excluded.state_value,
        expires_at = excluded.expires_at;

  select state_value
    into v_observed
  from public.heuknalssi_shared_state
  where namespace = 'health-probe' and state_key = p_probe_id
  for update;

  delete from public.heuknalssi_shared_state
  where namespace = 'health-probe' and state_key = p_probe_id;

  return v_observed = v_expected;
end;
$$;

-- PostgREST functions receive EXECUTE from PUBLIC by default. Revoke every
-- shared-state RPC explicitly, then opt in only the server-side service role.
revoke all on function public.heuknalssi_shared_state_get(text, text) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_get(text, text) to service_role;
revoke all on function public.heuknalssi_shared_state_set(text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_set(text, text, jsonb, bigint) to service_role;
revoke all on function public.heuknalssi_shared_state_delete(text, text) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_delete(text, text) to service_role;
revoke all on function public.heuknalssi_shared_state_set_if_absent(text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_set_if_absent(text, text, jsonb, bigint) to service_role;
revoke all on function public.heuknalssi_shared_state_compare_and_set(text, text, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_compare_and_set(text, text, jsonb, jsonb, bigint) to service_role;
revoke all on function public.heuknalssi_idempotency_begin(text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_idempotency_begin(text, text, text, text, bigint) to service_role;
revoke all on function public.heuknalssi_idempotency_complete(text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_idempotency_complete(text, text, text, jsonb, bigint) to service_role;
revoke all on function public.heuknalssi_idempotency_fail(text, text, text) from public, anon, authenticated;
grant execute on function public.heuknalssi_idempotency_fail(text, text, text) to service_role;
revoke all on function public.heuknalssi_rate_limit_consume(text, integer, bigint) from public, anon, authenticated;
grant execute on function public.heuknalssi_rate_limit_consume(text, integer, bigint) to service_role;
revoke all on function public.heuknalssi_shared_state_probe(text) from public, anon, authenticated;
grant execute on function public.heuknalssi_shared_state_probe(text) to service_role;
revoke all on function public.save_device_backup(text, jsonb) from public, anon, authenticated;
grant execute on function public.save_device_backup(text, jsonb) to service_role;
revoke all on function public.load_device_backup(text) from public, anon, authenticated;
grant execute on function public.load_device_backup(text) to service_role;

-- Private farm-photo bytes are accessed only through the backend secret. The
-- browser receives a one-use upload token and never a bucket/object path.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'farm-photos',
  'farm-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
