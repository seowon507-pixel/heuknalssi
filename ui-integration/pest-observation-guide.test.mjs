import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewedPestObservationFallback,
  reviewedPestObservationCrops,
  selectPestRecoveryAnalysis,
} from "./pest-observation-guide.mjs";

test("검수된 병해충 관찰 대체 가이드는 5개 작물에만 제공된다", () => {
  assert.deepEqual(
    [...reviewedPestObservationCrops].sort(),
    ["APPLE", "CUCUMBER", "LETTUCE", "PEAR", "POTATO"],
  );
  for (const crop of reviewedPestObservationCrops) {
    const result = buildReviewedPestObservationFallback(crop, { analysisId: "stale-analysis" });
    assert.equal(result.crop, crop);
    assert.equal(result.analysisId, "stale-analysis");
    assert.equal(result.observations.length, 3);
    assert.equal(result.diagnosisState, "NOT_PERFORMED");
    assert.equal(result.liveOccurrenceState, "NOT_CONNECTED");
    assert.equal(result.source.sourceId, "ncpms-reviewed-reference");
    assert.ok(result.observations.every((item) => item.part && item.guidance));
  }
  assert.equal(buildReviewedPestObservationFallback("WATERMELON"), null);
});

test("대체 가이드는 호출마다 수정 가능한 새 사본을 반환한다", () => {
  const first = buildReviewedPestObservationFallback("APPLE");
  first.observations[0].part = "변경됨";
  const second = buildReviewedPestObservationFallback("APPLE");
  assert.equal(second.observations[0].part, "잎과 새순");
});

test("다중 작물 재분석 뒤에도 원래 선택한 작물의 새 분석을 고른다", () => {
  const apple = { analysisId: "apple-new", inputSummary: { crop: "APPLE" } };
  const cucumber = { analysisId: "cucumber-new", inputSummary: { crop: "CUCUMBER" } };
  const analyses = new Map([
    ["APPLE", apple],
    ["CUCUMBER", cucumber],
  ]);
  assert.equal(selectPestRecoveryAnalysis(analyses, "cucumber"), cucumber);
  assert.equal(selectPestRecoveryAnalysis(analyses, "LETTUCE"), null);
  assert.equal(selectPestRecoveryAnalysis([], "APPLE"), null);
});
