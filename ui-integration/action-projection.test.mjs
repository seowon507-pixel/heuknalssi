import assert from "node:assert/strict";
import test from "node:test";

import { projectAnalysisAction } from "./action-projection.mjs";

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
  assert.equal(result.dueAt, "2026-07-31T23:00:00.000Z");
  assert.equal(result.recheckAt, "2026-08-03T23:00:00.000Z");
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
