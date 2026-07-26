# 흙날씨 프로젝트 재감사 보고서

- 재감사 일자: 2026-07-26
- 판정: **CHANGES_REQUESTED**
- 기준 문서: `audit/PROJECT_AUDIT_2026-07-26.html`
- 검증 대상 HEAD: `13a1555ecea158b09b9dbc0dbef05745b5c97aed`
- 작업 브랜치: `main`
- 작업 상태: **미커밋 변경 포함**. 이 재감사 결과는 새 commit SHA로 고정된 산출물이 아니다.

## 1. 결론

코드와 화면에서 수정 가능한 P0 항목은 구현하고 실제 흐름으로 검증했다.

- 백엔드 `HOLD`를 UI가 `분석 준비됨`으로 오인시키던 표시는 제거했다.
- 기본 진입을 `LAND_SEARCH`로 복원하고 `ACTIVE_GROWING`과 분리했다.
- 사과·배·오이·감자·상추 5종 규칙과 검수 지역 6곳 매핑은 모두 `CONFIGURED`다.
- 단기·중기예보와 지역 토양 통계는 실제 API 응답으로 화면에 연결된다.
- 모든 작물 위험 규칙에 원인, 위험, 필요한 행동, 재확인 시점을 포함했다.
- 필지 토양도와 과거자료 백테스트 코드를 추가했으며 결측값을 임의로 보완하지 않는다.
- 데스크톱과 모바일 실제 사용자 흐름에서 위치·작물·날씨·토양·우선 행동을 첫 화면에서 확인했다.

그러나 감사 보고서의 재감사 수용 조건을 전부 통과하지는 못했다. 기후평년 키가 없고, 현재 ASOS 및 필지 토양 API 권한이 거부되며, 과거 발행 예보 조회도 정상 응답을 받지 못했다. 따라서 `READY`로 판정하지 않았다.

## 2. 재감사 수용 조건

| 수용 조건 | 결과 | 검증 근거 |
| --- | --- | --- |
| 프리플라이트 `READY` | **FAIL** | 실제 `/api/health/preflight`는 `serviceState: HOLD`. 차단 사유는 `ADAPTER_climate:UNSUPPORTED` |
| 5개 작물 모두 `CONFIGURED` | **PASS** | APPLE, PEAR, CUCUMBER, POTATO, LETTUCE, `completeCropCount: 5` |
| 검수 지역 6곳의 P0 매핑 `READY` | **PASS** | `verifiedCount: 6`, `p0ReadyCount: 6`, `status: CONFIGURED` |
| 기후평년 실제 분석 | **FAIL** | `kmaClimateNormal: NOT_CONFIGURED` |
| ASOS 최근 관측 실제 분석 | **FAIL** | 실제 호출 `AUTH_ERROR` |
| 지역 토양 통계 실제 분석 | **PASS** | 농경지화학성 통계정보 V2 `SUCCESS` |
| 필지 검정·배수·토성 실제 분석 | **PARTIAL** | 필지 토양도 파서·연결 로직은 완료했으나 실제 호출 `AUTH_ERROR`; 최근 필지 pH·EC 검정값 API는 별도 권한이 필요 |
| 단기예보 실제 분석 | **PASS** | 실제 호출 `SUCCESS`, 5일 응답 |
| 중기예보 실제 분석 | **PASS** | 실제 호출 `SUCCESS`, 7일 응답 |
| 백엔드 HOLD와 UI READY 불일치 0건 | **PASS** | UI는 `부분 분석 가능`과 `일부 자료만 연결됨`으로 표시하고 누락 출처를 숨기지 않음 |
| `LAND_SEARCH` 기본 진입과 위치·작물 완료 | **PASS** | 실제 주소 `경상북도 안동시 퇴계로 115`, 사과, HTTP 201 |
| `ACTIVE_GROWING` 복수 작물·서로 다른 단계/행동 | **PASS** | UI 계약·다중 요청 테스트 통과. 작물별 날짜 추천값을 기본으로 유지하고 개별 수정 가능 |
| 전 작물 원인 → 위험 → 행동 → 재확인 | **PASS** | 검수 규칙의 `headline`, `reason`, `actions`, `recheck`, 출처를 테스트로 강제 |
| ASOS 과거자료 재생 | **BLOCKED** | 엔진 구현 및 단위 테스트 통과, 실제 과거 ASOS 호출은 `AUTH_ERROR` |
| 과거 발행 예보 정확도 지표 | **BLOCKED** | MAE·RMSE·bias·강수확률 Brier score 구현, 실제 과거 발행 예보 호출은 `INTERNAL_ERROR` |
| 실제 초보·고령 사용자 5명 중 4명 무도움 완료 | **NOT RUN** | 실제 사람 평가가 필요하며 모의평가로 대체하지 않음 |
| 본문 16px 이상, 주요 터치 44px 이상 | **PASS** | 기본 18px, 모바일 17px, 주요 버튼·탭 최소 44px를 회귀 테스트로 확인 |
| 첫 화면에서 위치·작물·날씨·토양·행동 확인 | **PASS** | 실제 데스크톱·모바일 화면으로 확인 |
| 전체 자동 테스트 | **PASS** | 백엔드 227/227, UI 29/29, 프로젝트 검사 통과 |

## 3. 실제 API 상태

### 실제 제공자 점검

| 제공자 | 설정 | 실제 상태 | 비고 |
| --- | --- | --- | --- |
| Kakao 주소 | 설정됨 | `SUCCESS` | 주소 후보 1건 |
| 기상청 기후평년 | 미설정 | `NOT_CONFIGURED` | APIHub 인증키 필요 |
| 기상청 ASOS 최근 관측 | 설정됨 | `AUTH_ERROR` | 현재 키로 해당 서비스 권한 확인 불가 |
| 농경지화학성 통계정보 V2 | 설정됨 | `SUCCESS` | 지역 pH 분포 1건 |
| 토양특성 상세정보 V3 | 설정됨 | `AUTH_ERROR` | 필지 토양도 서비스 별도 승인 필요 |
| 기상청 단기예보 | 설정됨 | `SUCCESS` | 5일 응답 |
| 기상청 중기예보 | 설정됨 | `SUCCESS` | 7일 응답 |
| 스마트팜코리아 공개자료 | 설정됨 | `AUTH_ERROR` | `SMARTFARM_SERVICE_KEY_NOT_REGISTERED`; 핵심 판단에는 반영하지 않음 |

### 실제 자연스러운 사용자 흐름

- 흐름: `LAND_SEARCH`
- 주소: 경상북도 안동시 퇴계로 115
- 작물: 사과
- HTTP: `201`
- 분석 상태: `PARTIAL`
- 판단 코드: `CHECK_FIRST`
- 예보: `READY`
- 지역 토양: `PARTIAL`
- 기후평년: `HOLD`
- 최근 관측: `UNAVAILABLE`
- 표시 결과: 7일 기온·강수 예보, 고온 원인, 사과 위험, 세 가지 행동, 지역 pH 분포, 토양검정 행동, 재확인 시점

## 4. 백테스트

구현된 엔진은 다음 원칙을 강제한다.

- 유효 시각보다 전에 발행된 예보만 비교한다.
- 최고·최저기온은 MAE, RMSE, bias를 계산한다.
- 강수확률은 실제 강수 유무와 Brier score로 비교한다.
- 결측 예보·관측 쌍은 제외하며 보간하거나 현재 예보로 대체하지 않는다.
- ASOS로 재생할 수 없는 확률 기반 예보 규칙은 `NOT_COMPARABLE`로 분리한다.

실제 백테스트는 안동 지점, 2025-07-19 17시 발행 예보, 2025-07-20~26 관측 창으로 실행했다.

- 과거 ASOS: `AUTH_ERROR`
- 과거 발행 예보: `INTERNAL_ERROR`
- 규칙 재생: `BLOCKED`
- 정확도 지표: `BLOCKED`
- 최종 상태: `CHANGES_REQUESTED`

## 5. 추가로 필요한 API 승인

환경변수 파일을 출력하거나 키 값을 노출하지 않고 서비스 상태만 점검했다.

1. 기상청 API허브 인증키 및 기후통계분석 권한
   <https://apihub.kma.go.kr/apiInfo.do>
2. 기상청 지상(종관, ASOS) 일자료 조회서비스 활용 신청
   <https://www.data.go.kr/data/15059093/openapi.do>
3. 기상청 과거 발행 단기예보 조회 권한
   <https://www.data.go.kr/data/15139470/openapi.do>
4. 토양특성 상세정보 V3 활용 신청 — 배수등급·토성·유효토심
   <https://www.data.go.kr/data/15144225/openapi.do>
5. 토양검정 화학성 상세정보 V2 활용 신청 — 필지 pH·EC 실측 이력
   <https://www.data.go.kr/data/15144647/openapi.do>
6. 스마트팜코리아 공개데이터 서비스키 등록
   핵심 적합성 판단의 필수 조건은 아니며 동종 작물 참고자료에만 사용한다.

## 6. 실행한 검사

| 검사 | 결과 |
| --- | --- |
| `backend-v3: npm test` | 227 통과, 0 실패 |
| `node --test ui-integration/*.test.mjs` | 29 통과, 0 실패 |
| `backend-v3: npm run check` | 통과, 77개 파일 검사 |
| `git diff --check` | 통과 |
| 실제 제공자 점검 | 4개 핵심 성공, 기후평년 미설정, ASOS·SmartFarm 인증 실패 |
| 실제 LAND_SEARCH 흐름 | HTTP 201, PARTIAL 결과와 사용자 행동 표시 |
| 데스크톱 화면 | 실제 앱 흐름으로 확인 |
| 모바일 390×844 화면 | 실제 앱 흐름으로 확인 |

## 7. 실제 화면

- 데스크톱: `audit/evidence/reaudit-land-search-desktop-final-2026-07-26.png`
- 모바일: `audit/evidence/reaudit-land-search-mobile-final-2026-07-26.png`

화면은 누락 자료를 정상 자료처럼 보이지 않게 유지하면서 다음을 첫 화면에 표시한다.

- 분석 위치와 작물
- 부분 연결 상태
- 7일 기온·강수 예보
- 작물별 위험을 만든 실제 값과 기준
- 지역 토양 pH 분포
- 오늘 필요한 행동과 다시 확인할 시점

## 8. 남은 재감사 조건

다음 조건이 충족된 뒤에만 `READY` 재감사를 진행할 수 있다.

1. 기후평년 실제 응답 성공
2. ASOS 최근·과거 관측 실제 응답 성공
3. 필지 토양특성 및 최근 pH·EC 실제 응답 성공
4. 과거 발행 예보 응답 성공과 백테스트 지표 산출
5. 초보·고령 실제 사용자 5명 평가, 최소 4명 무도움 완료
6. 위 조건을 포함한 전체 자동 테스트와 실제 화면 재검증

현재 상태에서 API 오류를 샘플 데이터로 숨기거나 수치를 추정해 `READY`로 승격하지 않는다.
