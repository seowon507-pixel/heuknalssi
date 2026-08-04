import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaHistoricalShortForecastAdapter,
} from "../src/adapters/index.js";
import {
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
const historicalForecastProbe = await probeHistoricalForecast({
  adapter: historicalForecastAdapter,
  location: locations[0],
  from,
});

const mechanicalReady =
  dataQuality.coverageRatio >= 0.98 &&
  dataQuality.successfulStationCount === locations.length &&
  riskReplay.state === "READY" &&
  harvestPace.state === "READY";
const result = {
  auditKind: "ONE_YEAR_WEATHER_RULE_AND_HARVEST_PACE_BACKTEST",
  generatedAt: new Date().toISOString(),
  state:
    mechanicalReady && historicalForecastProbe.state === "SUCCESS"
      ? "READY_WITHOUT_OUTCOME_GROUND_TRUTH"
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
    historicalIssuedForecast: historicalForecastProbe,
  },
  dataQuality,
  riskReplay,
  harvestPace,
  validationBoundaries: {
    forecastErrorMetrics:
      historicalForecastProbe.state === "SUCCESS"
        ? "SINGLE_ISSUE_PROBE_ONLY"
        : `BLOCKED_${historicalForecastProbe.state}`,
    cropDamagePrecisionRecall: "BLOCKED_NO_HISTORICAL_DAMAGE_LABELS",
    harvestDateError: "BLOCKED_NO_ACTUAL_HARVEST_DATES",
    historicalSoilContribution:
      "EXCLUDED_NO_AS_OF_DATE_FIELD_SOIL_SNAPSHOT",
    interpretation: [
      "관측 재생은 임계값 발동과 결측 방어를 검증하지만 미래 예측 정확도를 증명하지 않는다.",
      "90일 적산온도 재생은 일정 보정의 안정성을 검증하지만 실제 수확일 정확도를 증명하지 않는다.",
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

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const outputPath = path.join(
  OUTPUT_DIRECTORY,
  `one-year-backtest-${from}-${to}.json`,
);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
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
          coverage: result.coverage,
          paceRatio: result.paceRatio,
          pairedDayCount: result.pairedDayCount,
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
      monthlyCropAdjustment.push({
        windowEnd: endDate,
        crop,
        stationCount: rows.length,
        meanAdjustmentDays: round(mean(rows.map((row) => row.adjustmentDays)), 2),
        minimumAdjustmentDays: Math.min(...rows.map((row) => row.adjustmentDays)),
        maximumAdjustmentDays: Math.max(...rows.map((row) => row.adjustmentDays)),
        meanPaceRatio: round(mean(rows.map((row) => row.paceRatio)), 3),
      });
    }
  }
  const applied = evaluations.filter((row) => row.adjustmentApplied);
  const insufficientInput = evaluations.filter(
    (row) => row.pairedDayCount < 14 || row.coverage < 0.7,
  );
  const thermallyInactiveBaseline = evaluations.filter(
    (row) =>
      !row.adjustmentApplied &&
      row.pairedDayCount >= 14 &&
      row.coverage >= 0.7,
  );
  return {
    state:
      evaluations.length > 0 && insufficientInput.length === 0
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
    adjustmentAppliedCount: applied.length,
    thermallyEvaluableRatio: ratio(applied.length, evaluations.length),
    thermallyInactiveBaselineCount: thermallyInactiveBaseline.length,
    capHitCount: applied.filter((row) => Math.abs(row.adjustmentDays) === 14).length,
    capHitRate: ratio(
      applied.filter((row) => Math.abs(row.adjustmentDays) === 14).length,
      applied.length,
    ),
    byCrop,
    monthlyCropAdjustment,
    interpretation:
      "각 월말 90일 관측을 평년 적산온도와 비교한 일정 보정 민감도이며 실제 수확일 오차가 아니다.",
  };
}

async function probeHistoricalForecast({ adapter, location, from: rangeFrom }) {
  const issueDate = addDays(rangeFrom, -1);
  const grid = toKmaGrid(location.latitude, location.longitude);
  const envelope = await adapter.getIssuedForecast(
    {
      ...grid,
      baseDate: issueDate.replaceAll("-", ""),
      baseTime: "1700",
    },
    { deadlineAt: Date.now() + 30_000 },
  );
  return {
    state: envelope.adapterState,
    probeIssueDate: issueDate,
    probeBaseTimeKst: "1700",
    stationLabel: location.displayName,
    qualityFlags: envelope.qualityFlags ?? [],
    fullYearForecastMetricsCalculated: false,
    reason:
      envelope.adapterState === "SUCCESS"
        ? "단일 발행시점 접근만 확인했으며 365개 발행본 수집은 별도 배치가 필요"
        : "과거 발행 예보 접근이 불가해 관측과 예보의 오차지표를 계산하지 못함",
  };
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
  const adjustments = rows.map((row) => row.adjustmentDays);
  const paceRatios = rows.map((row) => row.paceRatio).filter(Number.isFinite);
  return {
    crop,
    evaluationCount: rows.length,
    appliedCount: rows.filter((row) => row.adjustmentApplied).length,
    inputSufficientCount: rows.filter(
      (row) => row.pairedDayCount >= 14 && row.coverage >= 0.7,
    ).length,
    thermallyInactiveBaselineCount: rows.filter(
      (row) =>
        !row.adjustmentApplied &&
        row.pairedDayCount >= 14 &&
        row.coverage >= 0.7,
    ).length,
    meanAdjustmentDays: adjustments.length === 0 ? null : round(mean(adjustments), 2),
    medianAdjustmentDays: median(adjustments),
    minimumAdjustmentDays: adjustments.length === 0 ? null : Math.min(...adjustments),
    maximumAdjustmentDays: adjustments.length === 0 ? null : Math.max(...adjustments),
    advancedCount: adjustments.filter((value) => value < 0).length,
    unchangedCount: adjustments.filter((value) => value === 0).length,
    delayedCount: adjustments.filter((value) => value > 0).length,
    capHitCount: adjustments.filter((value) => Math.abs(value) === 14).length,
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
  return Object.fromEntries(
    values.flatMap((value) => {
      const match = /^--(from|to)=(\d{4}-\d{2}-\d{2})$/u.exec(value);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
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
