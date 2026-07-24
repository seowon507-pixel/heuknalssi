# 흙날씨.진단 Backend v3

기후·토양·최근 관측·예보를 서로 다른 근거 축으로 유지하면서, 다음 확인 행동을 결정적으로 반환하는 P0 백엔드입니다. 프론트엔드와 연결하지 않은 독립 구현이며, 기존 v2의 단일 적합도 점수·결측 재가중·토양 대표값 로직을 사용하지 않습니다.

## 현재 상태

이 저장소는 **안전한 기본값으로 닫혀 있습니다.** 검수된 규칙·위치 매핑·공급자 계약이 없으면 서버는 숫자를 추측하지 않고 모듈을 `HOLD`, `UNAVAILABLE`, `UNSUPPORTED`로 반환합니다. `/api/health/preflight`도 이 상태에서 `ready: false`, `serviceState: "HOLD"`를 반환합니다.

실제 배포를 준비하려면 다음 외부 자산을 먼저 동결해야 합니다.

- 5개 작물의 출처·단위·문서 위치·검토일·버전을 가진 규칙
- 최소 6개 시연지역의 출처·버전·유효기간을 가진 위치 매핑
- checksum과 규칙 버전이 일치하는 기후평년 스냅샷
- ASOS 운영지점·요청기간 자료존재·거리·월평년 계약
- 토양 V2의 XML 필드·단위·구간 경계·허용오차·연도 계약
- 실제 응답 fixture로 검증한 Kakao·KMA 단기·중기 계약

이 자산이 없는 상태에서 feature flag나 임의 contract 문자열만 켜는 것은 배포 준비 완료가 아닙니다.

`.env.example`의 `fixture-*` contract ID는 공급자 버전명이 아니라 저장소의 계약 fixture와 parser를 묶는 내부 allowlist ID입니다. 정확히 일치하지 않는 문자열은 외부 호출 전에 거부됩니다.

문서화된 `npm start` 경로에서도 검수 자산을 조립할 수 있습니다.
`TRUSTED_BACKEND_RUNTIME_MODULE`에 운영자 소유 `.js`/`.mjs` 파일의
절대경로를 지정하고 그 모듈에서 `createRuntimeOptions({ env, fetchImpl,
clock })`를 export합니다. 반환값에는 `adapters`, `rules` 또는
`ruleRegistry`, `verifiedLocationMappings`, `runtimeStatus`,
`soilContract`, `soilDefaultYear`만 허용됩니다. 이 모듈은 요청 입력이나
업로드 파일이 아니라 배포 코드로 취급해야 하며, 미설정·로드 실패 시
검증되지 않은 기본값으로 대신 시작하지 않습니다.

## 실행

Node.js 22 이상이 필요하며 외부 패키지 설치는 필요하지 않습니다.

```sh
npm test
npm run check
npm start
```

로컬 기본 주소는 `http://localhost:3100`입니다. 운영에서는 32자 이상의 `SESSION_SECRET`과 명시적인 `ALLOWED_ORIGINS`가 필수입니다. 실제 키 값은 `.env.example`에 넣지 말고 배포 Secret으로 주입합니다.

기본 네트워크 모드는 직접 연결이며 전달 헤더를 신뢰하지 않습니다. 역방향
프록시 뒤에서 운영할 때만 `TRUSTED_PROXY_RANGES`에 실제 프록시의 IP 또는
CIDR을 쉼표로 구분해 지정합니다. 서버는 소켓 주소부터 오른쪽에서 왼쪽으로
신뢰 체인을 확인한 뒤 검증된 클라이언트 IP만 속도 제한 키로 사용합니다.
포괄적인 `TRUST_PROXY=true` 설정은 안전상 거부됩니다.

## API 흐름

1. `GET /api/session`으로 서명 익명 세션과 CSRF 토큰을 받습니다.
2. `GET /api/locations?q=...`에서 위치 후보를 검색합니다.
3. 사용자가 후보 하나를 확인합니다.
4. `POST /api/analyses`에 후보 토큰과 확인된 농업 입력만 보냅니다.
5. `GET /api/analyses/:id`로 소유자 범위 결과를 조회합니다.
6. `POST /api/analyses/:id/report`로 결정론적 보고서를 요청합니다.

분석 요청의 위치에는 좌표를 보내지 않습니다.

```json
{
  "usageMode": "LAND_SEARCH",
  "location": {
    "candidateToken": "opaque-token",
    "userConfirmed": true
  },
  "crop": "CUCUMBER",
  "cultivationMode": "OPEN_FIELD",
  "season": {
    "kind": "CUSTOM",
    "profileId": "CUSTOM",
    "startMonth": 5,
    "endMonth": 9,
    "userConfirmed": true
  }
}
```

## 코드 경계

- `src/domain`: 요청·규칙·기후·토양·최근 관측·예보·상태·결정·행동
- `src/adapters`: 공급자 파싱, 엄격한 결측 처리, DataEnvelope, deadline·cache
- `src/application`: 위치 복원, 모듈 오케스트레이션, 근거·보고서 조립
- `src/infrastructure`: 세션 범위 저장소, opaque ID, 멱등성, 속도 제한
- `src/api`: HTTP 계약, CORS·CSRF·소유권·오류 응답
- `server`: 환경 설정과 실제 조립

권위 로직 명세는 [09_흙날씨진단_서비스로직_명세서.md](../09_흙날씨진단_서비스로직_명세서.md)입니다.

## 핵심 안전 불변조건

- 서로 다른 데이터 축을 한 점수로 합산하지 않습니다.
- 빈 문자열·`null`·`-`를 0으로 바꾸지 않습니다.
- 결측 변수를 제외해 남은 가중치를 100%로 재정규화하지 않습니다.
- 토양 통계를 필지 대표값이나 임의 평균으로 만들지 않습니다.
- `stale`·`sample` 자료로 현재 위험 부재나 안심성 결론을 만들지 않습니다.
- 넓은 행정구역에 임의 중심좌표나 거리 0을 만들지 않습니다.
- 미검증 규칙·계약·선택 기능은 외부 호출 없이 닫힙니다.
- P0 보고서는 자유형 LLM 문장을 생성하지 않습니다.

## 운영 한계

인메모리 세션·분석·멱등 저장은 단일 인스턴스 P0에 한정됩니다. 다중 인스턴스나 영구저장 전환 전에는 공유 저장소, 삭제·보관정책, 암호화, 분산 rate limit을 별도로 설계해야 합니다.
