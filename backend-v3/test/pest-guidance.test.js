import assert from "node:assert/strict";
import test from "node:test";

import {
  createPestGuidanceService,
  pestGuidanceDefaults,
} from "../src/application/pest-guidance.js";

function analysis(crop, risks = []) {
  return {
    analysisId: `analysis-${crop.toLowerCase()}`,
    inputSummary: { crop },
    forecast: { result: { risks } },
  };
}

test("검수된 병해충 관찰 가이드는 대회 5작물을 모두 포함한다", () => {
  assert.deepEqual(
    [...pestGuidanceDefaults.supportedCrops].sort(),
    ["APPLE", "CUCUMBER", "LETTUCE", "PEAR", "POTATO"],
  );
  assert.equal(pestGuidanceDefaults.source.sourceState, "REVIEWED_REFERENCE");
});

test("현재 기상 신호와 현장 관찰을 결합하되 병해충 진단으로 표시하지 않는다", async () => {
  const stored = analysis("APPLE", [
    {
      riskId: "apple-heat:2026-08-04",
      sourceFreshness: "CURRENT",
      dateRange: { from: "2026-08-04", to: "2026-08-04" },
      severity: "CAUTION",
      guidance: {
        headline: "고온 전 과실 상태 확인",
        reason: "최고기온 기준을 넘을 수 있습니다.",
        nextAction: "과실 노출 상태를 확인합니다.",
      },
      trigger: { metric: "maxTemperature", unit: "C" },
    },
    {
      riskId: "stale-risk",
      sourceFreshness: "STALE",
      dateRange: { from: "2026-08-04", to: "2026-08-04" },
      severity: "WARNING",
    },
  ]);
  const service = createPestGuidanceService({
    async getAnalysis({ ownerSessionId, analysisId }) {
      return ownerSessionId === "owner-1" && analysisId === stored.analysisId
        ? stored
        : null;
    },
  });

  const result = await service.getGuidance({
    ownerSessionId: "owner-1",
    analysisId: stored.analysisId,
  });

  assert.equal(result.state, "WEATHER_LINKED_CHECK");
  assert.equal(result.diagnosisState, "NOT_PERFORMED");
  assert.equal(result.liveOccurrenceState, "NOT_CONNECTED");
  assert.equal(result.weatherSignals.length, 1);
  assert.equal(result.weatherSignals[0].riskId, "apple-heat:2026-08-04");
  assert.equal(result.observations.length, 3);
  assert.ok(result.limitations.includes("WEATHER_SIGNAL_IS_NOT_PEST_DIAGNOSIS"));
});

test("다른 세션의 분석과 지원하지 않는 작물은 가이드로 노출하지 않는다", async () => {
  const unsupported = analysis("WATERMELON");
  const service = createPestGuidanceService({
    async getAnalysis({ ownerSessionId }) {
      return ownerSessionId === "owner-1" ? unsupported : null;
    },
  });

  assert.equal(
    await service.getGuidance({
      ownerSessionId: "owner-2",
      analysisId: unsupported.analysisId,
    }),
    null,
  );
  await assert.rejects(
    service.getGuidance({
      ownerSessionId: "owner-1",
      analysisId: unsupported.analysisId,
    }),
    (error) => error.code === "UNSUPPORTED_CROP",
  );
});
