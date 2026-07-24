# nong · 흙날씨

농업 종사자가 지역·작물·재배 조건을 입력하면 공개자료의 준비 상태,
확인할 위험과 다음 행동을 보수적으로 안내하는 해커톤 프로젝트입니다.

## 현재 상태

- 기존 반응형 UI와 `backend-v3` HTTP API 연결 완료
- 세션·CSRF·위치 후보 확인·분석·보고서 흐름 구현
- 개발 샘플과 운영 준비 보류(`HOLD`) 상태를 화면에서 명확히 구분
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

## 검사

```sh
node --test ui-integration/*.test.mjs
cd backend-v3
npm run check
npm test
```

현재 검증 결과는 UI 통합 테스트 11/11, 백엔드 테스트 191/191 통과입니다.

## 주요 경로

- `08_흙날씨진단_UI_샘플.html`: 기존 제품 UI
- `ui-integration/`: 브라우저 API 클라이언트와 동일 출처 개발 서버
- `backend-v3/`: 결정론적 분석 API와 테스트
- `product_first_baseline/`: Product-first 실제 화면 및 목표 시안 증거
- `07_`~`11_` 문서: 기획, 서비스 로직, 백엔드 평가 및 연결 기록
- `PRODUCT_FIRST_PRD.md`: 제품 우선 개발 기준
