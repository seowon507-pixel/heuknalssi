-- 기기 이관 백업.
--
-- 사용자가 발급받은 계정키의 SHA-256 해시로만 조회한다. 원문 키는 저장하지
-- 않으므로 DB가 통째로 유출돼도 남의 백업을 열 수 없다.
--
-- 접근 정책: RLS를 켜 두고 정책을 만들지 않는다. service_role만 접근한다.

create table if not exists public.device_backups (
  key_hash text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '365 days')
);

comment on table public.device_backups is
  '사용자가 발급한 계정키(해시)로 조회하는 기기 이관 백업. 백엔드 service_role 전용.';
comment on column public.device_backups.key_hash is
  '계정키의 SHA-256 해시. 원문 키는 저장하지 않는다.';

create index if not exists device_backups_expires_at_idx
  on public.device_backups (expires_at);

alter table public.device_backups enable row level security;
