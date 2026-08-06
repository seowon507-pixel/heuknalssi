import { domainAssert } from "./errors.js";

export const HARVEST_WEATHER_RULE_VERSION = "harvest-weather-pace-v2";

const DAY_MS = 86_400_000;
const MINIMUM_PAIRED_DAYS = 14;
const MINIMUM_COVERAGE = 0.7;
const ABSOLUTE_MAXIMUM_ADJUSTMENT_DAYS = 14;
const WINDOW_ADJUSTMENT_RATIO = 0.25;
const CROP_PARAMETERS = Object.freeze({
  APPLE: Object.freeze({ baseTemperature: 4, coldMean: 10, hotMaximum: 34 }),
  PEAR: Object.freeze({ baseTemperature: 4, coldMean: 10, hotMaximum: 34 }),
  CUCUMBER: Object.freeze({ baseTemperature: 10, coldMean: 15, hotMaximum: 35 }),
  POTATO: Object.freeze({ baseTemperature: 5, coldMean: 10, hotMaximum: 32 }),
  LETTUCE: Object.freeze({ baseTemperature: 4, coldMean: 8, hotMaximum: 28 }),
});

/**
 * Compares accumulated ASOS heat units with the official monthly normal at
 * the mapped station. This is a bounded schedule estimate, not a biological
 * maturity diagnosis. Missing days are excluded and never treated as zero.
 */
export function calculateHarvestWeatherPace(input = {}) {
  const cropId = String(input.cropId ?? "").trim().toUpperCase();
  const parameters = CROP_PARAMETERS[cropId];
  domainAssert(parameters, "HARVEST_WEATHER_CROP_INVALID", "Unsupported crop.");
  const from = requiredDate(input.from, "from");
  const to = requiredDate(input.to, "to");
  domainAssert(from <= to, "HARVEST_WEATHER_RANGE_INVALID", "from must not be after to.");
  const expectedDayCount = daysBetween(from, to) + 1;
  domainAssert(
    expectedDayCount <= 366,
    "HARVEST_WEATHER_RANGE_INVALID",
    "Harvest weather range cannot exceed 366 days.",
  );
  const baselineHarvestWindow = optionalDateWindow(input.baselineHarvestWindow);
  const asOfDate = input.asOfDate === undefined
    ? to
    : requiredDate(input.asOfDate, "asOfDate");

  const normals = normalMeanByMonth(input.monthlyNormals);
  const readings = Array.isArray(input.readings) ? input.readings : [];
  const seenDates = new Set();
  let pairedDayCount = 0;
  let observedGrowingDegreeDays = 0;
  let normalGrowingDegreeDays = 0;
  let precipitationAmount = 0;
  let precipitationDayCount = 0;
  let coldStressDayCount = 0;
  let heatStressDayCount = 0;

  for (const reading of readings) {
    const date = String(reading?.date ?? "");
    if (!isDate(date) || date < from || date > to || seenDates.has(date)) continue;
    seenDates.add(date);
    const observedMean = dailyMean(reading);
    const normalMean = normals.get(Number(date.slice(5, 7))) ?? null;
    if (observedMean === null || normalMean === null) continue;
    pairedDayCount += 1;
    observedGrowingDegreeDays += Math.max(
      0,
      observedMean - parameters.baseTemperature,
    );
    normalGrowingDegreeDays += Math.max(
      0,
      normalMean - parameters.baseTemperature,
    );
    if (observedMean < parameters.coldMean) coldStressDayCount += 1;
    const maximum = finite(reading?.maxTemperature);
    if (maximum !== null && maximum > parameters.hotMaximum) {
      heatStressDayCount += 1;
    }
    const precipitation = finite(reading?.precipitationAmount);
    if (precipitation !== null) {
      precipitationAmount += precipitation;
      if (precipitation > 0) precipitationDayCount += 1;
    }
  }

  const coverage = pairedDayCount / expectedDayCount;
  const coverageSufficient =
    pairedDayCount >= MINIMUM_PAIRED_DAYS &&
    coverage >= MINIMUM_COVERAGE;
  const thermalBaselineActive = normalGrowingDegreeDays > 0;
  const enoughData = coverageSufficient && thermalBaselineActive;
  const paceRatio = normalGrowingDegreeDays > 0
    ? observedGrowingDegreeDays / normalGrowingDegreeDays
    : null;
  const baselineWindowElapsed = baselineHarvestWindow !== null &&
    asOfDate > baselineHarvestWindow.latest;
  const windowWidthDays = baselineHarvestWindow === null
    ? 0
    : daysBetween(
        baselineHarvestWindow.earliest,
        baselineHarvestWindow.latest,
      );
  const maximumAdjustmentDays = baselineHarvestWindow === null
    ? 0
    : Math.min(
        ABSOLUTE_MAXIMUM_ADJUSTMENT_DAYS,
        Math.ceil(windowWidthDays * WINDOW_ADJUSTMENT_RATIO),
      );
  const baselineMidpoint = baselineHarvestWindow === null
    ? null
    : addDays(
        baselineHarvestWindow.earliest,
        Math.round(windowWidthDays / 2),
      );
  const remainingDaysToMidpoint = baselineMidpoint === null
    ? null
    : Math.max(0, daysBetween(asOfDate, baselineMidpoint));
  const scheduleEligible =
    enoughData &&
    baselineHarvestWindow !== null &&
    !baselineWindowElapsed &&
    paceRatio !== null &&
    paceRatio > 0;
  const rawAdjustmentDays = scheduleEligible
    ? remainingDaysToMidpoint * (1 / paceRatio - 1)
    : null;
  const adjustmentDays = rawAdjustmentDays === null
    ? 0
    : clamp(
        Math.round(rawAdjustmentDays * coverage),
        -maximumAdjustmentDays,
        maximumAdjustmentDays,
      );
  const adjustedHarvestWindow = baselineHarvestWindow === null
    ? null
    : Object.freeze({
        earliest: addDays(baselineHarvestWindow.earliest, adjustmentDays),
        latest: addDays(baselineHarvestWindow.latest, adjustmentDays),
      });
  const state = enoughData
    ? pairedDayCount === expectedDayCount
      ? "READY"
      : "PARTIAL"
    : pairedDayCount > 0
      ? "PARTIAL"
      : "HOLD";

  return Object.freeze({
    state,
    adjustmentApplied: scheduleEligible,
    adjustmentDays,
    adjustmentMode: scheduleEligible
      ? "REMAINING_GDD_WINDOW_V2"
      : "THERMAL_PACE_ONLY",
    baselineHarvestWindow,
    adjustedHarvestWindow,
    maximumAdjustmentDays,
    rawAdjustmentDays:
      rawAdjustmentDays === null ? null : round(rawAdjustmentDays, 2),
    remainingDaysToMidpoint,
    confidence: scheduleConfidence({
      scheduleEligible,
      coverage,
      baselineConfidence: input.baselineConfidence,
    }),
    cropId,
    period: Object.freeze({ from, to, expectedDayCount }),
    coverage: round(coverage, 4),
    pairedDayCount,
    baseTemperature: parameters.baseTemperature,
    observedGrowingDegreeDays: round(observedGrowingDegreeDays, 1),
    normalGrowingDegreeDays: round(normalGrowingDegreeDays, 1),
    paceRatio: paceRatio === null ? null : round(paceRatio, 3),
    precipitationAmount: round(precipitationAmount, 1),
    precipitationDayCount,
    coldStressDayCount,
    heatStressDayCount,
    summary: paceSummary({
      enoughData,
      coverageSufficient,
      thermalBaselineActive,
      scheduleEligible,
      baselineHarvestWindow,
      baselineWindowElapsed,
      adjustmentDays,
      pairedDayCount,
      expectedDayCount,
      paceRatio,
    }),
    limitations: Object.freeze([
      "ASOS_STATION_NOT_FIELD_MICROCLIMATE",
      "THERMAL_PACE_NOT_BIOLOGICAL_MATURITY_DIAGNOSIS",
      ...(!coverageSufficient
        ? ["SEASON_WEATHER_COVERAGE_INSUFFICIENT"]
        : []),
      ...(coverageSufficient && !thermalBaselineActive
        ? ["NORMAL_GDD_BASELINE_INACTIVE"]
        : []),
      ...(baselineHarvestWindow === null
        ? ["BASELINE_HARVEST_WINDOW_REQUIRED"]
        : []),
      ...(baselineWindowElapsed ? ["BASELINE_HARVEST_WINDOW_ELAPSED"] : []),
    ]),
    ruleVersion: HARVEST_WEATHER_RULE_VERSION,
  });
}

function normalMeanByMonth(values) {
  const result = new Map();
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    if (value?.metric !== "meanTemperature") continue;
    const month = Number(value?.month);
    const mean = finite(value?.value);
    if (!Number.isInteger(month) || month < 1 || month > 12 || mean === null) continue;
    result.set(month, mean);
  }
  return result;
}

function dailyMean(reading) {
  const mean = finite(reading?.meanTemperature);
  if (mean !== null) return mean;
  const minimum = finite(reading?.minTemperature);
  const maximum = finite(reading?.maxTemperature);
  return minimum !== null && maximum !== null ? (minimum + maximum) / 2 : null;
}

function paceSummary({
  enoughData,
  coverageSufficient,
  thermalBaselineActive,
  scheduleEligible,
  baselineHarvestWindow,
  baselineWindowElapsed,
  adjustmentDays,
  pairedDayCount,
  expectedDayCount,
  paceRatio,
}) {
  if (!coverageSufficient) {
    return `재배기간 관측 ${pairedDayCount}/${expectedDayCount}일·적산온도 비교가 부족해 기준 일정을 유지`;
  }
  if (!thermalBaselineActive) {
    return "평년 기온이 작물 기준온도 이하인 기간이라 생육 속도로 환산하지 않음";
  }
  if (!enoughData) {
    return "적산온도 속도를 계산할 수 없어 기준 일정을 유지";
  }
  if (baselineHarvestWindow === null) {
    return "기준 수확 범위가 없어 적산온도 추이만 확인하고 수확 일정은 변경하지 않음";
  }
  if (baselineWindowElapsed) {
    return "기준 수확 범위가 지나 과거 일정을 변경하지 않음";
  }
  if (!scheduleEligible) {
    return "적산온도 속도를 일정 보정에 사용할 수 없어 기준 수확 범위를 유지";
  }
  const differencePercent = Math.round(Math.abs((paceRatio - 1) * 100));
  if (adjustmentDays < 0) {
    return `재배 후 ${pairedDayCount}일 적산온도가 평년보다 ${differencePercent}% 빨라 첫 수확을 ${Math.abs(adjustmentDays)}일 앞당겨 예상`;
  }
  if (adjustmentDays > 0) {
    return `재배 후 ${pairedDayCount}일 적산온도가 평년보다 ${differencePercent}% 느려 첫 수확을 ${adjustmentDays}일 늦춰 예상`;
  }
  return `재배 후 ${pairedDayCount}일 적산온도가 평년 범위와 비슷해 기준 일정을 유지`;
}

function optionalDateWindow(value) {
  if (value === null || value === undefined) return null;
  domainAssert(
    typeof value === "object" && !Array.isArray(value),
    "HARVEST_WEATHER_WINDOW_INVALID",
    "baselineHarvestWindow must be an object.",
  );
  const earliest = requiredDate(value.earliest, "baselineHarvestWindow.earliest");
  const latest = requiredDate(value.latest, "baselineHarvestWindow.latest");
  domainAssert(
    earliest <= latest,
    "HARVEST_WEATHER_WINDOW_INVALID",
    "baselineHarvestWindow.earliest must not be after latest.",
  );
  return Object.freeze({ earliest, latest });
}

function scheduleConfidence({ scheduleEligible, coverage, baselineConfidence }) {
  if (!scheduleEligible) return "LOW";
  const normalized = String(baselineConfidence ?? "LOW").trim().toUpperCase();
  return coverage >= 0.9 && ["HIGH", "MEDIUM"].includes(normalized)
    ? "MEDIUM"
    : "LOW";
}

function requiredDate(value, field) {
  domainAssert(isDate(value), "HARVEST_WEATHER_RANGE_INVALID", `${field} must be an ISO date.`);
  return value;
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      DAY_MS,
  );
}

function addDays(value, amount) {
  return new Date(
    new Date(`${value}T00:00:00Z`).getTime() + amount * DAY_MS,
  ).toISOString().slice(0, 10);
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
