import { domainAssert } from "./errors.js";

export const HARVEST_WEATHER_RULE_VERSION = "harvest-weather-pace-v1";

const DAY_MS = 86_400_000;
const MINIMUM_PAIRED_DAYS = 14;
const MINIMUM_COVERAGE = 0.7;
const MAXIMUM_ADJUSTMENT_DAYS = 14;
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
  const enoughData =
    pairedDayCount >= MINIMUM_PAIRED_DAYS &&
    coverage >= MINIMUM_COVERAGE &&
    normalGrowingDegreeDays > 0;
  const normalDailyHeat = enoughData
    ? normalGrowingDegreeDays / pairedDayCount
    : null;
  const rawEquivalentDays = enoughData && normalDailyHeat > 0
    ? (normalGrowingDegreeDays - observedGrowingDegreeDays) / normalDailyHeat
    : null;
  const adjustmentDays = rawEquivalentDays === null
    ? 0
    : clamp(
        Math.round(rawEquivalentDays * coverage),
        -MAXIMUM_ADJUSTMENT_DAYS,
        MAXIMUM_ADJUSTMENT_DAYS,
      );
  const paceRatio = normalGrowingDegreeDays > 0
    ? observedGrowingDegreeDays / normalGrowingDegreeDays
    : null;
  const state = enoughData
    ? pairedDayCount === expectedDayCount
      ? "READY"
      : "PARTIAL"
    : pairedDayCount > 0
      ? "PARTIAL"
      : "HOLD";

  return Object.freeze({
    state,
    adjustmentApplied: enoughData,
    adjustmentDays,
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
      adjustmentDays,
      pairedDayCount,
      expectedDayCount,
      paceRatio,
    }),
    limitations: Object.freeze([
      "ASOS_STATION_NOT_FIELD_MICROCLIMATE",
      "THERMAL_PACE_NOT_BIOLOGICAL_MATURITY_DIAGNOSIS",
      ...(!enoughData ? ["SEASON_WEATHER_COVERAGE_INSUFFICIENT"] : []),
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
  adjustmentDays,
  pairedDayCount,
  expectedDayCount,
  paceRatio,
}) {
  if (!enoughData) {
    return `재배기간 관측 ${pairedDayCount}/${expectedDayCount}일·적산온도 비교가 부족해 기준 일정을 유지`;
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
