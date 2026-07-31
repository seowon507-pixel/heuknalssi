import assert from "node:assert/strict";
import test from "node:test";

import { summarizeForecastEvaluation } from "./forecast-presentation.mjs";

const CROPS = ["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"];
const DAYS = Array.from({ length: 5 }, (_, index) => ({
  date: `2026-07-${String(index + 27).padStart(2, "0")}`,
  sourceType: "SHORT_GRID",
}));

test("검토가 끝난 예보 범위는 모든 작물에서 미완성 판정 문구로 노출하지 않는다", () => {
  for (const crop of CROPS) {
    for (const forecastState of ["READY", "PARTIAL", "HOLD"]) {
      const result = summarizeForecastEvaluation({
        crop,
        forecastState,
        days: DAYS,
        risks: [],
        ruleEvaluations: [
          {
            ruleId: `${crop.toLowerCase()}.forecast.baseline.v1`,
            status: "EVALUATED_NO_RISK",
            evaluatedDayCount: 5,
            missingDayCount: forecastState === "READY" ? 0 : 2,
          },
        ],
      });

      assert.equal(result.evaluatedDayCount, 5);
      assert.match(result.condition, /5일/);
      assert.doesNotMatch(
        `${result.condition} ${result.reason}`,
        /판정 확인|로직|확정하지 못|일부 조건/,
      );
      assert.ok(result.actions.length > 0);
    }
  }
});

test("일부 날짜만 비교 가능하면 확인 범위와 다음 갱신을 분리한다", () => {
  const result = summarizeForecastEvaluation({
    crop: "CUCUMBER",
    forecastState: "PARTIAL",
    days: DAYS,
    risks: [],
    ruleEvaluations: [
      {
        ruleId: "cucumber.forecast.low.v1",
        status: "PARTIAL",
        evaluatedDayCount: 3,
        missingDayCount: 2,
      },
    ],
    missingMetrics: [
      {
        metric: "maxTemperature",
        date: "2026-07-30",
        reason: "MISSING_VALUE",
      },
    ],
  });

  assert.equal(result.kind, "CLEAR_WITH_LIMIT");
  assert.equal(result.evaluatedDayCount, 3);
  assert.match(result.condition, /3일/);
  assert.match(result.reason, /7월 30일 최고기온/);
  assert.match(result.recheck, /예보가 갱신/);
});

test("예보만 있고 비교 결과가 없을 때도 기술적인 실패 문구를 숨긴다", () => {
  const result = summarizeForecastEvaluation({
    crop: "PEAR",
    forecastState: "HOLD",
    days: DAYS,
    risks: [],
    ruleEvaluations: [],
  });

  assert.equal(result.kind, "DATA_ONLY");
  assert.match(result.condition, /5일 예보 도착/);
  assert.doesNotMatch(
    `${result.condition} ${result.reason}`,
    /판정 확인|로직|확정하지 못/,
  );
});
