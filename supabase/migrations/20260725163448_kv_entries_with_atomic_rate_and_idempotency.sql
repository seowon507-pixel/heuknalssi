-- 서버리스 인스턴스 사이에서 공유되는 만료형 키-값 저장소.
--
-- Vercel은 요청마다 다른 인스턴스로 갈 수 있어 프로세스 메모리에 둔 세션·
-- 분석·레이트리밋이 그대로 사라진다. 이 표가 그 공유 자리를 맡는다.
--
-- 접근 정책: RLS를 켜 두고 정책을 하나도 만들지 않는다. anon·authenticated
-- 역할은 전부 차단되고, RLS를 우회하는 service_role(백엔드 전용 비밀키)만
-- 읽고 쓸 수 있다. 브라우저에 이 키를 내보내면 안 된다.

create table if not exists public.kv_entries (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null
);

comment on table public.kv_entries is
  '만료형 공유 키-값 저장소. 백엔드 service_role 전용이며 정책을 두지 않아 다른 역할은 접근할 수 없다.';

create index if not exists kv_entries_expires_at_idx
  on public.kv_entries (expires_at);

alter table public.kv_entries enable row level security;

-- 레이트리밋 한 윈도를 원자적으로 소비한다.
-- 애플리케이션에서 읽고-더하고-쓰면 동시 요청에서 한도를 넘긴다.
create or replace function public.kv_rate_consume(
  p_key text,
  p_limit integer,
  p_window_ms bigint
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_ttl interval := (p_window_ms::text || ' milliseconds')::interval;
  v_count integer;
  v_reset timestamptz;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'p_limit must be positive';
  end if;
  if p_window_ms is null or p_window_ms <= 0 then
    raise exception 'p_window_ms must be positive';
  end if;

  -- 지난 윈도는 버리고 새 윈도를 시작한다.
  delete from public.kv_entries
   where key = p_key and expires_at <= v_now;

  insert into public.kv_entries as e (key, value, expires_at)
  values (p_key, jsonb_build_object('count', 1), v_now + v_ttl)
  on conflict (key) do update
     set value = jsonb_build_object('count', (e.value->>'count')::integer + 1)
   where (e.value->>'count')::integer < p_limit
  returning (e.value->>'count')::integer, e.expires_at
    into v_count, v_reset;

  if v_count is null then
    -- 증가가 거부됨 = 한도 초과. 기존 윈도의 리셋 시점을 그대로 알려준다.
    select (value->>'count')::integer, expires_at
      into v_count, v_reset
      from public.kv_entries
     where key = p_key;
    return query select false, 0, coalesce(v_reset, v_now + v_ttl);
    return;
  end if;

  return query select true, greatest(p_limit - v_count, 0), v_reset;
end;
$function$;

-- 멱등성 예약. 같은 요청이 두 번 들어와도 한 번만 실행되게 자리를 잡는다.
create or replace function public.kv_idem_begin(
  p_scope text,
  p_payload_hash text,
  p_location text,
  p_ttl_ms bigint
)
returns table(inserted boolean, existing jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_ttl interval := (p_ttl_ms::text || ' milliseconds')::interval;
  v_inserted boolean := false;
  v_existing jsonb;
begin
  if p_ttl_ms is null or p_ttl_ms <= 0 then
    raise exception 'p_ttl_ms must be positive';
  end if;

  delete from public.kv_entries
   where key = p_scope and expires_at <= v_now;

  insert into public.kv_entries (key, value, expires_at)
  values (
    p_scope,
    jsonb_build_object(
      'state', 'in_progress',
      'payloadHash', p_payload_hash,
      'location', p_location
    ),
    v_now + v_ttl
  )
  on conflict (key) do nothing;

  if found then
    v_inserted := true;
  else
    select value into v_existing
      from public.kv_entries
     where key = p_scope;
    -- 경합 상대가 그 사이 만료·삭제했다면 예약을 재시도한다.
    if v_existing is null then
      insert into public.kv_entries (key, value, expires_at)
      values (
        p_scope,
        jsonb_build_object(
          'state', 'in_progress',
          'payloadHash', p_payload_hash,
          'location', p_location
        ),
        v_now + v_ttl
      )
      on conflict (key) do nothing;
      if found then
        v_inserted := true;
      else
        select value into v_existing
          from public.kv_entries
         where key = p_scope;
      end if;
    end if;
  end if;

  return query select v_inserted, v_existing;
end;
$function$;

-- 만료 항목 청소. 예약 실행에서 부른다.
create or replace function public.kv_sweep()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_deleted integer;
begin
  delete from public.kv_entries where expires_at <= now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;
