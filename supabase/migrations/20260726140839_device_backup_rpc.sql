-- 기기 이관 백업 저장·조회 함수.
--
-- 표를 직접 열지 않고 함수로만 다룬다. 키 길이·본문 형식·크기 검증을 DB
-- 안에 두면 백엔드에 버그가 있어도 규격 밖 자료가 들어가지 않는다.

create or replace function public.save_device_backup(
  p_key_hash text,
  p_payload jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_saved_at timestamptz := now();
begin
  if p_key_hash is null or length(p_key_hash) <> 64 then
    raise exception 'invalid key hash';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid payload';
  end if;
  if pg_column_size(p_payload) > 8192 then
    raise exception 'payload too large';
  end if;

  insert into public.device_backups (key_hash, payload, updated_at, expires_at)
  values (p_key_hash, p_payload, v_saved_at, v_saved_at + interval '365 days')
  on conflict (key_hash) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at;

  return v_saved_at;
end;
$function$;

create or replace function public.load_device_backup(p_key_hash text)
returns table(payload jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_key_hash is null or length(p_key_hash) <> 64 then
    raise exception 'invalid key hash';
  end if;

  return query
    select b.payload, b.updated_at
    from public.device_backups b
    where b.key_hash = p_key_hash
      and b.expires_at > now()
    limit 1;
end;
$function$;
