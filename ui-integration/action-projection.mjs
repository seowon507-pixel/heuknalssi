const DAY_MS = 86_400_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

export function projectAnalysisAction(action, analysis) {
  if (!action || typeof action !== "object") {
    throw new TypeError("analysis action is required");
  }
  if (!analysis || typeof analysis !== "object") {
    throw new TypeError("analysis is required");
  }

  const createdAt = validDate(analysis.createdAt) ?? new Date(0);
  const triggerIds = normalizeIds(action.triggerIds, action.actionId);
  const risks = forecastRisks(analysis)
    .filter((risk) => triggerIds.includes(risk.riskId))
    .sort(compareRisks);
  const evidence = analysisEvidence(analysis)
    .filter((item) => triggerIds.includes(item.evidenceId));
  const schedule = risks.length > 0
    ? riskSchedule(risks, createdAt)
    : dueWindowSchedule(action.dueWindow, createdAt);

  return Object.freeze({
    ruleId: ruleIdentifier(risks[0]?.ruleId ?? evidence[0]?.ruleId ?? action.actionId),
    horizon: sameSeoulDate(schedule.dueAt, createdAt) ? "TODAY" : "UPCOMING",
    dueAt: schedule.dueAt.toISOString(),
    recheckAt: schedule.recheckAt.toISOString(),
    evidenceRefs: evidence.length > 0
      ? evidence.slice(0, 4).map((item) => evidenceRef(item, analysis))
      : triggerIds.slice(0, 4).map((sourceId) => unresolvedEvidenceRef(
          sourceId,
          action,
          analysis,
        )),
  });
}

function forecastRisks(analysis) {
  const risks = analysis?.forecast?.result?.risks;
  return Array.isArray(risks)
    ? risks.filter(
        (risk) =>
          risk &&
          typeof risk.riskId === "string" &&
          typeof risk.ruleId === "string" &&
          typeof risk.dateRange?.from === "string" &&
          typeof risk.dateRange?.to === "string",
      )
    : [];
}

function analysisEvidence(analysis) {
  return ["climate", "soil", "observations", "forecast"].flatMap((module) => {
    const values = analysis?.[module]?.evidence;
    return Array.isArray(values)
      ? values.filter((item) => item && typeof item.evidenceId === "string")
      : [];
  });
}

function normalizeIds(values, fallback) {
  const ids = Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.trim() !== "")
    : [];
  if (ids.length > 0) return [...new Set(ids.map((value) => value.trim()))];
  const normalized = String(fallback ?? "analysis-action").trim();
  return [normalized || "analysis-action"];
}

function compareRisks(left, right) {
  return (
    left.dateRange.from.localeCompare(right.dateRange.from) ||
    left.dateRange.to.localeCompare(right.dateRange.to) ||
    left.riskId.localeCompare(right.riskId)
  );
}

function riskSchedule(risks, createdAt) {
  const starts = risks
    .map((risk) => seoulMorning(risk.dateRange.from))
    .filter(Boolean);
  const ends = risks
    .map((risk) => seoulMorning(risk.dateRange.to))
    .filter(Boolean);
  if (starts.length === 0 || ends.length === 0) {
    return dueWindowSchedule("NOW", createdAt);
  }
  const firstStart = new Date(Math.min(...starts.map(Number)));
  const lastEnd = new Date(Math.max(...ends.map(Number)));
  const dueAt = firstStart < createdAt ? new Date(createdAt) : firstStart;
  const nextMorning = new Date(lastEnd.getTime() + DAY_MS);
  const recheckAt = nextMorning < dueAt ? new Date(dueAt) : nextMorning;
  return { dueAt, recheckAt };
}

function dueWindowSchedule(dueWindow, createdAt) {
  const offsetDays = dueWindow === "1_TO_3_DAYS"
    ? 1
    : dueWindow === "4_TO_10_DAYS"
      ? 4
      : 0;
  const dueAt = new Date(createdAt.getTime() + offsetDays * DAY_MS);
  const recheckDelay = offsetDays === 0 ? FOUR_HOURS_MS : DAY_MS;
  return {
    dueAt,
    recheckAt: new Date(dueAt.getTime() + recheckDelay),
  };
}

function evidenceRef(item, analysis) {
  const source = sourceForEvidence(item, analysis?.dataSources);
  const limitationCodes = [
    ...(Array.isArray(item.qualityFlags) ? item.qualityFlags : []),
    ...(Array.isArray(source?.qualityFlags) ? source.qualityFlags : []),
    ...(item.exclusionReason ? [item.exclusionReason] : []),
  ];
  return {
    sourceKind: sourceKind(item),
    sourceId: ruleIdentifier(item.evidenceId),
    observedAt: firstIso(
      item.observedAt,
      item.issuedAt,
      source?.observedAt,
      source?.issuedAt,
    ),
    fetchedAt: firstIso(source?.retrievedAt),
    spatialLevel:
      item.spatialLevel ??
      source?.spatialLevel ??
      analysis?.inputSummary?.locationPrecision ??
      "ADMIN_AREA",
    state: evidenceState(item, source),
    limitationCodes: [...new Set(
      limitationCodes.filter((value) => typeof value === "string" && value.trim()),
    )].slice(0, 8),
  };
}

function unresolvedEvidenceRef(sourceId, action, analysis) {
  return {
    sourceKind: "DERIVED_RULE",
    sourceId: ruleIdentifier(sourceId),
    observedAt: null,
    fetchedAt: null,
    spatialLevel: analysis?.inputSummary?.locationPrecision ?? "ADMIN_AREA",
    state: unresolvedState(action),
    limitationCodes: ["ACTION_TRIGGER_EVIDENCE_UNRESOLVED"],
  };
}

function sourceForEvidence(evidence, sources) {
  if (!Array.isArray(sources)) return null;
  const inferredId = evidence.sourceType === "SHORT_GRID"
    ? "kma-short-forecast"
    : evidence.sourceType === "MID_REGIONAL"
      ? "kma-mid-forecast"
      : null;
  return sources.find(
    (source) =>
      (inferredId && source?.sourceId === inferredId) ||
      (evidence.sourceName && source?.sourceName === evidence.sourceName),
  ) ?? null;
}

function sourceKind(evidence) {
  return evidence.module === "USER" ? "USER" : "PUBLIC_API";
}

function evidenceState(evidence, source) {
  const delivery = source?.deliveryState ?? evidence.deliveryState;
  const adapter = source?.adapterState;
  const freshness = evidence.freshness;
  const flags = [
    ...(Array.isArray(evidence.qualityFlags) ? evidence.qualityFlags : []),
    ...(Array.isArray(source?.qualityFlags) ? source.qualityFlags : []),
  ];
  if (delivery === "UNAVAILABLE" || (adapter && adapter !== "SUCCESS")) {
    return "UNAVAILABLE";
  }
  if (evidence.inclusion === "EXCLUDED" || evidence.evidenceStatus === "UNCONFIRMED") {
    return "HOLD";
  }
  if (
    ["SAMPLE", "CACHE"].includes(delivery) ||
    ["SAMPLE", "STALE"].includes(freshness) ||
    flags.some((flag) => ["STALE", "PARTIAL_PROVIDER_FAILURE"].includes(flag))
  ) {
    return "PARTIAL";
  }
  return delivery === "LIVE" && freshness === "CURRENT" ? "READY" : "PARTIAL";
}

function unresolvedState(action) {
  if (action?.evidenceStrength === "UNCONFIRMED") return "HOLD";
  if (["SAMPLE", "STALE"].includes(action?.sourceFreshness)) return "PARTIAL";
  return action?.sourceFreshness === "CURRENT" ? "READY" : "HOLD";
}

function seoulMorning(date) {
  const parsed = validDate(`${date}T08:00:00+09:00`);
  return parsed;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstIso(...values) {
  for (const value of values) {
    const date = value ? validDate(value) : null;
    if (date) return date.toISOString();
  }
  return null;
}

function sameSeoulDate(left, right) {
  return seoulDateKey(left) === seoulDateKey(right);
}

function seoulDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function ruleIdentifier(value) {
  const text = String(value ?? "analysis-action").trim() || "analysis-action";
  return text.slice(0, 160);
}
