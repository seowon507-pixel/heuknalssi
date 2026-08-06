const COMPLETED_REPORT_STATES = new Set(["READY", "FALLBACK"]);

function requireIdentifier(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 180) {
    const error = new Error(`${field} must be a non-empty identifier`);
    error.code = "INVALID_INPUT";
    throw error;
  }
  return value.trim();
}

function assertRepository(repository) {
  for (const method of ["upsertReport", "listReports", "getReport"]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`report repository.${method} is required`);
    }
  }
}

function reportProjection(analysis, { farmId, cropId, seasonId }) {
  const reportState = analysis?.report?.state;
  if (!COMPLETED_REPORT_STATES.has(reportState) || !analysis.report?.value) {
    const error = new Error("analysis report is not ready");
    error.code = "REPORT_NOT_READY";
    throw error;
  }
  const analysisCrop = String(analysis?.inputSummary?.crop ?? "").toLowerCase();
  const scopedCrop = String(cropId).toLowerCase().replace(/^crop-/u, "");
  if (analysisCrop !== scopedCrop) {
    const error = new Error("crop does not match the analysis");
    error.code = "REPORT_SCOPE_MISMATCH";
    throw error;
  }
  return Object.freeze({
    schemaVersion: 1,
    reportId: requireIdentifier(analysis.analysisId, "analysisId"),
    analysisId: analysis.analysisId,
    farmId,
    cropId,
    cropCode: analysis.inputSummary.crop,
    seasonId,
    createdAt: analysis.createdAt,
    state: analysis.state,
    conditionState: analysis.conditionState,
    riskState: analysis.riskState,
    inputSummary: structuredClone(analysis.inputSummary),
    growthScore: structuredClone(analysis.growthScore),
    decision: structuredClone(analysis.decision),
    primaryAction: structuredClone(analysis.primaryAction),
    actions: structuredClone(analysis.actions ?? []),
    report: { state: reportState, value: structuredClone(analysis.report.value) },
    dataSources: structuredClone(analysis.dataSources ?? []),
    limitations: structuredClone(analysis.limitations ?? []),
    ruleVersion: analysis.ruleVersion ?? null,
  });
}

function reportSummary(report) {
  return {
    reportId: report.reportId,
    analysisId: report.analysisId,
    farmId: report.farmId,
    cropId: report.cropId,
    seasonId: report.seasonId,
    createdAt: report.createdAt,
    state: report.state,
    score: Number.isFinite(report.growthScore?.score)
      ? report.growthScore.score
      : null,
    scoreLabel: report.growthScore?.label ?? null,
    headline:
      report.decision?.headline ??
      report.report?.value?.summary?.text ??
      "농장 분석 기록",
  };
}

export function createReportHistoryService({ repository, getAnalysis } = {}) {
  assertRepository(repository);
  if (typeof getAnalysis !== "function") {
    throw new TypeError("getAnalysis must be a function");
  }
  return Object.freeze({
    async saveReport({ ownerSessionId, farmId, analysisId, cropId, seasonId }) {
      const scope = {
        ownerSessionId: requireIdentifier(ownerSessionId, "ownerSessionId"),
        farmId: requireIdentifier(farmId, "farmId"),
        cropId: requireIdentifier(cropId, "cropId"),
        seasonId: requireIdentifier(seasonId, "seasonId"),
      };
      const analysis = await getAnalysis({
        ownerSessionId: scope.ownerSessionId,
        analysisId: requireIdentifier(analysisId, "analysisId"),
      });
      if (!analysis) return null;
      const saved = await repository.upsertReport({
        ownerSessionId: scope.ownerSessionId,
        farmId: scope.farmId,
        report: reportProjection(analysis, scope),
      });
      return reportSummary(saved);
    },

    async listReports({ ownerSessionId, farmId, cropId = null }) {
      const reports = await repository.listReports({
        ownerSessionId: requireIdentifier(ownerSessionId, "ownerSessionId"),
        farmId: requireIdentifier(farmId, "farmId"),
        cropId: cropId === null ? null : requireIdentifier(cropId, "cropId"),
      });
      return reports.map(reportSummary);
    },

    async getReport({ ownerSessionId, farmId, reportId }) {
      return repository.getReport({
        ownerSessionId: requireIdentifier(ownerSessionId, "ownerSessionId"),
        farmId: requireIdentifier(farmId, "farmId"),
        reportId: requireIdentifier(reportId, "reportId"),
      });
    },
  });
}
