import assert from "node:assert/strict";
import test from "node:test";

import {
  canReconcileProjectedActions,
  projectAnalysisAction,
} from "./action-projection.mjs";

test("위험 해제는 예보 판정이 완료된 분석에서만 실행한다", () => {
  assert.equal(canReconcileProjectedActions({ forecast: { result: { riskState: "READY" } } }), true);
  assert.equal(canReconcileProjectedActions({ forecast: { result: { riskState: "PARTIAL" } } }), false);
  assert.equal(canReconcileProjectedActions({ forecast: { result: { riskState: "HOLD" } } }), false);
});

test("예보 위험의 실제 규칙·날짜·발표시각으로 행동을 투영한다", () => {
  const result = projectAnalysisAction(
    {
      actionId: "CHECK_CURRENT_FORECAST_RISK",
      triggerIds: ["apple-heat:2026-08-01:2026-08-03"],
      dueWindow: "1_TO_3_DAYS",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "CURRENT",
    },
    {
      createdAt: "2026-07-31T00:00:00.000Z",
      state: "HOLD",
      inputSummary: { locationPrecision: "ADMIN_AREA" },
      forecast: {
        result: {
          risks: [{
            riskId: "apple-heat:2026-08-01:2026-08-03",
            ruleId: "apple.forecast.heat.v2",
            dateRange: { from: "2026-08-01", to: "2026-08-03" },
          }],
        },
        evidence: [{
          evidenceId: "apple-heat:2026-08-01:2026-08-03",
          ruleId: "apple.forecast.heat.v2",
          module: "FORECAST",
          sourceType: "SHORT_GRID",
          inclusion: "INCLUDED",
          evidenceStatus: "RISK_ONLY",
          spatialLevel: "FORECAST_GRID",
          observedAt: null,
          issuedAt: "2026-07-31T02:00:00.000Z",
          deliveryState: "LIVE",
          freshness: "CURRENT",
          qualityFlags: [],
        }],
      },
      dataSources: [{
        sourceId: "kma-short-forecast",
        sourceName: "기상청 단기예보",
        retrievedAt: "2026-07-31T02:05:00.000Z",
        issuedAt: "2026-07-31T02:00:00.000Z",
        spatialLevel: "FORECAST_GRID",
        deliveryState: "LIVE",
        adapterState: "SUCCESS",
        qualityFlags: [],
      }],
    },
  );

  assert.equal(result.ruleId, "apple.forecast.heat.v2");
  assert.equal(result.horizon, "UPCOMING");
  assert.equal(result.dueAt, "2026-07-31T21:00:00.000Z");
  assert.equal(result.recheckAt, "2026-08-03T23:00:00.000Z");
  assert.equal(result.timingBasis, "HIGH_TEMPERATURE_RISK_DAY_06_KST");
  assert.deepEqual(result.evidenceRefs, [{
    sourceKind: "PUBLIC_API",
    sourceId: "apple-heat:2026-08-01:2026-08-03",
    observedAt: "2026-07-31T02:00:00.000Z",
    fetchedAt: "2026-07-31T02:05:00.000Z",
    spatialLevel: "FORECAST_GRID",
    state: "READY",
    limitationCodes: [],
  }]);
});

test("저온 위험은 위험일 전날 18시에 예방 행동을 마친다", () => {
  const result = projectAnalysisAction(
    {
      actionId: "CHECK_CURRENT_FORECAST_RISK",
      triggerIds: ["pear-frost:2026-08-02"],
      dueWindow: "1_TO_3_DAYS",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "CURRENT",
    },
    forecastAnalysis({
      riskId: "pear-frost:2026-08-02",
      ruleId: "pear.open-field.forecast.min-temperature-lte.v1",
      metric: "minTemperature",
      from: "2026-08-02",
      to: "2026-08-02",
    }),
  );

  assert.equal(result.dueAt, "2026-08-01T09:00:00.000Z");
  assert.equal(result.timingBasis, "LOW_TEMPERATURE_PREVIOUS_DAY_18_KST");
});

test("강수와 지속기간 신호는 위험 시작 전날 18시를 예방 기한으로 삼는다", () => {
  const precipitation = projectAnalysisAction(
    {
      actionId: "CHECK_CURRENT_FORECAST_RISK",
      triggerIds: ["rain-window:2026-08-03"],
      dueWindow: "1_TO_3_DAYS",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "CURRENT",
    },
    forecastAnalysis({
      riskId: "rain-window:2026-08-03",
      ruleId: "lettuce.forecast.rain.v1",
      metric: "precipitationProbability",
      duration: { kind: "CONSECUTIVE_DAYS", count: 2 },
      from: "2026-08-03",
      to: "2026-08-04",
    }),
  );

  assert.equal(precipitation.dueAt, "2026-08-02T09:00:00.000Z");
  assert.equal(precipitation.timingBasis, "DURATION_RISK_PREVIOUS_DAY_18_KST");
});

test("해석할 근거가 없으면 분석 전체 시각과 상태를 근거로 위장하지 않는다", () => {
  const result = projectAnalysisAction(
    {
      actionId: "COLLECT_REQUIRED_DATA",
      triggerIds: ["state:risk-not-ready"],
      dueWindow: "BEFORE_DECISION",
      evidenceStrength: "UNCONFIRMED",
      sourceFreshness: "NOT_APPLICABLE",
    },
    {
      createdAt: "2026-07-31T00:00:00.000Z",
      state: "READY",
      inputSummary: { locationPrecision: "ADMIN_AREA_BROAD" },
    },
  );

  assert.equal(result.ruleId, "COLLECT_REQUIRED_DATA");
  assert.equal(result.evidenceRefs[0].observedAt, null);
  assert.equal(result.evidenceRefs[0].fetchedAt, null);
  assert.equal(result.evidenceRefs[0].state, "HOLD");
  assert.deepEqual(result.evidenceRefs[0].limitationCodes, [
    "ACTION_TRIGGER_EVIDENCE_UNRESOLVED",
  ]);
});

function forecastAnalysis({
  riskId,
  ruleId,
  metric,
  duration = { kind: "ANY_DAY" },
  from,
  to,
}) {
  return {
    createdAt: "2026-07-31T00:00:00.000Z",
    inputSummary: { locationPrecision: "ADMIN_AREA" },
    forecast: {
      result: {
        risks: [{ riskId, ruleId, dateRange: { from, to } }],
      },
      evidence: [{
        evidenceId: riskId,
        ruleId,
        module: "FORECAST",
        metric,
        sourceType: "SHORT_GRID",
        inclusion: "INCLUDED",
        evidenceStatus: "RISK_ONLY",
        spatialLevel: "FORECAST_GRID",
        issuedAt: "2026-07-31T02:00:00.000Z",
        deliveryState: "LIVE",
        freshness: "CURRENT",
        qualityFlags: [],
        calculation: { duration },
      }],
    },
    dataSources: [{
      sourceId: "kma-short-forecast",
      retrievedAt: "2026-07-31T02:05:00.000Z",
      deliveryState: "LIVE",
      adapterState: "SUCCESS",
      qualityFlags: [],
    }],
  };
}
