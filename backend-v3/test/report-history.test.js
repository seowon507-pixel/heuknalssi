import assert from "node:assert/strict";
import test from "node:test";

import { createReportHistoryService } from "../src/application/index.js";
import {
  TtlMemoryStore,
  createReportHistoryRepository,
} from "../src/infrastructure/index.js";

function analysis(id = "analysis-1", crop = "APPLE") {
  return {
    analysisId: id,
    createdAt: "2026-08-03T00:00:00.000Z",
    inputSummary: { crop, regionLabel: "인천 남동구" },
    state: "COMPLETE",
    conditionState: "CHECK_FIRST",
    riskState: "READY",
    growthScore: { state: "READY", score: 82, label: "보통" },
    decision: { headline: "고온 전에 과원 상태 확인" },
    primaryAction: { actionId: "CHECK_HEAT", title: "관수 상태 확인" },
    actions: [{ actionId: "CHECK_HEAT", title: "관수 상태 확인" }],
    report: {
      state: "FALLBACK",
      value: {
        summary: { text: "고온 전에 수분 상태를 확인하세요.", factIds: [] },
        strengths: [], risks: [], nextActions: [], limitations: [],
      },
    },
    dataSources: [{ sourceId: "kma-short", sourceName: "기상청 단기예보" }],
    limitations: [],
    ruleVersion: "apple-v1",
  };
}

function serviceWithAnalyses(analyses) {
  const repository = createReportHistoryRepository({
    store: new TtlMemoryStore({ capacityPolicy: "reject" }),
  });
  return createReportHistoryService({
    repository,
    async getAnalysis({ ownerSessionId, analysisId }) {
      if (ownerSessionId !== "owner-a") return null;
      return analyses.get(analysisId) ?? null;
    },
  });
}

test("completed report is persisted as an owned farm snapshot", async () => {
  const service = serviceWithAnalyses(new Map([["analysis-1", analysis()]]));
  const saved = await service.saveReport({
    ownerSessionId: "owner-a",
    farmId: "farm-1",
    analysisId: "analysis-1",
    cropId: "crop-apple",
    seasonId: "season-2026-apple",
  });
  assert.equal(saved.reportId, "analysis-1");
  assert.equal(saved.score, 82);

  const listed = await service.listReports({
    ownerSessionId: "owner-a",
    farmId: "farm-1",
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].headline, "고온 전에 과원 상태 확인");

  const exported = await service.getReport({
    ownerSessionId: "owner-a",
    farmId: "farm-1",
    reportId: "analysis-1",
  });
  assert.equal(exported.report.value.summary.text, "고온 전에 수분 상태를 확인하세요.");
  assert.equal(exported.cropCode, "APPLE");
});

test("report history never crosses owner or crop scope", async () => {
  const service = serviceWithAnalyses(new Map([["analysis-1", analysis()]]));
  assert.equal(
    await service.saveReport({
      ownerSessionId: "owner-b",
      farmId: "farm-1",
      analysisId: "analysis-1",
      cropId: "crop-apple",
      seasonId: "season-1",
    }),
    null,
  );
  await assert.rejects(
    () => service.saveReport({
      ownerSessionId: "owner-a",
      farmId: "farm-1",
      analysisId: "analysis-1",
      cropId: "crop-pear",
      seasonId: "season-1",
    }),
    (error) => error?.code === "REPORT_SCOPE_MISMATCH",
  );
});

test("unfinished report cannot be persisted", async () => {
  const pending = analysis();
  pending.report = { state: "PENDING", value: null };
  const service = serviceWithAnalyses(new Map([["analysis-1", pending]]));
  await assert.rejects(
    () => service.saveReport({
      ownerSessionId: "owner-a",
      farmId: "farm-1",
      analysisId: "analysis-1",
      cropId: "crop-apple",
      seasonId: "season-1",
    }),
    (error) => error?.code === "REPORT_NOT_READY",
  );
});
