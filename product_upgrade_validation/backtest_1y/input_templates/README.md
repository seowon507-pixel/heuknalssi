# 실제 농사 결과·과거 토양 백테스트 입력

이 폴더의 CSV는 더미 데이터가 아니라 실제 농장 기록을 넣기 위한 빈 계약이다.
헤더 이름과 순서를 바꾸지 않는다. 필지 원문 주소·PNU·사용자 이름은 넣지 않고,
백엔드가 발급한 불투명한 `farm_id`, `parcel_id`, `season_id`만 사용한다.

## 파일

- `farm-outcomes.csv`: 작기별 첫 수확일·마지막 수확일
- `damage-events.csv`: 사진·현장 확인으로 확정된 병해 또는 피해 발생일
- `harvest-predictions.csv`: 실제 결과를 알기 전에 저장한 수확 예상 범위
- `risk-alerts.csv`: 실제 피해를 알기 전에 발행한 위험 알림과 유효기간
- `soil-snapshots.csv`: 검정일이 보존된 필지 토양검정·토양도 물리성 기록
- `soil-analysis-dates.csv`: 과거 토양 상태를 재생할 농장·필지·날짜

날짜는 `YYYY-MM-DD`, 시각은 UTC ISO 형식(`2026-08-04T00:00:00.000Z`)을 쓴다.
토양 수치는 없으면 빈칸으로 남기며 0으로 채우지 않는다. `source_type`은
`FIELD_EXAM`, `SOIL_MAP`처럼 실제 출처 종류를 기록한다.

실행:

```bash
cd backend-v3
npm run verify:backtest:evidence
```

검증기는 결과를 `evidence-backtest-state.json`에 저장한다. 피해가 기록되지 않은
날을 자동으로 건강한 날로 간주하지 않으며, 분석일 이후에 채취된 토양값은 절대
과거 분석에 사용하지 않는다.
