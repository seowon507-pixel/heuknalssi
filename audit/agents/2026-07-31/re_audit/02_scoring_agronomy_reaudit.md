# 계산 로직·농업 데이터·근거 품질 독립 재감사

## 1. 범위와 결론

- 재감사일: 2026-07-31 (Asia/Seoul)
- 대상: `demo1`, 기준 HEAD `127dfb314f73de3bfda97efcc80458d13d8bc5b9` 위 최신 작업트리
- 비교 보고서: `audit/agents/2026-07-31/02_scoring_agronomy.md`
- 권위 명세: `09_흙날씨진단_서비스로직_명세서.md`
- 검증 범위: 기후·토양·예보 축 분리, 5작물 규칙, 작기·생육단계, 결측·부분 성공, 필지/지역 토양 구분, 원인→위험→행동→재확인, 실제 localhost API
- 비밀 취급: `.env`와 비밀값을 열거나 출력하지 않았다. 제품 코드는 수정하지 않았다.
- 평가 성격: 실제 농업인 또는 실제 농업 전문가의 사용평가가 아니라 코드·계약·실행 결과를 이용한 독립 재감사다.

**최종 판정: 로컬 본선 시연은 `CONDITIONAL_APPROVAL`, 실사용 정확도 주장에는 `CHANGES_REQUESTED`.**

이전 승인 차단 원인이던 60:40 합산점수, 현재 달 자동 작기, 날짜만으로 확정한 생육단계는 모두 안전한 방향으로 시정됐다. 현재 확인된 P0는 0건이다. 다만 과거 발행 예보 백테스트가 아직 `BLOCKED`이고, `5작물 CONFIGURED`가 실제 농업 위험 커버리지보다 넓게 읽힐 수 있어 실사용 승인에는 P1 2건이 남는다.

## 2. 점수

| 항목 | 이전 | 재감사 | 판단 근거 |
|---|---:|---:|---|
| 문제 적합성 | 6.0 | 8.6 | 특정 위치의 공공 기상·토양을 작물별로 해석하고 현장 행동으로 연결한다. |
| 정확성과 신뢰 | 3.0 | 8.4 | 합산점수를 제거했고 `UNKNOWN` 작기는 기후 `HOLD`로 보존한다. 다만 피해사건 기반 외부 검증은 없다. |
| 설명 가능성 | 5.0 | 8.6 | 날짜·임계·출처·원인·행동·재확인 시점이 위험 근거에 연결된다. |
| 결측·부분 실패 | 8.0 | 9.0 | 결측을 0으로 바꾸지 않고 축별 상태를 유지하며 다중 작물 부분 성공도 보존한다. |
| 토양 근거 품질 | 6.0 | 8.2 | 필지 검정, 지역 통계, 1:5,000 토양도 물리특성을 분리한다. 코드 라벨 해석은 아직 사용자에게 충분히 제시되지 않는다. |
| 농업 타당성 검증 | 5.0 | 6.6 | 출처·검수 메타데이터와 경계 테스트는 있으나 실제 과거 발행 예보 정확도 및 피해 결과 교정이 없다. |
| 사용성·오인 방지 | 6.0 | 8.5 | 숫자 건강점수 대신 기후·토양·가까운 예보를 독립 상태로 보여준다. |
| 안정성·테스트 | 8.0 | 8.6 | 관련 결정 테스트 143개와 실제 5작물·작기 흐름이 통과했다. 백테스트는 명시적으로 막혔다. |
| 본선 시연성 | 5.0 | 8.8 | 같은 안동 자료가 작물별 임계와 행동으로 달라지는 장면을 방어 가능하게 시연할 수 있다. |
| 실사용 준비도 | 4.5 | 7.0 | 과학 계산은 안전하지만 백테스트와 공유 상태가 준비되지 않아 생산 주장을 제한해야 한다. |
| **평균** | **5.6** | **8.2** | 이전 P0/P1 핵심은 해소됐고, 실사용 검증 P1이 남는다. |

## 3. 기존 P0/P1 시정 결과

| 기존 지적 | 재검증 근거 | 상태 |
|---|---|---|
| P0 — 예보 60% + 토양 40% 단일 `생육점수` | `crop-condition-score.mjs`와 배포 산출물 모두 삭제됐다. 최종 화면은 `기후 조건 / 토양 조건 / 가까운 예보` 상태를 각각 표시하며 “서로 다른 자료를 하나의 점수로 합치지 않습니다”라고 명시한다 (`ui-integration/backend-client.mjs:1925-2008`). 제품 코드에는 합산 계산 경로가 없다. | **RESOLVED** |
| P0 — `PARTIAL/HOLD`와 결측을 숫자·등급으로 투영 | 축별 `READY/PARTIAL/HOLD/UNAVAILABLE`를 그대로 표시하고 출처별 `LIVE/CACHE/NO_DATA`를 별도 칩으로 표시한다. 실제 API에서도 사과 토양 `PARTIAL`, 감자 기후 `HOLD`가 그대로 유지됐다. | **RESOLVED** |
| P0 — 감자·오이·상추 작기를 현재 달 하나로 자동 확정 | `current`→현재 월 변환이 삭제됐다. `UNKNOWN`이면 `startMonth/endMonth=null`이고 기후 엔진이 즉시 `HOLD/SEASON_UNKNOWN`을 반환한다 (`ui-integration/api-contract.mjs:286-314`, `backend-v3/src/domain/climate.js:42-50`). | **RESOLVED** |
| P1 — 날짜 기준 `AI 예상`이 일반 생육단계를 과대표현 | 기본값은 `잘 모름/UNSPECIFIED`이며 날짜만으로 단계를 확정하지 않는다고 안내한다. 배 개화·감자 괴경비대·시설 상추 화아분화만 검수된 구체 단계로 매핑한다 (`ui-integration/ui-shell.mjs:330-399`, `ui-integration/api-contract.mjs:217-225`). | **RESOLVED** |
| P1 — 최종 UI 안전불변조건을 테스트하지 않음 | UI 계약 테스트가 합산점수 문자열과 계산 함수를 금지하고 독립 상태·부분 성공 경로를 검사한다. 다만 부분 성공 검사는 아직 소스 패턴 검사라 동적 브라우저 회귀는 P2로 남긴다. | **RESOLVED WITH P2** |

## 4. 실제 API 재검증

### 4.1 실행 조건

- 제품: `http://localhost:3000`
- 주소: `경상북도 안동시 퇴계로 115`
- 위치 결과: HTTP 200, 후보 1개, `ADDRESS_RESOLVED`, 표시명 `경북 안동시 퇴계로 115`
- 분석: `ACTIVE_GROWING`, 노지, 생육단계 `UNSPECIFIED`
- API 응답에서 비밀값·좌표·필지 식별자는 출력하지 않았다.

### 4.2 5작물 축별 상태

| 작물·작기 | HTTP | 기후 | 토양 | 예보/위험 | 전체 | 결정 | 현재 위험 수 | 원인·행동·재확인 완결 |
|---|---:|---|---|---|---|---|---:|---|
| 사과·연간 검수 프로필 | 201 | READY | PARTIAL | READY | PARTIAL | CHECK_FIRST | 10 | PASS |
| 배·연간 검수 프로필 | 201 | READY | READY | READY | COMPLETE | CHECK_FIRST | 10 | PASS |
| 감자·UNKNOWN | 201 | **HOLD** | READY | **READY** | PARTIAL | DATA_NEEDED | 11 | PASS |
| 오이·UNKNOWN | 201 | **HOLD** | PARTIAL | **READY** | PARTIAL | DATA_NEEDED | 9 | PASS |
| 상추·UNKNOWN | 201 | **HOLD** | PARTIAL | **READY** | PARTIAL | DATA_NEEDED | 11 | PASS |

`UNKNOWN`의 핵심 계약은 실제 호출에서 정확히 지켜졌다. 장기 기후는 추측하지 않아 `HOLD`였고, 같은 위치의 토양과 가까운 예보는 계속 계산됐다. 오이는 현재 `WARNING` 위험이 있어 `CONFIRM_SEASON`보다 `CHECK_CURRENT_FORECAST_RISK`가 우선 행동으로 올라왔다. 이는 긴급한 현재 위험을 먼저 보여 주는 의도된 행동 우선순위다.

검수 프리셋을 명시한 추가 실제 호출도 통과했다.

| 작물·작기 | 기후 | 토양 | 예보 | 결정 |
|---|---|---|---|---|
| 감자·봄 작기 3~6월 | READY | READY | READY | CHECK_FIRST |
| 오이·여름 작기 6~8월 | READY | PARTIAL | READY | CHECK_FIRST |
| 상추·가을·겨울 작기 9~2월 | READY | PARTIAL | READY | CHECK_FIRST |

### 4.3 실제 출처·토양 분리

실제 5작물 응답에서 다음 출처 계약을 확인했다.

- 기후평년: `NORMAL_STATION`, LIVE 또는 CACHE, SUCCESS
- ASOS 최근 관측: `OBSERVATION_STATION`, LIVE 또는 CACHE, SUCCESS
- 농경지화학성 통계 V2: `REGIONAL_SOIL_STAT`, LIVE 또는 CACHE, SUCCESS
- 토양특성 상세 V3: `FIELD`, LIVE 또는 CACHE, SUCCESS
- 토양검정 화학성 V2: 해당 필지 `NO_DATA/UNAVAILABLE`
- 단기예보: `FORECAST_GRID`, LIVE 또는 CACHE, SUCCESS
- 중기예보: `FORECAST_REGION`, LIVE 또는 CACHE, SUCCESS

사과 실호출의 토양 결과는 다음처럼 공간 의미를 분리했다.

```text
fieldProfileState = SUCCESS
fieldProfile = 1:5,000 토양도 / 배수 코드 02 / 유효토심 코드 03 / 표토 토성 코드 03
fieldProfile.codeLabelsVerified = false
measurementBasis = REGIONAL_STATISTICS
regionalStatistics.usedForDecision = true
```

즉 1:5,000 필지 토양도는 물리 특성 참고자료로 붙고, pH 판정은 지역 통계를 쓴다. 둘을 평균하거나 필지 pH라고 바꾸지 않는다. 실제 필지 토양검정값이 있으면 `USER_SOIL_TEST → PROVIDER_SOIL_TEST → REGIONAL_STATISTICS` 순서로 하나만 선택하며 섞지 않는다 (`backend-v3/src/application/services.js:429-462`).

작물마다 토양 결과가 달라지는 것은 원자료가 달라서가 아니라, 과수원/밭 토지이용 통계와 작물별 pH 적정 범위가 다르기 때문이다. UI도 이를 “지역 통계이며 실제 밭 실측값이 아님”으로 명시한다 (`ui-integration/backend-client.mjs:2932-2962`).

## 5. 원인 → 위험 → 행동 → 재확인 검증

- 모든 검수된 예보 위험 규칙은 임계 비교, 심각도, 원인 문장, 1~3개 행동, 출처, 재확인 시점을 가진다. 규칙이 별도 재확인 문구를 갖지 않으면 보수적 공통 문구가 자동으로 붙는다 (`backend-v3/runtime/reviewed-crop-rules.js:145-181`).
- 실제 안동 5작물 응답에서 활성 위험 51건 모두 `guidance.reason`, 비어 있지 않은 `guidance.actions`, `guidance.recheck`를 가졌다.
- UI는 가장 가까운 현재 위험의 날짜·임계 → 위험 이유 → 오늘 행동을 우선 카드로 표시하고, 토양과 날씨를 합치지 않은 채 행동 목록만 중복 제거한다 (`ui-integration/backend-client.mjs:1160-1250`, `2700-2782`).
- 예보 위험이 없을 때도 “확인한 기간/등록된 규칙 범위에서 기준 초과 없음”으로 한정하며, 자료가 부족하면 무위험으로 확정하지 않는다.
- 토양은 `reason`, 현장 행동, `verificationActions`를 별도로 가진다. 지역 통계는 시비 처방으로 바로 바꾸지 않고 실제 토양검정 확인으로 연결한다.

판정: **5작물의 현재 예보 위험 경로는 PASS.** 다만 이것은 등록된 기온 위험 규칙의 완결성을 뜻하며, 병해충·강풍·강수 지속·수확량 등 미등록 위험까지 다룬다는 뜻은 아니다.

## 6. 결측·부분 성공 검증

| 계약 | 결과 | 근거 |
|---|---|---|
| 결측을 0으로 바꾸지 않음 | PASS | 기후 coverage와 토양 planned weight 경계 테스트 통과 |
| `UNKNOWN` 작기에서 기후를 추정하지 않음 | PASS | 실제 3작물 모두 climate `HOLD`, soil/forecast 유지 |
| 토양 `PARTIAL/HOLD`를 점수로 환산하지 않음 | PASS | 점수 모듈 삭제, 상태 텍스트 유지 |
| 필지 토양검정과 지역 통계를 평균하지 않음 | PASS | 우선순위 단일 basis 선택, 실제 응답 `measurementBasis` 보존 |
| 예보 결측을 무위험으로 판단하지 않음 | PASS | missing metric·stale/sample·source boundary 테스트 통과 |
| 다중 작물 일부 실패 시 성공 결과 보존 | PASS(코드), P2(동적 회귀) | `Promise.allSettled`, 성공 0건일 때만 전체 실패 (`backend-client.mjs:941-983`) |

## 7. 잔여 발견 사항

### P1-01. 과거 발행 예보와 실제 관측의 정확도 백테스트가 아직 막혀 있다

`npm --prefix backend-v3 run verify:backtest` 결과:

- `historicalAsos: UNSUPPORTED`
- `historicalIssuedForecast: UNSUPPORTED`
- replay `BLOCKED / ASOS_UNSUPPORTED`
- accuracy `BLOCKED / ASOS_UNSUPPORTED + ISSUED_FORECAST_UNSUPPORTED`

현재 로직이 임계값과 결측 계약을 정확히 실행한다는 것은 검증됐지만, “과거 시점에 이 서비스가 어떤 주의를 냈고 실제 관측/피해와 얼마나 일치했는가”는 아직 증명되지 않았다. 따라서 발표에서는 **정확도, 피해 예방률, 예측 성공률을 수치로 주장하면 안 된다.** 본선 전 최소 한 지역·한 작물의 과거 발행 예보 replay를 완성하거나, 시연에서는 “검수 규칙을 현재 공공자료에 적용한 선제 점검”으로 한정해야 한다.

### P1-02. `completeCropCount: 5`는 실행 계약 완성이지 농업 위험 커버리지 완성이 아니다

preflight는 5작물이 기후·토양·예보 모듈을 실행할 수 있으면 `CONFIGURED`로 센다 (`backend-v3/src/application/services.js:755-785`). 현재 농업 범위는 주로 다음과 같다.

- 기후: 평균기온 범위 또는 단일 목표
- 토양 판정: 실제 라이브 지역 통계에서는 작물별 pH가 핵심
- 예보: 최고·최저기온 중심, `ANY_DAY` 위험
- 구체 생육단계: 배 개화, 감자 괴경비대, 시설 상추 화아분화 일부

이는 5작물의 모든 주요 실패 원인·생육단계·지역 품종·강수 지속·풍속·배수 영향을 검증했다는 뜻이 아니다. 기술 화면과 발표에서 `5작물 로직 완성`보다 **`5작물 최소 실행 규칙 구성 완료`**라고 표현해야 한다. 미지원 위험 목록을 작물별로 공개하면 심사 질문에도 안전하다.

### P2-01. `잘 모름` 작기와 프리셋 월의 사용자 확인 의미를 더 명확히 해야 한다

현재 UI는 감자·오이·상추의 `잘 모름`을 기본 체크한 뒤 `userConfirmed:true`로 보낸다 (`ui-shell.mjs:255-281`, `api-contract.mjs:286-298`). 결과는 안전하게 기후 `HOLD`이므로 P0 재발은 아니다. 다만 명세의 “사용자가 UNKNOWN을 명시적으로 선택”과는 다르게, 사용자가 아무 선택을 하지 않아도 확인값처럼 기록될 수 있다.

또한 봄·여름·가을 프리셋은 코드에 고정된 월 범위이고 사용자가 실제 파종/정식 시작·종료월을 직접 입력하는 경로가 없다. 다음 개선에서는 기본 미선택 또는 다음 단계에서 “잘 모름으로 진행”을 한 번 확인하고, 실제 시작·종료월 직접 입력을 제공해야 한다. 프리셋 월에는 농작업일정 출처와 지역·품종 한계를 붙여야 한다.

### P2-02. 필지 물리 토양정보는 확보했지만 코드 라벨이 검수되지 않아 설명력이 제한된다

실제 API는 배수·유효토심·표토 토성 코드를 반환했지만 `codeLabelsVerified:false`다. 이는 모르는 코드를 임의 번역하지 않는 안전한 동작이다. 그러나 사용자 화면은 “배수·토성·뿌리층 확인됨”이라고만 말하고 실제 상태값은 설명하지 못한다. 공식 코드표 계약을 동결한 뒤 `배수 양호/불량`, `토성`, `유효토심`을 출처와 함께 표시하고, 관찰 행동은 그때만 속성별로 구체화해야 한다.

### P2-03. 다중 작물 부분 성공 회귀는 브라우저 동적 테스트로 고정할 필요가 있다

현재 구현은 올바르게 `Promise.allSettled`를 사용하고 실제 5작물 정상 호출은 모두 완료됐다. 하지만 자동 테스트는 소스 문자열을 확인하는 수준이다. 5개 중 1개 API가 실패하는 fixture로 성공 4개 탭 보존, 실패 작물 배너, 재시도, 저장 데이터 불오염을 DOM 수준에서 검증해야 한다.

## 8. 실행한 검사

| 검사 | 결과 |
|---|---|
| `node --test ui-integration/api-contract.test.mjs ui-integration/product-first-ui.test.mjs` | **40/40 PASS** |
| `node --test backend-v3/test/domain-engine.test.js backend-v3/test/application.test.js backend-v3/test/reviewed-runtime-assets.test.js` | **103/103 PASS** |
| 실제 위치 검색 + 5작물 분석 | 후보 1개, 분석 **5/5 HTTP 201** |
| 실제 UNKNOWN 작기 3종 | 기후 HOLD, 토양·예보 유지 **3/3 PASS** |
| 실제 검수 프리셋 3종 | 기후 계산 재개 **3/3 PASS** |
| 실제 필지/지역 토양 분리 | field profile SUCCESS, decision basis REGIONAL_STATISTICS **PASS** |
| preflight | scientific `READY`, 5작물 configured; deployment `HOLD/SHARED_STATE_NOT_CONFIGURED` |
| `npm --prefix backend-v3 run verify:backtest` | **CHANGES_REQUESTED / BLOCKED** |

## 9. 향후 인공위성 기능의 안전 원칙

위성 기능은 현재 재감사 승인 대상이 아니며 다음 원칙을 지켜 별도 축으로만 추가해야 한다.

1. 사용자가 확인한 실제 노지 필지 폴리곤이 없으면 결과를 만들지 않는다.
2. Sentinel-2 촬영일, 공간해상도, 구름·그림자 마스크, 유효 픽셀 수·비율을 항상 보존한다.
3. NDVI는 식생 반사 관찰값이다. 건강도·병해충 원인·수확량·생육점수로 이름을 바꾸지 않는다.
4. 동일 AOI·해상도·마스크 정책의 비교 가능한 장면에서만 변화량을 계산한다.
5. 위성 결과는 기후·토양·ASOS·예보를 올리거나 내리거나 하나의 점수로 합치지 않는다.
6. 품질 기준 미달은 `HOLD`로 두고 사진·현장 확인이 필요한 구역을 찾는 보조 근거로만 사용한다.

## 10. 재승인 조건

### 본선 로컬 시연

- 현재 상태로 조건부 승인 가능하다.
- 발표에서 종합 건강점수·정확도·피해 예방률을 주장하지 않는다.
- `5작물 최소 실행 규칙`, `축별 상태`, `현재 예보에서 확인한 위험`으로 범위를 정확히 말한다.

### 실사용·배포

1. 과거 ASOS와 과거 발행 예보 replay 최소 1개 이상 통과
2. `5작물 CONFIGURED`와 `농업 위험 커버리지` 문구 분리
3. 작기 `UNKNOWN`의 명시 확인 또는 미선택 차단
4. 작기 직접 월 입력과 프리셋 출처 표시
5. 공유 상태 저장소 구성 후 deployment `READY`

## 최종 요약

- 이전 P0: **2/2 해소**
- 이전 P1: **3/3 핵심 해소**
- 현재 확인된 P0: **0건**
- 잔여 P1: **2건**
- 잔여 P2: **3건**
- 로컬 본선 시연: **CONDITIONAL_APPROVAL**
- 실사용 정확도·생산 배포: **CHANGES_REQUESTED**
