import { calculateHarvestWeatherPace, domainAssert } from "../domain/index.js";

const DAY_MS = 86_400_000;

export function createHarvestWeatherService({
  cropCycleService,
  getAnalysis,
  getAnalysisContext,
  observationAdapter,
  climateAdapter,
  clock = Date.now,
} = {}) {
  domainAssert(
    typeof cropCycleService?.getCycle === "function",
    "HARVEST_WEATHER_PORT_INVALID",
    "cropCycleService.getCycle must be a function.",
  );
  domainAssert(
    typeof getAnalysis === "function" && typeof getAnalysisContext === "function",
    "HARVEST_WEATHER_PORT_INVALID",
    "analysis accessors must be functions.",
  );
  domainAssert(typeof clock === "function", "HARVEST_WEATHER_PORT_INVALID", "clock must be a function.");

  return Object.freeze({ getSeasonWeather });

  async function getSeasonWeather(input = {}) {
    const ownerSessionId = requiredIdentifier(input.ownerSessionId, "ownerSessionId");
    const farmId = requiredIdentifier(input.farmId, "farmId");
    const cropId = requiredIdentifier(input.cropId, "cropId").toUpperCase();
    const seasonId = requiredIdentifier(input.seasonId, "seasonId");
    const analysisId = requiredIdentifier(input.analysisId, "analysisId");
    const [cycle, analysis, privateContext] = await Promise.all([
      cropCycleService.getCycle({ ownerSessionId, farmId, cropId, seasonId }),
      getAnalysis({ ownerSessionId, analysisId }),
      getAnalysisContext({ ownerSessionId, analysisId }),
    ]);
    if (!cycle || !analysis) return null;
    domainAssert(
      analysis.inputSummary?.crop === cropId,
      "HARVEST_WEATHER_SCOPE_INVALID",
      "The analysis crop does not match the crop cycle.",
    );

    const fallbackStationId = analysis.observations?.result?.stationId ?? null;
    const observationStationId =
      privateContext?.observationStationId ?? fallbackStationId;
    const normalStationId = privateContext?.normalStationId ?? fallbackStationId;
    const lastCompletedDate = addDays(seoulDate(new Date(clock())), -1);
    if (cycle.status === "COMPLETED") {
      return unavailableProjection({
        cropId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
        baselineHarvestWindow: cycle.harvestWindow,
        reason: "CROP_CYCLE_COMPLETED",
        summary: "완료한 작기의 수확 일정은 더 이상 자동으로 변경하지 않습니다.",
      });
    }
    if (
      cycle.status === "PLANNING" ||
      cycle.anchorDate > lastCompletedDate
    ) {
      return unavailableProjection({
        cropId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
        baselineHarvestWindow: cycle.harvestWindow,
        reason: "NO_COMPLETED_SEASON_DAYS",
        summary: "재배 시작 후 완료된 관측일이 생기면 적산온도를 반영합니다.",
      });
    }
    if (!observationStationId || !normalStationId) {
      return unavailableProjection({
        cropId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
        baselineHarvestWindow: cycle.harvestWindow,
        reason: "WEATHER_STATION_MAPPING_UNAVAILABLE",
        summary: "재배기간 관측지점을 확인할 수 없어 기준 일정을 유지합니다.",
      });
    }

    const deadlineAt = input.deadlineAt ?? clock() + 10_000;
    const [observationEnvelope, climateEnvelope] = await Promise.all([
      callAdapter(observationAdapter, "getDailyRange", {
        stationId: observationStationId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
      }, input.signal, deadlineAt),
      callAdapter(climateAdapter, "getNormals", {
        stationId: normalStationId,
      }, input.signal, deadlineAt),
    ]);
    const observationReady = observationEnvelope?.adapterState === "SUCCESS";
    const climateReady = climateEnvelope?.adapterState === "SUCCESS";
    if (!observationReady || !climateReady) {
      return unavailableProjection({
        cropId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
        baselineHarvestWindow: cycle.harvestWindow,
        reason: !observationReady
          ? `ASOS_${observationEnvelope?.adapterState ?? "UNAVAILABLE"}`
          : `CLIMATE_NORMAL_${climateEnvelope?.adapterState ?? "UNAVAILABLE"}`,
        summary: "재배기간 관측과 평년값을 함께 확인하지 못해 기준 일정을 유지합니다.",
        sources: [observationEnvelope, climateEnvelope],
      });
    }

    return Object.freeze({
      ...calculateHarvestWeatherPace({
        cropId,
        from: cycle.anchorDate,
        to: lastCompletedDate,
        asOfDate: lastCompletedDate,
        baselineHarvestWindow: cycle.harvestWindow,
        baselineConfidence: cycle.confidence,
        readings: observationEnvelope.data?.readings,
        monthlyNormals: climateEnvelope.data?.observations,
      }),
      station: Object.freeze({
        observationStationId: String(observationStationId),
        observationStationName: observationEnvelope.data?.stationName ?? null,
        normalStationId: String(normalStationId),
      }),
      sources: Object.freeze([
        publicSource(observationEnvelope),
        publicSource(climateEnvelope),
      ]),
    });
  }
}

async function callAdapter(adapter, method, parameters, signal, deadlineAt) {
  if (typeof adapter?.[method] !== "function") return null;
  return adapter[method](parameters, { signal, deadlineAt });
}

function unavailableProjection({
  cropId,
  from,
  to,
  baselineHarvestWindow = null,
  reason,
  summary,
  sources = [],
}) {
  return Object.freeze({
    state: "HOLD",
    adjustmentApplied: false,
    adjustmentDays: 0,
    adjustmentMode: "NOT_APPLICABLE",
    baselineHarvestWindow: baselineHarvestWindow ?? null,
    adjustedHarvestWindow: baselineHarvestWindow ?? null,
    maximumAdjustmentDays: 0,
    rawAdjustmentDays: null,
    remainingDaysToMidpoint: null,
    confidence: "LOW",
    cropId,
    period: Object.freeze({ from, to, expectedDayCount: 0 }),
    coverage: 0,
    pairedDayCount: 0,
    observedGrowingDegreeDays: null,
    normalGrowingDegreeDays: null,
    paceRatio: null,
    precipitationAmount: null,
    precipitationDayCount: null,
    coldStressDayCount: null,
    heatStressDayCount: null,
    summary,
    limitations: Object.freeze([reason]),
    sources: Object.freeze(sources.map(publicSource)),
  });
}

function publicSource(envelope) {
  return Object.freeze({
    sourceId: envelope?.sourceId ?? null,
    sourceName: envelope?.sourceName ?? null,
    sourceUrl: envelope?.sourceUrl ?? null,
    adapterState: envelope?.adapterState ?? "UNAVAILABLE",
    retrievedAt: envelope?.retrievedAt ?? null,
    observedAt: envelope?.observedAt ?? null,
    validFrom: envelope?.validFrom ?? null,
    validTo: envelope?.validTo ?? null,
    qualityFlags: Object.freeze([...(envelope?.qualityFlags ?? [])]),
  });
}

function requiredIdentifier(value, field) {
  domainAssert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 180,
    "HARVEST_WEATHER_SCOPE_INVALID",
    `${field} must be a non-empty identifier.`,
  );
  return value;
}

function seoulDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(value, amount) {
  return new Date(
    new Date(`${value}T00:00:00Z`).getTime() + amount * DAY_MS,
  ).toISOString().slice(0, 10);
}
