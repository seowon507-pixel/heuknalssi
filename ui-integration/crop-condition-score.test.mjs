import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCropConditionScore,
  forecastConditionScore,
  soilConditionScore,
} from "./crop-condition-score.mjs";

function soilMetric({
  fitRatio = 1,
  uncertainRatio = 0,
  outsideRatio = 0,
  rawWeight = 1,
} = {}) {
  return { fitRatio, uncertainRatio, outsideRatio, rawWeight };
}

function forecast({
  risks = [],
  riskState = "READY",
  noActiveRisksConfirmed = risks.length === 0,
} = {}) {
  return {
    state: riskState,
    result: {
      riskState,
      risks,
      noActiveRisksConfirmed,
    },
  };
}

function temperatureRisk({
  value,
  threshold,
  severity = "CAUTION",
} = {}) {
  return {
    severity,
    sourceFreshness: "CURRENT",
    trigger: {
      metric: "maxTemperature",
      comparison: { operator: "GTE", threshold },
      readings: [{ date: "2026-07-27", value }],
    },
  };
}

test("주의 신호가 없고 토양이 적합하면 작물 상태 예상 점수가 높다", () => {
  const result = calculateCropConditionScore({
    forecast: forecast(),
    soil: {
      state: "READY",
      result: {
        measurementBasis: "USER_SOIL_TEST",
        metrics: [soilMetric()],
      },
    },
  });

  assert.equal(result.score, 100);
  assert.equal(result.label, "양호");
  assert.equal(result.basisLabel, "사용자 등록 토양검정");
});

test("같은 토양에서 작물 기준 초과가 커질수록 점수가 낮아진다", () => {
  const mild = calculateCropConditionScore({
    forecast: forecast({ risks: [temperatureRisk({ value: 26, threshold: 25 })] }),
    soil: { state: "READY", result: { metrics: [soilMetric()] } },
  });
  const severe = calculateCropConditionScore({
    forecast: forecast({ risks: [temperatureRisk({ value: 33, threshold: 25 })] }),
    soil: { state: "READY", result: { metrics: [soilMetric()] } },
  });

  assert.ok(mild.score > severe.score);
  assert.equal(severe.label, "점검 필요");
});

test("토양 적합 면적이 줄어들수록 토양 상태 점수가 낮아진다", () => {
  assert.equal(soilConditionScore({ result: { metrics: [soilMetric()] } }), 100);
  assert.equal(
    soilConditionScore({
      result: {
        metrics: [
          soilMetric({
            fitRatio: 0,
            uncertainRatio: 0.5,
            outsideRatio: 0.5,
          }),
        ],
      },
    }),
    33,
  );
});

test("필요한 예보 또는 토양값이 없으면 0점으로 꾸미지 않고 미산정한다", () => {
  const missingForecast = calculateCropConditionScore({
    forecast: forecast({ riskState: "PARTIAL" }),
    soil: { state: "READY", result: { metrics: [soilMetric()] } },
  });
  const missingSoil = calculateCropConditionScore({
    forecast: forecast(),
    soil: { state: "HOLD", result: { metrics: [] } },
  });

  assert.equal(missingForecast.score, null);
  assert.equal(missingSoil.score, null);
  assert.equal(missingSoil.label, "산정 대기");
});

test("미래 위험 판정이 끝나지 않으면 날씨 점수를 만들지 않는다", () => {
  assert.equal(
    forecastConditionScore(forecast({ riskState: "PARTIAL" })),
    null,
  );
});

test("사진과 시설 센서 입력 없이도 날씨·토양 자료만으로 점수를 계산한다", () => {
  const result = calculateCropConditionScore({
    forecast: forecast(),
    soil: {
      state: "READY",
      result: {
        measurementBasis: "REGIONAL_STATISTICS",
        metrics: [soilMetric({ fitRatio: 0.8, uncertainRatio: 0.2 })],
      },
    },
  });

  assert.equal(result.score, 97);
  assert.equal(result.basisLabel, "지역 토양 통계 추정");
});
