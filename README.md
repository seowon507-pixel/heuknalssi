# nong · 흙날씨

농업 종사자가 지역·작물·재배 조건을 입력하면 공개자료의 준비 상태,
확인할 위험과 다음 행동을 보수적으로 안내하는 해커톤 프로젝트입니다.

## 현재 상태

- 기존 반응형 UI와 `backend-v3` HTTP API 연결 완료
- 세션·CSRF·위치 후보 확인·분석·보고서 흐름 구현
- 개발 샘플과 운영 준비 보류(`HOLD`) 상태를 화면에서 명확히 구분
- 5개 작물의 공식 근거 기반 기온·토양 pH·수치형 위험 규칙 구현
- 6개 시·군의 행정구역 코드와 기상청 기후평년 관측소 매핑 구현
- 기상청 단기예보와 농경지화학성 통계정보 V2의 지역 pH 분포 연동
- 날씨·지역 토양 근거를 함께 설명하고 작물별 점검 행동을 제시
- Google AI가 검증된 분석 근거만 선택하는 농장 분석 도우미 제공
- 기상·토양·예보를 따로 보여주는 현재 농장 상태 카드 제공
- 실제 데이터베이스는 아직 연결하지 않음
- 분석 결과는 현재 익명 세션 메모리에만 보관되며 서버 재시작 시 사라짐

## 실행

Node.js 22 이상이 필요합니다.

```sh
node ui-integration/dev-server.mjs --sample
```

브라우저에서 <http://localhost:3000>을 엽니다.

`--sample`은 UI와 API 연결 검증 전용입니다. 화면에 표시되는 샘플 자료를
실제 농업·토지 의사결정에 사용하면 안 됩니다.

안전 기본 상태는 다음 명령으로 확인할 수 있습니다.

```sh
node ui-integration/dev-server.mjs --safe
```

검수된 외부 runtime과 API 키를 연결하는 방법은
[`11_UI_백엔드_연결_가이드.md`](./11_UI_백엔드_연결_가이드.md)를
참고하세요.

API 없이 검수된 정적 규칙·지역 매핑만 백엔드에 로드하는 방법은
[`backend-v3/runtime/README.md`](./backend-v3/runtime/README.md)를
참고하세요. 필지의 실제 pH·EC, 중기예보 세부 구역, 필지별 최근 관측소
거리는 추정하지 않으며 검증 전까지 `HOLD`입니다.

공공데이터 키가 env 파일에 있다면 값을 복사하지 않고 다음처럼 명시적으로
불러올 수 있습니다.

```sh
node \
  --env-file=/absolute/path/to/.env \
  ui-integration/dev-server.mjs --external
```

이 모드에서는 공공데이터 키가 있을 때 기상청 단기·중기 어댑터와
농경지화학성 통계정보 V2의 지역 pH 분포를 활성화합니다. 토양 통계는
법정동 코드에 대응하는 지역 분포이며 사용자의 필지 실측값으로 표시하지
않습니다. 필지 pH·EC는 별도 토양검정 결과가 필요합니다.
`GOOGLE_AI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` 중 하나가 있으면
농장 분석 도우미가 활성화됩니다. 키는 백엔드에서만 사용합니다.

## 검사

```sh
node --test ui-integration/*.test.mjs
cd backend-v3
npm run check
npm test
```

현재 검증 결과는 UI 통합 테스트 30/30, 백엔드 테스트 232/232 통과입니다.

## 주요 경로

- `08_흙날씨진단_UI_샘플.html`: 기존 제품 UI
- `ui-integration/`: 브라우저 API 클라이언트와 동일 출처 개발 서버
- `backend-v3/`: 결정론적 분석 API와 테스트
- `product_first_baseline/`: Product-first 실제 화면 및 목표 시안 증거
- `07_`~`11_` 문서: 기획, 서비스 로직, 백엔드 평가 및 연결 기록
- `PRODUCT_FIRST_PRD.md`: 제품 우선 개발 기준
