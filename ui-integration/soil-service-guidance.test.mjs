import assert from "node:assert/strict";
import test from "node:test";

import { hasMissingSoilExamHistory } from "./soil-service-guidance.mjs";

function analysisWithSoilExam(adapterState) {
  return {
    dataSources: [
      {
        sourceId: "soil-exam-v2",
        adapterState,
      },
    ],
  };
}

test("무료 토양검정 연결은 실제 검정 이력이 없을 때만 표시한다", () => {
  assert.equal(
    hasMissingSoilExamHistory(analysisWithSoilExam("NO_DATA")),
    true,
  );
  for (const state of [
    "SUCCESS",
    "TIMEOUT",
    "AUTH_ERROR",
    "SCHEMA_CHANGED",
    "UNSUPPORTED",
  ]) {
    assert.equal(
      hasMissingSoilExamHistory(analysisWithSoilExam(state)),
      false,
      `${state}는 토양검정 이력 없음으로 안내하면 안 됩니다.`,
    );
  }
});

test("토양검정 V2 출처가 없으면 무료 검사 버튼을 표시하지 않는다", () => {
  assert.equal(hasMissingSoilExamHistory({ dataSources: [] }), false);
  assert.equal(hasMissingSoilExamHistory(null), false);
});
