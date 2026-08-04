# 흙날씨 데이터 저장 계약

## 적용 범위

이 문서는 현재 제품의 브라우저 저장소와 서버 전용 Supabase 저장 경계를 정의한다. 비밀키와 원문 PNU는 사용자 화면이나 브라우저 저장소에 기록하지 않는다.

## 브라우저 저장소

- `heuknalssi.farms.v1`: 사용자가 등록한 농장 목록. 농장별 `id`, `name`, `situation`, `region`, `crops`, `cropSettings`, `updatedAt`을 저장한다.
- `heuknalssi.activeFarm.v1`: 현재 선택한 농장 ID.
- `heuknalssi.analysisSnapshots.v1`: 농장·작물별 마지막 분석 화면 복원을 위한 응답 스냅샷.
- `heuknalssi.soilTest.v1`: 사용자가 직접 확인하고 입력한 토양검정값.
- `heuknalssi.todo.v1`: 기기 안에서 관리하는 할 일 상태.
- `heuknalssi.alarm.v1`: 알림 설정.
- `heuknalssi.accountKey.v1`: 사용자가 기기 이관을 선택했을 때 사용하는 복구키. 서버에는 해시만 전송한다.

재배 생애주기 입력은 별도 전역 키를 늘리지 않고 각 농장의 `cropSettings[crop].cycle`에 둔다. 최소 필드는 `seasonId`, `anchorType`, `anchorDate`, `status`이며 서버 projection은 `progress`, `harvestWindow`, `currentMilestone`, `nextMilestone`, `preparationStartsOn`, `confidence`, `estimated`를 반환한다.

## 서버 전용 Supabase

`backend-v3/supabase/shared-state-setup.sql`이 현재 검토된 기준이다.

- `public.heuknalssi_shared_state`: 세션, 분석, 할 일, 사진 시즌, 위성, 리포트와 재배 생애주기를 namespace로 분리해 TTL과 함께 저장한다.
- `public.heuknalssi_rate_limits`: 서버 요청 제한 버킷.
- `public.heuknalssi_device_backups`: 계정키 SHA-256 해시와 허용된 복구 payload만 저장한다.
- 모든 테이블은 RLS를 활성화하고 `anon`, `authenticated` 직접 권한을 제거한다.
- 브라우저는 테이블을 직접 호출하지 않는다. 백엔드만 service-role 자격으로 제한된 RPC를 호출한다.
- 재배 생애주기는 `crop_cycles` namespace를 사용하며 별도 공개 테이블이나 클라이언트 직접 쓰기를 만들지 않는다.

## 농장 복구 payload v2

허용 루트: `version`, `soilTest`, `region`, `farms`, `activeFarmId`, `alarm`, `todo`, `savedAt`.

농장 객체는 기존 필드에 한해 저장한다. 생애주기는 `cropSettings` 안에서 검증하며, 임의 필드·지원하지 않는 작물·128 KiB 초과 payload는 거절한다. `situation`은 `planning`과 `growing`을 지원한다.

## 정밀 위치와 개인정보

- 사용자 화면에는 주소 표시명과 분석 범위만 노출한다.
- PNU, 공급자 내부 키, 서비스키는 브라우저 저장소·로그·백업에 포함하지 않는다.
- 상세 주소를 선택하지 않은 분석은 `ADMIN_AREA_REFERENCE`, 주소 지점은 `ADDRESS_POINT`, 필지 실측은 `FIELD_MEASUREMENT`, 필지 토양도는 `FIELD_SOIL_MAP`으로 표시한다.
- 토양검정 이력이 없다는 사실과 API 장애를 구분한다.

## 변경 규칙

- 스키마 변경은 검토된 SQL 또는 Supabase CLI migration으로만 수행한다.
- 기존 payload를 읽을 수 있는 하위 호환 정규화를 먼저 추가한 뒤 새 필드를 저장한다.
- 실제 생체 상태 점수, 환경점수, 재배 진행률을 서로 대체하거나 합산하지 않는다.
