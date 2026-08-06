import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaHistoricalShortForecastAdapter,
} from "../src/adapters/index.js";
import {
  calculateIssuedForecastMetrics,
  replayAsosRiskRules,
  toKmaGrid,
} from "../src/application/index.js";
import { calculateHarvestWeatherPace } from "../src/domain/index.js";
import CLIMATE_NORMALS from "../runtime/climate-normal-1991-2020.json" with { type: "json" };
import { REVIEWED_CROP_RULES } from "../runtime/reviewed-crop-rules.js";
import { REVIEWED_LOCATION_MAPPINGS } from "../runtime/reviewed-location-mappings.js";

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CROPS = Object.freeze(["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"]);
const WINDOW_DAYS = 90;
const OUTPUT_DIRECTORY = path.resolve(
  process.cwd(),
  "../product_upgrade_validation/backtest_1y",
);
const ASOS_SOURCE = "https://www.data.go.kr/data/15059093/openapi.do";
const NORMAL_SOURCE =
  "https://data.kma.go.kr/climate/average30Years/selectAverage30YearsMonthList.do";

const args = parseArgs(process.argv.slice(2));
const to = args.to ?? lastCompletedKstDate(new Date());
const from = args.from ?? addDays(to, -364);
const expectedDayCount = daysBetween(from, to) + 1;
if (!isDate(from) || !isDate(to) || from > to || expectedDayCount !== 365) {
  throw new TypeError("One-year backtest requires an inclusive 365-day ISO date range.");
}

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim() || null;
const apiHubKey = process.env.KMA_API_HUB_AUTH_KEY?.trim() || null;
const observationAdapter = createKmaAsosObservationAdapter({
  enabled: Boolean(serviceKey),
  apiKey: serviceKey,
  fetchImpl: globalThis.fetch,
  timeoutMs: 20_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
});
const historicalForecastAdapter = createKmaHistoricalShortForecastAdapter({
  enabled: Boolean(apiHubKey),
  apiKey: apiHubKey,
  fetchImpl: globalThis.fetch,
  timeoutMs: 20_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
});

const locations = Object.entries(REVIEWED_LOCATION_MAPPINGS).map(
  ([areaCode, mapping]) => ({
    areaCode,
    displayName: mapping.displayName,
    stationId: mapping.observationStation.id,
    stationName: mapping.observationStation.name,
    latitude: mapping.observationStation.latitude,
    longitude: mapping.observationStation.longitude,
  }),
);
const stationRuns = [];
for (let index = 0; index < locations.length; index += 2) {
  const batch = locations.slice(index, index + 2);
  const results = await Promise.all(
    batch.map(async (location) => ({
      location,
      envelope: await observationAdapter.getDailyRange(
        { stationId: location.stationId, from, to },
        { deadlineAt: Date.now() + 45_000 },
      ),
    })),
  );
  stationRuns.push(...results);
}

const openFieldRules = REVIEWED_CROP_RULES.filter(
  (rule) =>
    rule.module === "FORECAST" &&
    rule.use === "FORECAST_RISK" &&
    rule.cultivationMode === "OPEN_FIELD",
);
const successfulStations = stationRuns.flatMap(({ location, envelope }) =>
  envelope.adapterState === "SUCCESS"
    ? [{ location, envelope, readings: envelope.data?.readings ?? [] }]
    : [],
);
const replayRuns = successfulStations.map(({ location, readings }) => ({
  location,
  readings,
  replay: replayAsosRiskRules({ rules: openFieldRules, observations: readings }),
}));

const dataQuality = buildDataQuality({
  stationRuns,
  expectedDayCount,
  locationCount: locations.length,
});
const riskReplay = buildRiskReplay({
  replayRuns,
  rules: openFieldRules,
  from,
  to,
});
const harvestPace = buildHarvestPace({
  successfulStations,
  from,
  to,
});
const dailyCropRiskRows = buildDailyCropRiskRows({
  replayRuns,
  rules: openFieldRules,
});
const dailySummaryRows = buildDailySummaryRows(dailyCropRiskRows);
const historicalForecastBacktest = await buildHistoricalForecastBacktest({
  adapter: historicalForecastAdapter,
  locations,
  successfulStations,
  from,
  to,
  limitDays: args.forecastLimit,
});

const mechanicalReady =
  dataQuality.coverageRatio >= 0.98 &&
  dataQuality.successfulStationCount === locations.length &&
  riskReplay.state === "READY" &&
  ["READY", "PACE_READY_SCHEDULE_BLOCKED"].includes(harvestPace.state);
const result = {
  auditKind: "ONE_YEAR_WEATHER_RULE_AND_HARVEST_PACE_BACKTEST",
  generatedAt: new Date().toISOString(),
  state:
    mechanicalReady && historicalForecastBacktest.state === "TEMPERATURE_READY"
      ? "FORECAST_TEMPERATURE_BACKTEST_READY_OUTCOME_GROUND_TRUTH_BLOCKED"
      : mechanicalReady
        ? "MECHANICAL_BACKTEST_READY_FORECAST_ACCURACY_BLOCKED"
        : "CHANGES_REQUESTED",
  scope: {
    from,
    to,
    timezone: "Asia/Seoul",
    inclusiveDayCount: expectedDayCount,
    reviewedLocationCount: locations.length,
    cropCount: CROPS.length,
    crops: CROPS,
    observationGrain: "ASOS station-day",
    harvestSensitivityWindowDays: WINDOW_DAYS,
  },
  sources: [
    {
      id: "kma-asos-daily",
      label: "기상청 ASOS 일자료 조회서비스",
      href: ASOS_SOURCE,
    },
    {
      id: "kma-climate-normal-1991-2020",
      label: "기상청 기후평년 1991~2020",
      href: NORMAL_SOURCE,
    },
    {
      id: "reviewed-crop-rules",
      label: "프로젝트 검수 작물 위험 규칙",
      path: "backend-v3/runtime/reviewed-crop-rules.js",
    },
  ],
  providerStates: {
    historicalAsos: summarizeProviderStates(stationRuns),
    historicalIssuedForecast: historicalForecastBacktest.providerState,
  },
  dataQuality,
  riskReplay,
  harvestPace,
  forecastAccuracy: historicalForecastBacktest,
  validationBoundaries: {
    forecastErrorMetrics:
      historicalForecastBacktest.state === "TEMPERATURE_READY"
        ? "ONE_AND_THREE_DAY_TEMPERATURE_READY"
        : `PARTIAL_${historicalForecastBacktest.state}`,
    cropDamagePrecisionRecall: "BLOCKED_NO_HISTORICAL_DAMAGE_LABELS",
    harvestDateError: "BLOCKED_NO_ACTUAL_HARVEST_DATES",
    historicalSoilContribution:
      "EXCLUDED_NO_AS_OF_DATE_FIELD_SOIL_SNAPSHOT",
    interpretation: [
      "관측 재생은 임계값 발동과 결측 방어를 검증하지만 미래 예측 정확도를 증명하지 않는다.",
      "90일 적산온도 재생은 열량 추이 계산만 검증한다. 실제 작기와 기준 수확 범위가 없어 일정 보정은 실행하지 않았다.",
      "현재 토양값을 과거 시점에 소급 적용하지 않았다.",
    ],
  },
  guarantees: {
    missingValuesImputed: false,
    currentForecastSubstitutedForHistoricalIssue: false,
    currentSoilSubstitutedForHistoricalSoil: false,
    duplicateCropRiskDaysDeduplicated: true,
    credentialsDisclosed: false,
  },
};

assert.equal(result.scope.inclusiveDayCount, 365);
assert.ok(result.dataQuality.coverageRatio >= 0 && result.dataQuality.coverageRatio <= 1);
assert.equal(
  result.dataQuality.expectedStationDayCount,
  expectedDayCount * locations.length,
);
assert.equal(
  result.riskReplay.byCrop.length,
  CROPS.length,
);
assert.ok(
  result.harvestPace.evaluationCount <=
    locations.length * CROPS.length * result.harvestPace.windowEndDates.length,
);
assert.equal(
  dailyCropRiskRows.length,
  expectedDayCount * locations.length * CROPS.length,
);
assert.equal(dailySummaryRows.length, expectedDayCount);
for (const cropSummary of result.riskReplay.byCrop) {
  assert.equal(
    dailyCropRiskRows.filter(
      (row) => row.crop_id === cropSummary.crop && row.general_risk_triggered,
    ).length,
    cropSummary.triggeredStationDayCount,
  );
}
assert.equal(result.harvestPace.evaluations.length, result.harvestPace.evaluationCount);

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const outputPath = path.join(
  OUTPUT_DIRECTORY,
  `one-year-backtest-${from}-${to}.json`,
);
const dailyDetailCsvPath = path.join(
  OUTPUT_DIRECTORY,
  `daily-crop-risk-detail-${from}-${to}.csv`,
);
const dailySummaryCsvPath = path.join(
  OUTPUT_DIRECTORY,
  `daily-backtest-summary-${from}-${to}.csv`,
);
const harvestPaceCsvPath = path.join(
  OUTPUT_DIRECTORY,
  `harvest-pace-windows-${from}-${to}.csv`,
);
result.artifacts = {
  json: repositoryRelativePath(outputPath),
  dailyCropRiskDetailCsv: repositoryRelativePath(dailyDetailCsvPath),
  dailyBacktestSummaryCsv: repositoryRelativePath(dailySummaryCsvPath),
  harvestPaceWindowsCsv: repositoryRelativePath(harvestPaceCsvPath),
  historicalForecastExtractJson:
    historicalForecastBacktest.artifacts.extractJson,
  historicalForecastAccuracyCsv:
    historicalForecastBacktest.artifacts.accuracyCsv,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(dailyDetailCsvPath, toCsv(dailyCropRiskRows), "utf8");
await writeFile(dailySummaryCsvPath, toCsv(dailySummaryRows), "utf8");
await writeFile(harvestPaceCsvPath, toCsv(harvestPace.evaluations), "utf8");
process.stdout.write(`${JSON.stringify({ ...result, outputPath: path.relative(process.cwd(), outputPath) }, null, 2)}\n`);
if (!mechanicalReady) process.exitCode = 2;

function buildDataQuality({ stationRuns: runs, expectedDayCount: days, locationCount }) {
  const expectedStationDayCount = days * locationCount;
  let observedStationDayCount = 0;
  let completeTemperatureDayCount = 0;
  let precipitationDayCount = 0;
  const missingDates = [];
  const incompleteTemperatureDates = [];
  const byStation = runs.map(({ location, envelope }) => {
    const readings = envelope.data?.readings ?? [];
    const missing = envelope.data?.missingDates ?? [];
    observedStationDayCount += readings.length;
    completeTemperatureDayCount += readings.filter(
      (row) =>
        Number.isFinite(row.meanTemperature) &&
        Number.isFinite(row.minTemperature) &&
        Number.isFinite(row.maxTemperature),
    ).length;
    incompleteTemperatureDates.push(
      ...readings.flatMap((row) => {
        const missingMetrics = [
          ["meanTemperature", row.meanTemperature],
          ["minTemperature", row.minTemperature],
          ["maxTemperature", row.maxTemperature],
        ]
          .filter(([, value]) => !Number.isFinite(value))
          .map(([metric]) => metric);
        return missingMetrics.length > 0
          ? [{
              stationId: location.stationId,
              stationName: location.stationName,
              date: row.date,
              missingMetrics,
            }]
          : [];
      }),
    );
    precipitationDayCount += readings.filter((row) =>
      Number.isFinite(row.precipitationAmount),
    ).length;
    missingDates.push(
      ...missing.map((date) => ({ stationId: location.stationId, date })),
    );
    return {
      areaCode: location.areaCode,
      displayName: location.displayName,
      stationId: location.stationId,
      stationName: location.stationName,
      providerState: envelope.adapterState,
      expectedDayCount: days,
      observedDayCount: readings.length,
      coverageRatio: ratio(readings.length, days),
      missingDayCount: missing.length,
      qualityFlags: envelope.qualityFlags ?? [],
    };
  });
  return {
    state:
      observedStationDayCount === expectedStationDayCount &&
      completeTemperatureDayCount === expectedStationDayCount
        ? "READY"
        : observedStationDayCount / expectedStationDayCount >= 0.98 &&
            completeTemperatureDayCount / expectedStationDayCount >= 0.98
          ? "READY_WITH_MINOR_GAPS"
        : observedStationDayCount > 0
          ? "PARTIAL"
          : "HOLD",
    expectedStationDayCount,
    observedStationDayCount,
    coverageRatio: ratio(observedStationDayCount, expectedStationDayCount),
    completeTemperatureDayCount,
    completeTemperatureRatio: ratio(
      completeTemperatureDayCount,
      expectedStationDayCount,
    ),
    precipitationDayCount,
    precipitationCoverageRatio: ratio(
      precipitationDayCount,
      expectedStationDayCount,
    ),
    missingDayCount: missingDates.length,
    duplicateStationDateCount: 0,
    successfulStationCount: byStation.filter(
      ({ providerState }) => providerState === "SUCCESS",
    ).length,
    byStation,
    missingDates,
    incompleteTemperatureDates,
  };
}

function buildRiskReplay({ replayRuns: runs, rules, from: rangeFrom, to: rangeTo }) {
  const byRule = new Map(
    rules.map((rule) => [
      rule.ruleId,
      {
        ruleId: rule.ruleId,
        crop: rule.crop,
        stage: rule.stage,
        metric: rule.metric,
        operator: rule.comparison.operator,
        threshold: rule.comparison.threshold,
        evaluatedStationDayCount: 0,
        triggeredStationDayCount: 0,
        missingStationDayCount: 0,
      },
    ]),
  );
  const cropGeneralTriggerKeys = new Map(CROPS.map((crop) => [crop, new Set()]));
  const cropStageTriggerKeys = new Map(CROPS.map((crop) => [crop, new Set()]));
  const cropEvaluatedKeys = new Map(CROPS.map((crop) => [crop, new Set()]));
  const monthly = new Map();

  for (const { location, readings, replay } of runs) {
    for (const crop of CROPS) {
      const requiredMetrics = new Set(
        rules.filter((rule) => rule.crop === crop).map((rule) => rule.metric),
      );
      for (const reading of readings) {
        if ([...requiredMetrics].every((metric) => Number.isFinite(reading[metric]))) {
          cropEvaluatedKeys.get(crop).add(`${location.stationId}|${reading.date}`);
        }
      }
    }
    for (const ruleResult of replay.results) {
      const aggregate = byRule.get(ruleResult.ruleId);
      aggregate.evaluatedStationDayCount += ruleResult.evaluatedDayCount;
      aggregate.missingStationDayCount += ruleResult.missingDayCount;
      aggregate.triggeredStationDayCount += ruleResult.triggerDates.length;
      for (const date of ruleResult.triggerDates) {
        const target = aggregate.stage === "ANY"
          ? cropGeneralTriggerKeys
          : cropStageTriggerKeys;
        target.get(ruleResult.crop).add(`${location.stationId}|${date}`);
      }
    }
  }

  for (const crop of CROPS) {
    const evaluatedKeys = cropEvaluatedKeys.get(crop);
    const triggerKeys = cropGeneralTriggerKeys.get(crop);
    for (const key of evaluatedKeys) {
      const [, date] = key.split("|");
      const month = date.slice(0, 7);
      const monthlyKey = `${month}|${crop}`;
      const row = monthly.get(monthlyKey) ?? {
        month,
        crop,
        evaluatedStationDayCount: 0,
        triggeredStationDayCount: 0,
      };
      row.evaluatedStationDayCount += 1;
      if (triggerKeys.has(key)) row.triggeredStationDayCount += 1;
      monthly.set(monthlyKey, row);
    }
  }

  const byCrop = CROPS.map((crop) => {
    const evaluatedKeys = cropEvaluatedKeys.get(crop);
    const triggerKeys = cropGeneralTriggerKeys.get(crop);
    const stageTriggerKeys = cropStageTriggerKeys.get(crop);
    return {
      crop,
      evaluatedStationDayCount: evaluatedKeys.size,
      triggeredStationDayCount: triggerKeys.size,
      triggerRate: ratio(triggerKeys.size, evaluatedKeys.size),
      longestTriggerStreakDays: longestCropStreak(triggerKeys),
      stageScopedPotentialStationDayCount: stageTriggerKeys.size,
      stageScopedPotentialRate: ratio(stageTriggerKeys.size, evaluatedKeys.size),
    };
  });
  const monthlyCropTriggerRate = [...monthly.values()]
    .map((row) => ({
      ...row,
      triggerRate: ratio(
        row.triggeredStationDayCount,
        row.evaluatedStationDayCount,
      ),
    }))
    .sort((left, right) =>
      `${left.month}|${left.crop}`.localeCompare(`${right.month}|${right.crop}`),
    );
  const ruleRows = [...byRule.values()].map((row) => ({
    ...row,
    triggerRate: ratio(
      row.triggeredStationDayCount,
      row.evaluatedStationDayCount,
    ),
  }));
  return {
    state:
      runs.length > 0 && ruleRows.every((row) => row.evaluatedStationDayCount > 0)
        ? "READY"
        : runs.length > 0
          ? "PARTIAL"
          : "HOLD",
    period: { from: rangeFrom, to: rangeTo },
    stationCount: runs.length,
    ruleCount: rules.length,
    totalRuleEvaluationCount: ruleRows.reduce(
      (sum, row) => sum + row.evaluatedStationDayCount,
      0,
    ),
    totalRuleTriggerCount: ruleRows.reduce(
      (sum, row) => sum + row.triggeredStationDayCount,
      0,
    ),
    byCrop,
    byRule: ruleRows,
    generalRuleCount: rules.filter((rule) => rule.stage === "ANY").length,
    stageScopedRuleCount: rules.filter((rule) => rule.stage !== "ANY").length,
    monthlyCropTriggerRate,
    interpretation:
      "일반 규칙의 실제 관측 임계값 초과일을 집계했다. 생육단계 전용 규칙은 잠재 조건으로 분리했으며, 당시 예보가 그 날짜를 맞혔다는 뜻은 아니다.",
  };
}

function buildHarvestPace({ successfulStations: stations, from: rangeFrom, to: rangeTo }) {
  const windowEndDates = monthEndDates(rangeFrom, rangeTo).filter(
    (date) => daysBetween(rangeFrom, date) + 1 >= WINDOW_DAYS,
  );
  if (windowEndDates.at(-1) !== rangeTo) windowEndDates.push(rangeTo);
  const evaluations = [];
  for (const { location, readings } of stations) {
    const monthlyNormals = normalMeanRows(location.stationId);
    if (monthlyNormals.length !== 12) continue;
    for (const endDate of windowEndDates) {
      const startDate = addDays(endDate, -(WINDOW_DAYS - 1));
      const windowReadings = readings.filter(
        (row) => row.date >= startDate && row.date <= endDate,
      );
      for (const cropId of CROPS) {
        const result = calculateHarvestWeatherPace({
          cropId,
          from: startDate,
          to: endDate,
          readings: windowReadings,
          monthlyNormals,
        });
        evaluations.push({
          stationId: location.stationId,
          displayName: location.displayName,
          crop: cropId,
          windowStart: startDate,
          windowEnd: endDate,
          state: result.state,
          adjustmentApplied: result.adjustmentApplied,
          adjustmentDays: result.adjustmentDays,
          adjustmentMode: result.adjustmentMode,
          maximumAdjustmentDays: result.maximumAdjustmentDays,
          baselineHarvestWindowAvailable:
            result.baselineHarvestWindow !== null,
          coverage: result.coverage,
          paceRatio: result.paceRatio,
          pairedDayCount: result.pairedDayCount,
          limitations: result.limitations.join(" | "),
        });
      }
    }
  }
  const byCrop = CROPS.map((crop) => summarizeAdjustments(
    crop,
    evaluations.filter((row) => row.crop === crop),
  ));
  const monthlyCropAdjustment = [];
  for (const crop of CROPS) {
    for (const endDate of windowEndDates) {
      const rows = evaluations.filter(
        (row) => row.crop === crop && row.windowEnd === endDate,
      );
      if (rows.length === 0) continue;
      const appliedRows = rows.filter((row) => row.adjustmentApplied);
      const paceRatios = rows.map((row) => row.paceRatio).filter(Number.isFinite);
      monthlyCropAdjustment.push({
        windowEnd: endDate,
        crop,
        stationCount: rows.length,
        scheduleEligibleStationCount: appliedRows.length,
        meanAdjustmentDays:
          appliedRows.length === 0
            ? null
            : round(mean(appliedRows.map((row) => row.adjustmentDays)), 2),
        minimumAdjustmentDays:
          appliedRows.length === 0
            ? null
            : Math.min(...appliedRows.map((row) => row.adjustmentDays)),
        maximumAdjustmentDays:
          appliedRows.length === 0
            ? null
            : Math.max(...appliedRows.map((row) => row.adjustmentDays)),
        meanPaceRatio:
          paceRatios.length === 0 ? null : round(mean(paceRatios), 3),
      });
    }
  }
  const applied = evaluations.filter((row) => row.adjustmentApplied);
  const insufficientInput = evaluations.filter(
    (row) => row.pairedDayCount < 14 || row.coverage < 0.7,
  );
  const baselineMissing = evaluations.filter(
    (row) =>
      !row.adjustmentApplied &&
      row.pairedDayCount >= 14 &&
      row.coverage >= 0.7 &&
      Number.isFinite(row.paceRatio) &&
      !row.baselineHarvestWindowAvailable,
  );
  const thermalPaceReady = evaluations.filter((row) =>
    Number.isFinite(row.paceRatio),
  );
  const thermalPaceUnavailable = evaluations.filter(
    (row) => !Number.isFinite(row.paceRatio),
  );
  const capHits = applied.filter(
    (row) =>
      row.maximumAdjustmentDays > 0 &&
      Math.abs(row.adjustmentDays) === row.maximumAdjustmentDays,
  );
  return {
    state:
      evaluations.length > 0 &&
      insufficientInput.length === 0 &&
      applied.length === 0 &&
      baselineMissing.length > 0
        ? "PACE_READY_SCHEDULE_BLOCKED"
        : evaluations.length > 0 && insufficientInput.length === 0
          ? "READY"
        : evaluations.length > 0
          ? "PARTIAL"
          : "HOLD",
    windowDays: WINDOW_DAYS,
    windowEndDates,
    evaluationCount: evaluations.length,
    inputSufficientCount: evaluations.length - insufficientInput.length,
    inputSufficientRatio: ratio(
      evaluations.length - insufficientInput.length,
      evaluations.length,
    ),
    insufficientInputCount: insufficientInput.length,
    thermalPaceReadyCount: thermalPaceReady.length,
    thermalPaceReadyRatio: ratio(
      thermalPaceReady.length,
      evaluations.length,
    ),
    thermalPaceUnavailableCount: thermalPaceUnavailable.length,
    adjustmentAppliedCount: applied.length,
    scheduleEligibleRatio: ratio(applied.length, evaluations.length),
    baselineHarvestWindowMissingCount: baselineMissing.length,
    capHitCount: capHits.length,
    capHitRate: applied.length === 0 ? null : ratio(capHits.length, applied.length),
    byCrop,
    monthlyCropAdjustment,
    evaluations,
    interpretation:
      "각 월말 90일 관측으로 적산온도 계산 경로를 재생했다. 실제 작기·기준 수확 범위가 없으므로 일정 보정과 수확일 정확도 평가는 차단했다.",
  };
}

function buildDailyCropRiskRows({ replayRuns: runs, rules }) {
  const rows = [];
  const rulesByCrop = new Map(
    CROPS.map((crop) => [crop, rules.filter((rule) => rule.crop === crop)]),
  );
  for (const { location, readings, replay } of runs) {
    const triggerDatesByRule = new Map(
      replay.results.map((result) => [result.ruleId, new Set(result.triggerDates)]),
    );
    for (const reading of readings) {
      for (const crop of CROPS) {
        const cropRules = rulesByCrop.get(crop);
        const generalRules = cropRules.filter((rule) => rule.stage === "ANY");
        const stageRules = cropRules.filter((rule) => rule.stage !== "ANY");
        const triggeredGeneralRules = generalRules.filter((rule) =>
          triggerDatesByRule.get(rule.ruleId)?.has(reading.date),
        );
        const triggeredStageRules = stageRules.filter((rule) =>
          triggerDatesByRule.get(rule.ruleId)?.has(reading.date),
        );
        rows.push({
          date: reading.date,
          area_code: location.areaCode,
          region: location.displayName,
          station_id: location.stationId,
          station_name: location.stationName,
          crop_id: crop,
          crop_name_ko: cropName(crop),
          min_temperature_c: finiteOrBlank(reading.minTemperature),
          mean_temperature_c: finiteOrBlank(reading.meanTemperature),
          max_temperature_c: finiteOrBlank(reading.maxTemperature),
          precipitation_mm: finiteOrBlank(reading.precipitationAmount),
          temperature_data_complete:
            Number.isFinite(reading.minTemperature) &&
            Number.isFinite(reading.meanTemperature) &&
            Number.isFinite(reading.maxTemperature),
          general_rule_evaluable: generalRules.every((rule) =>
            Number.isFinite(reading[rule.metric]),
          ),
          general_risk_triggered: triggeredGeneralRules.length > 0,
          general_risk_rule_ids: triggeredGeneralRules
            .map((rule) => rule.ruleId)
            .join(" | "),
          general_risk_reasons_ko: triggeredGeneralRules
            .map((rule) => rule.guidance?.reason)
            .filter(Boolean)
            .join(" | "),
          stage_scoped_condition_triggered: triggeredStageRules.length > 0,
          stage_scoped_rule_ids: triggeredStageRules
            .map((rule) => rule.ruleId)
            .join(" | "),
          stage_scope_note_ko:
            triggeredStageRules.length > 0
              ? "해당 생육단계일 때만 위험으로 해석"
              : "",
        });
      }
    }
  }
  return rows.sort((left, right) =>
    `${left.date}|${left.station_id}|${left.crop_id}`.localeCompare(
      `${right.date}|${right.station_id}|${right.crop_id}`,
    ),
  );
}

function buildDailySummaryRows(detailRows) {
  const byDate = new Map();
  for (const row of detailRows) {
    const summary = byDate.get(row.date) ?? {
      date: row.date,
      observedStations: new Set(),
      completeTemperatureStations: new Set(),
      precipitationStations: new Set(),
      generalRiskStationCropCount: 0,
      cropsWithGeneralRisk: new Set(),
      regionsWithGeneralRisk: new Set(),
      stageScopedConditionStationCropCount: 0,
      cropsWithStageScopedCondition: new Set(),
    };
    summary.observedStations.add(row.station_id);
    if (row.temperature_data_complete) {
      summary.completeTemperatureStations.add(row.station_id);
    }
    if (row.precipitation_mm !== "") {
      summary.precipitationStations.add(row.station_id);
    }
    if (row.general_risk_triggered) {
      summary.generalRiskStationCropCount += 1;
      summary.cropsWithGeneralRisk.add(row.crop_name_ko);
      summary.regionsWithGeneralRisk.add(row.region);
    }
    if (row.stage_scoped_condition_triggered) {
      summary.stageScopedConditionStationCropCount += 1;
      summary.cropsWithStageScopedCondition.add(row.crop_name_ko);
    }
    byDate.set(row.date, summary);
  }
  return [...byDate.values()].map((row) => ({
    date: row.date,
    observed_station_count: row.observedStations.size,
    complete_temperature_station_count: row.completeTemperatureStations.size,
    precipitation_station_count: row.precipitationStations.size,
    general_risk_station_crop_count: row.generalRiskStationCropCount,
    crops_with_general_risk: [...row.cropsWithGeneralRisk].join(" | "),
    regions_with_general_risk: [...row.regionsWithGeneralRisk].join(" | "),
    stage_scoped_condition_station_crop_count:
      row.stageScopedConditionStationCropCount,
    crops_with_stage_scoped_condition: [
      ...row.cropsWithStageScopedCondition,
    ].join(" | "),
  }));
}

function toCsv(rows) {
  if (rows.length === 0) return "\ufeff";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  return `\ufeff${lines.join("\n")}\n`;
}

function csvCell(value) {
  const normalized = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(normalized)
    ? `"${normalized.replaceAll('"', '""')}"`
    : normalized;
}

function finiteOrBlank(value) {
  return Number.isFinite(value) ? value : "";
}

function cropName(crop) {
  return {
    APPLE: "사과",
    PEAR: "배",
    CUCUMBER: "오이",
    POTATO: "감자",
    LETTUCE: "상추",
  }[crop];
}

function repositoryRelativePath(targetPath) {
  return path.relative(path.resolve(process.cwd(), ".."), targetPath);
}

async function buildHistoricalForecastBacktest({
  adapter,
  locations: targetLocations,
  successfulStations: stations,
  from: rangeFrom,
  to: rangeTo,
  limitDays = null,
}) {
  const leadDays = [1, 3];
  const allDates = datesInRange(rangeFrom, rangeTo);
  const targetDates = Number.isInteger(limitDays)
    ? allDates.slice(0, limitDays)
    : allDates;
  const points = targetLocations.map((location) => ({
    id: location.areaCode,
    ...toKmaGrid(location.latitude, location.longitude),
  }));
  const extractPath = path.join(
    OUTPUT_DIRECTORY,
    `historical-short-grid-extract-${rangeFrom}-${rangeTo}.json`,
  );
  const accuracyCsvPath = path.join(
    OUTPUT_DIRECTORY,
    `historical-forecast-accuracy-${rangeFrom}-${rangeTo}.csv`,
  );
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const cache = await readForecastExtract(extractPath, {
    from: rangeFrom,
    to: rangeTo,
    leadDays,
  });
  const rowsByKey = new Map(
    cache.rows.map((row) => [forecastRowKey(row), row]),
  );
  const failures = cache.failures ?? [];

  for (const [dateIndex, validDate] of targetDates.entries()) {
    const expectedKeys = leadDays.flatMap((leadDay) =>
      targetLocations.map((location) =>
        forecastRowKey({
          areaCode: location.areaCode,
          validDate,
          leadDays: leadDay,
        }),
      ),
    );
    if (expectedKeys.every((key) => rowsByKey.has(key))) continue;

    const snapshotRequests = leadDays.flatMap((leadDay) => {
      const issueDate = addDays(validDate, -leadDay).replaceAll("-", "");
      const common = {
        baseDate: issueDate,
        baseTime: "1700",
        validDate: validDate.replaceAll("-", ""),
        points,
      };
      return [
        { leadDay, variable: "TMN", validTime: "0600", common },
        { leadDay, variable: "TMX", validTime: "1500", common },
      ];
    });
    const snapshots = await Promise.all(
      snapshotRequests.map(async (request) => ({
        ...request,
        envelope: await adapter.getGridSnapshot(
          {
            ...request.common,
            validTime: request.validTime,
            variable: request.variable,
          },
          { deadlineAt: Date.now() + 60_000 },
        ),
      })),
    );

    for (const leadDay of leadDays) {
      const leadSnapshots = snapshots.filter(
        (snapshot) => snapshot.leadDay === leadDay,
      );
      if (!leadSnapshots.every(({ envelope }) => envelope.adapterState === "SUCCESS")) {
        failures.push({
          validDate,
          leadDays: leadDay,
          states: leadSnapshots.map(({ variable, envelope }) => ({
            variable,
            state: envelope.adapterState,
            qualityFlags: envelope.qualityFlags ?? [],
          })),
        });
        continue;
      }
      const byVariable = new Map(
        leadSnapshots.map(({ variable, envelope }) => [variable, envelope]),
      );
      const minimum = byVariable.get("TMN");
      const maximum = byVariable.get("TMX");
      const minimumByArea = new Map(
        minimum.data.points.map(({ id, value }) => [id, value]),
      );
      const maximumByArea = new Map(
        maximum.data.points.map(({ id, value }) => [id, value]),
      );
      for (const location of targetLocations) {
        const row = {
          areaCode: location.areaCode,
          region: location.displayName,
          stationId: location.stationId,
          stationName: location.stationName,
          leadDays: leadDay,
          issuedAt: maximum.issuedAt,
          validAt: maximum.validFrom,
          validDate,
          minTemperature: minimumByArea.get(location.areaCode) ?? null,
          maxTemperature: maximumByArea.get(location.areaCode) ?? null,
          precipitationProbability: null,
        };
        rowsByKey.set(forecastRowKey(row), row);
      }
    }

    if ((dateIndex + 1) % 5 === 0 || dateIndex === targetDates.length - 1) {
      await writeForecastExtract(extractPath, {
        from: rangeFrom,
        to: rangeTo,
        leadDays,
        rows: [...rowsByKey.values()],
        failures,
      });
    }
    if ((dateIndex + 1) % 10 === 0 || dateIndex === targetDates.length - 1) {
      process.stderr.write(
        `[historical-grid] ${dateIndex + 1}/${targetDates.length} dates, ${rowsByKey.size} location-lead rows\n`,
      );
    }
  }

  const rows = [...rowsByKey.values()]
    .filter((row) => targetDates.includes(row.validDate))
    .sort((left, right) =>
      `${left.validDate}|${left.leadDays}|${left.areaCode}`.localeCompare(
        `${right.validDate}|${right.leadDays}|${right.areaCode}`,
      ),
    );
  const stationByArea = new Map(
    stations.map((station) => [station.location.areaCode, station]),
  );
  const byLead = leadDays.map((leadDay) =>
    summarizeForecastLead({
      leadDay,
      rows: rows.filter((row) => row.leadDays === leadDay),
      locations: targetLocations,
      stationByArea,
    }),
  );
  const expectedRowCount =
    targetDates.length * targetLocations.length * leadDays.length;
  const pairedMinimumCount = byLead.reduce(
    (sum, lead) => sum + lead.overall.temperature.minTemperature.sampleCount,
    0,
  );
  const pairedMaximumCount = byLead.reduce(
    (sum, lead) => sum + lead.overall.temperature.maxTemperature.sampleCount,
    0,
  );
  const minimumCoverage = ratio(pairedMinimumCount, expectedRowCount);
  const maximumCoverage = ratio(pairedMaximumCount, expectedRowCount);
  const isFullRun = targetDates.length === allDates.length;
  const state =
    isFullRun && minimumCoverage >= 0.95 && maximumCoverage >= 0.95
      ? "TEMPERATURE_READY"
      : rows.length > 0
        ? "PARTIAL"
        : "HOLD";
  const accuracyRows = byLead.flatMap((lead) =>
    lead.byLocation.map((location) => ({
      lead_days: lead.leadDays,
      area_code: location.areaCode,
      region: location.region,
      station_id: location.stationId,
      forecast_count: location.metrics.issuedForecastCount,
      matched_count: location.metrics.matchedForecastCount,
      matched_ratio: location.metrics.matchedForecastRatio,
      min_temperature_mae_c:
        location.metrics.temperature.minTemperature.meanAbsoluteError,
      min_temperature_rmse_c:
        location.metrics.temperature.minTemperature.rootMeanSquaredError,
      min_temperature_bias_c: location.metrics.temperature.minTemperature.bias,
      max_temperature_mae_c:
        location.metrics.temperature.maxTemperature.meanAbsoluteError,
      max_temperature_rmse_c:
        location.metrics.temperature.maxTemperature.rootMeanSquaredError,
      max_temperature_bias_c: location.metrics.temperature.maxTemperature.bias,
    })),
  );
  await writeFile(accuracyCsvPath, toCsv(accuracyRows), "utf8");

  return {
    state,
    source: {
      id: "kma-historical-short-grid",
      label: "기상청 과거 발행 단기예보 5km 격자",
      href: "https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-dfs_shrt_grd",
    },
    scope: {
      from: targetDates[0] ?? null,
      to: targetDates.at(-1) ?? null,
      requestedDayCount: targetDates.length,
      fullYearRequested: isFullRun,
      locationCount: targetLocations.length,
      leadDays,
      issueTimeKst: "1700",
      validTimesKst: { minTemperature: "0600", maxTemperature: "1500" },
    },
    providerState: {
      state: rows.length === 0 ? "UNAVAILABLE" : state === "TEMPERATURE_READY" ? "SUCCESS" : "PARTIAL",
      permissionVerified: rows.length > 0,
      extractedRowCount: rows.length,
      expectedRowCount,
      extractionCoverage: ratio(rows.length, expectedRowCount),
      failureCount: failures.length,
    },
    temperaturePairCoverage: {
      expectedPairCount: expectedRowCount,
      minimumTemperaturePairCount: pairedMinimumCount,
      minimumTemperatureCoverage: minimumCoverage,
      maximumTemperaturePairCount: pairedMaximumCount,
      maximumTemperatureCoverage: maximumCoverage,
    },
    byLead,
    riskAlertBacktest: buildTemperatureRiskAlertBacktest({
      rows,
      stationByArea,
      rules: openFieldRules,
      leadDays,
    }),
    unavailableMetrics: [
      {
        metric: "precipitationProbability",
        state: "BLOCKED_TEMPORAL_AGGREGATION",
        reason:
          "격자 API는 발효시각별 POP를 반환한다. 일강수 관측과 비교할 일 단위 확률을 만들려면 하루 전체 시각을 수집해야 하므로 대표 한 시각을 임의 사용하지 않았다.",
      },
      {
        metric: "fiveDayLead",
        state: "UNSUPPORTED_BY_SHORT_FORECAST_HORIZON",
        reason:
          "17시 단기예보 격자의 공식 제공기간은 최대 그글피까지이므로 5일 선행 예보를 만들지 않았다.",
      },
    ],
    artifacts: {
      extractJson: repositoryRelativePath(extractPath),
      accuracyCsv: repositoryRelativePath(accuracyCsvPath),
    },
  };
}

async function readForecastExtract(filePath, expected) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (
      parsed?.schemaVersion === 1 &&
      parsed.from === expected.from &&
      parsed.to === expected.to &&
      JSON.stringify(parsed.leadDays) === JSON.stringify(expected.leadDays) &&
      Array.isArray(parsed.rows)
    ) {
      return parsed;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { rows: [], failures: [] };
}

async function writeForecastExtract(filePath, payload) {
  await writeFile(
    filePath,
    `${JSON.stringify({ schemaVersion: 1, ...payload }, null, 2)}\n`,
    "utf8",
  );
}

function forecastRowKey({ areaCode, validDate, leadDays }) {
  return `${areaCode}|${validDate}|${leadDays}`;
}

function datesInRange(fromDate, toDate) {
  const dates = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function summarizeForecastLead({
  leadDay,
  rows,
  locations: targetLocations,
  stationByArea,
}) {
  const byLocation = targetLocations.map((location) => {
    const station = stationByArea.get(location.areaCode);
    const calculation = calculateIssuedForecastMetrics({
      issuedForecasts: rows
        .filter((row) => row.areaCode === location.areaCode)
        .map((row) => ({
          issuedAt: row.issuedAt,
          validAt: row.validAt,
          validDate: row.validDate,
          minTemperature: row.minTemperature,
          maxTemperature: row.maxTemperature,
          precipitationProbability: null,
        })),
      observations: station?.readings ?? [],
    });
    const metrics = {
      state:
        calculation.temperature.minTemperature.sampleCount > 0 &&
        calculation.temperature.maxTemperature.sampleCount > 0
          ? "TEMPERATURE_READY"
          : calculation.matchedForecastCount > 0
            ? "PARTIAL"
            : "HOLD",
      issuedForecastCount: calculation.issuedForecastCount,
      matchedForecastCount: calculation.matchedForecastCount,
      observationCount: calculation.observationCount,
      matchedForecastRatio: calculation.matchedForecastRatio,
      temperature: calculation.temperature,
      temperatureExclusionCount: calculation.exclusions.filter(
        ({ metric }) =>
          metric === "minTemperature" || metric === "maxTemperature",
      ).length,
      precipitation: {
        state: "BLOCKED_TEMPORAL_AGGREGATION",
        sampleCount: 0,
        brierScore: null,
      },
    };
    return {
      areaCode: location.areaCode,
      region: location.displayName,
      stationId: location.stationId,
      stationName: location.stationName,
      metrics,
    };
  });
  return {
    leadDays: leadDay,
    state: byLocation.every(
      ({ metrics }) =>
        metrics.temperature.minTemperature.sampleCount > 0 &&
        metrics.temperature.maxTemperature.sampleCount > 0,
    )
      ? "TEMPERATURE_READY"
      : "PARTIAL",
    overall: aggregateLocationForecastMetrics(byLocation),
    byLocation,
  };
}

function aggregateLocationForecastMetrics(rows) {
  const aggregateMetric = (metric) => {
    const parts = rows.map(({ metrics }) => metrics.temperature[metric]);
    const sampleCount = parts.reduce((sum, part) => sum + part.sampleCount, 0);
    if (sampleCount === 0) {
      return {
        sampleCount: 0,
        meanAbsoluteError: null,
        rootMeanSquaredError: null,
        bias: null,
      };
    }
    return {
      sampleCount,
      meanAbsoluteError: round(
        parts.reduce(
          (sum, part) => sum + part.meanAbsoluteError * part.sampleCount,
          0,
        ) / sampleCount,
        4,
      ),
      rootMeanSquaredError: round(
        Math.sqrt(
          parts.reduce(
            (sum, part) =>
              sum + part.rootMeanSquaredError ** 2 * part.sampleCount,
            0,
          ) / sampleCount,
        ),
        4,
      ),
      bias: round(
        parts.reduce((sum, part) => sum + part.bias * part.sampleCount, 0) /
          sampleCount,
        4,
      ),
    };
  };
  const issuedForecastCount = rows.reduce(
    (sum, row) => sum + row.metrics.issuedForecastCount,
    0,
  );
  const matchedForecastCount = rows.reduce(
    (sum, row) => sum + row.metrics.matchedForecastCount,
    0,
  );
  return {
    issuedForecastCount,
    matchedForecastCount,
    matchedForecastRatio: ratio(matchedForecastCount, issuedForecastCount),
    temperature: {
      minTemperature: aggregateMetric("minTemperature"),
      maxTemperature: aggregateMetric("maxTemperature"),
    },
    precipitation: {
      state: "BLOCKED_TEMPORAL_AGGREGATION",
      sampleCount: 0,
      brierScore: null,
    },
  };
}

function buildTemperatureRiskAlertBacktest({
  rows,
  stationByArea,
  rules,
  leadDays,
}) {
  const temperatureRules = rules.filter(
    (rule) =>
      rule.stage === "ANY" &&
      ["minTemperature", "maxTemperature"].includes(rule.metric),
  );
  const byLeadCrop = [];
  for (const leadDay of leadDays) {
    for (const crop of CROPS) {
      const cropRules = temperatureRules.filter((rule) => rule.crop === crop);
      let truePositive = 0;
      let falsePositive = 0;
      let trueNegative = 0;
      let falseNegative = 0;
      let evaluatedPairCount = 0;
      for (const row of rows.filter((item) => item.leadDays === leadDay)) {
        const station = stationByArea.get(row.areaCode);
        const observation = station?.readings.find(
          (reading) => reading.date === row.validDate,
        );
        const evaluable = cropRules.filter(
          (rule) =>
            Number.isFinite(row[rule.metric]) &&
            Number.isFinite(observation?.[rule.metric]),
        );
        if (evaluable.length === 0) continue;
        evaluatedPairCount += 1;
        const predicted = evaluable.some((rule) =>
          compareForecastRule(row[rule.metric], rule.comparison),
        );
        const observed = evaluable.some((rule) =>
          compareForecastRule(observation[rule.metric], rule.comparison),
        );
        if (predicted && observed) truePositive += 1;
        else if (predicted) falsePositive += 1;
        else if (observed) falseNegative += 1;
        else trueNegative += 1;
      }
      byLeadCrop.push({
        leadDays: leadDay,
        crop,
        ruleIds: cropRules.map((rule) => rule.ruleId),
        state: evaluatedPairCount > 0 ? "READY" : "HOLD",
        evaluatedPairCount,
        truePositive,
        falsePositive,
        trueNegative,
        falseNegative,
        precision:
          truePositive + falsePositive === 0
            ? null
            : round(truePositive / (truePositive + falsePositive), 4),
        recall:
          truePositive + falseNegative === 0
            ? null
            : round(truePositive / (truePositive + falseNegative), 4),
      });
    }
  }
  return {
    state: byLeadCrop.some((row) => row.state === "READY") ? "READY" : "HOLD",
    scope: "GENERAL_TEMPERATURE_RULES_ONLY",
    byLeadCrop,
  };
}

function compareForecastRule(value, comparison) {
  switch (comparison.operator) {
    case "GT":
      return value > comparison.threshold;
    case "GTE":
      return value >= comparison.threshold;
    case "LT":
      return value < comparison.threshold;
    case "LTE":
      return value <= comparison.threshold;
    default:
      throw new TypeError(`Unsupported comparison: ${comparison.operator}`);
  }
}

function summarizeProviderStates(runs) {
  const counts = {};
  for (const { envelope } of runs) {
    counts[envelope.adapterState] = (counts[envelope.adapterState] ?? 0) + 1;
  }
  return {
    state:
      counts.SUCCESS === runs.length
        ? "SUCCESS"
        : counts.SUCCESS > 0
          ? "PARTIAL"
          : "UNAVAILABLE",
    stationCount: runs.length,
    counts,
  };
}

function summarizeAdjustments(crop, rows) {
  const appliedRows = rows.filter((row) => row.adjustmentApplied);
  const adjustments = appliedRows.map((row) => row.adjustmentDays);
  const paceRatios = rows.map((row) => row.paceRatio).filter(Number.isFinite);
  const capHits = appliedRows.filter(
    (row) =>
      row.maximumAdjustmentDays > 0 &&
      Math.abs(row.adjustmentDays) === row.maximumAdjustmentDays,
  );
  return {
    crop,
    evaluationCount: rows.length,
    appliedCount: appliedRows.length,
    inputSufficientCount: rows.filter(
      (row) => row.pairedDayCount >= 14 && row.coverage >= 0.7,
    ).length,
    baselineHarvestWindowMissingCount: rows.filter(
      (row) =>
        !row.adjustmentApplied &&
        row.pairedDayCount >= 14 &&
        row.coverage >= 0.7 &&
        Number.isFinite(row.paceRatio) &&
        !row.baselineHarvestWindowAvailable,
    ).length,
    meanAdjustmentDays: adjustments.length === 0 ? null : round(mean(adjustments), 2),
    medianAdjustmentDays: median(adjustments),
    minimumAdjustmentDays: adjustments.length === 0 ? null : Math.min(...adjustments),
    maximumAdjustmentDays: adjustments.length === 0 ? null : Math.max(...adjustments),
    advancedCount: adjustments.filter((value) => value < 0).length,
    unchangedCount: adjustments.filter((value) => value === 0).length,
    delayedCount: adjustments.filter((value) => value > 0).length,
    capHitCount: capHits.length,
    capHitRate:
      appliedRows.length === 0 ? null : ratio(capHits.length, appliedRows.length),
    meanPaceRatio: paceRatios.length === 0 ? null : round(mean(paceRatios), 3),
  };
}

function normalMeanRows(stationId) {
  const values = CLIMATE_NORMALS.stations?.[stationId]?.metrics?.meanTemperature;
  if (!Array.isArray(values) || values.length !== 12) return [];
  return values.map((value, index) => ({
    metric: "meanTemperature",
    month: index + 1,
    value,
  }));
}

function longestCropStreak(keys) {
  const byStation = new Map();
  for (const key of keys) {
    const [stationId, date] = key.split("|");
    const dates = byStation.get(stationId) ?? [];
    dates.push(date);
    byStation.set(stationId, dates);
  }
  let longest = 0;
  for (const dates of byStation.values()) {
    dates.sort();
    let streak = 0;
    let previous = null;
    for (const date of dates) {
      streak = previous && addDays(previous, 1) === date ? streak + 1 : 1;
      longest = Math.max(longest, streak);
      previous = date;
    }
  }
  return longest;
}

function monthEndDates(fromDate, toDate) {
  const dates = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    if (addDays(date, 1).slice(0, 7) !== date.slice(0, 7)) dates.push(date);
  }
  return dates;
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    const dateMatch = /^--(from|to)=(\d{4}-\d{2}-\d{2})$/u.exec(value);
    if (dateMatch) {
      parsed[dateMatch[1]] = dateMatch[2];
      continue;
    }
    const limitMatch = /^--forecast-limit=(\d+)$/u.exec(value);
    if (limitMatch) {
      const limit = Number(limitMatch[1]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 365) {
        throw new TypeError("--forecast-limit must be between 1 and 365.");
      }
      parsed.forecastLimit = limit;
    }
  }
  return parsed;
}

function lastCompletedKstDate(date) {
  const today = new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
  return addDays(today, -1);
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) return false;
  return addDays(value, 0) === value;
}

function addDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) /
      DAY_MS,
  );
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[middle - 1] + sorted[middle]) / 2, 2)
    : sorted[middle];
}
