import { DomainError } from "./errors.js";
import {
  ruleMatchesRequestContext,
  ruleStageMatchesRequestContext,
  validateRuleRegistry,
} from "../rules/registry.js";

const NUMERIC_METRICS = Object.freeze([
  "minTemperature",
  "maxTemperature",
  "precipitationProbability",
  "precipitationAmount",
  "windSpeed",
  "minRelativeHumidity",
  "maxRelativeHumidity",
  "meanRelativeHumidity",
]);

const TEMPERATURE_SAFETY_MARGIN = Object.freeze({
  SHORT_GRID: 2,
  MID_REGIONAL: 3,
});

export function mergeForecasts(shortForecast = [], midForecast = []) {
  const shortDays = normalizeSourceDays(shortForecast, "SHORT_GRID");
  const midDays = normalizeSourceDays(midForecast, "MID_REGIONAL");
  const shortByDate = new Map(shortDays.map((day) => [day.date, day]));
  const midByDate = new Map(midDays.map((day) => [day.date, day]));
  const dates = [...new Set([...shortByDate.keys(), ...midByDate.keys()])].sort();
  const mergedDisplayDays = dates.map(
    (date) => shortByDate.get(date) ?? midByDate.get(date),
  );
  const overlapEvidence = dates
    .filter((date) => shortByDate.has(date) && midByDate.has(date))
    .map((date) => ({
      date,
      displayedSourceType: "SHORT_GRID",
      preservedSourceTypes: ["SHORT_GRID", "MID_REGIONAL"],
      shortDay: shortByDate.get(date),
      midDay: midByDate.get(date),
    }));

  return {
    shortDays,
    midDays,
    mergedDisplayDays,
    overlapEvidence,
    shortAvailable: shortDays.length > 0,
    midAvailable: midDays.length > 0,
  };
}

export function evaluateForecastRisks(input = {}) {
  const merged = Array.isArray(input.days)
    ? { mergedDisplayDays: normalizeMixedDays(input.days) }
    : input.forecast?.mergedDisplayDays
      ? input.forecast
      : mergeForecasts(input.shortForecast ?? [], input.midForecast ?? []);
  const days = merged.mergedDisplayDays ?? [];
  const validation = validateRuleRegistry(input.rules ?? []);
  const invalidForecastRules = validation.invalidRules.filter(
    ({ rule }) =>
      looksLikeForecastRule(rule) && invalidRuleMatchesContext(rule, input),
  );
  const activeRules = validation.validRules.filter(
    (rule) =>
      looksLikeForecastRule(rule) &&
      ruleMatchesRequestContext(rule, input),
  );
  const risks = [];
  const missingMetrics = [];
  const ruleEvaluations = [];
  let evaluatedValueCount = 0;

  for (const rule of activeRules) {
    const eligibleDays = days.map((day) =>
      metricReading(day, rule, input.unitsByMetric, input.freshness),
    );
    const unavailable = eligibleDays.filter((reading) => !reading.available);
    const available = eligibleDays.filter((reading) => reading.available);
    evaluatedValueCount += available.length;
    for (const reading of unavailable) {
      missingMetrics.push({
        ruleId: rule.ruleId,
        metric: rule.metric,
        date: reading.day.date,
        reason: reading.reason,
      });
    }

    const durationResult = evaluateDuration(rule, eligibleDays);
    for (const incomplete of durationResult.incompleteWindows) {
      missingMetrics.push({
        ruleId: rule.ruleId,
        metric: rule.metric,
        date: incomplete.dateRange,
        reason: incomplete.reason,
      });
    }
    risks.push(...durationResult.risks);
    const missingCount =
      unavailable.length + durationResult.incompleteWindows.length;
    ruleEvaluations.push({
      ruleId: rule.ruleId,
      status:
        durationResult.risks.length > 0
          ? missingCount > 0
            ? "TRIGGERED_PARTIAL"
            : "TRIGGERED"
          : missingCount > 0
            ? available.length > 0
              ? "PARTIAL"
              : "UNAVAILABLE"
            : "EVALUATED_NO_RISK",
      evaluatedDayCount: available.length,
      missingDayCount: missingCount,
    });
  }

  for (const invalid of invalidForecastRules) {
    ruleEvaluations.push({
      ruleId: invalid.ruleId,
      status: "INVALID_RULE_SCHEMA",
      evaluatedDayCount: 0,
      missingDayCount: days.length,
    });
  }

  const dedupedRisks = dedupeRisks(risks);
  let state;
  const blockingReasons = [];
  if (invalidForecastRules.length > 0) {
    state = "HOLD";
    blockingReasons.push("INVALID_FORECAST_RULE_SCHEMA");
  } else if (activeRules.length === 0) {
    state = "HOLD";
    blockingReasons.push("NO_ACTIVE_FORECAST_RISK_RULES");
  } else if (days.length === 0 || evaluatedValueCount === 0) {
    state = "HOLD";
    blockingReasons.push("NO_CURRENT_FORECAST_VALUES");
  } else if (missingMetrics.length > 0) {
    state = "PARTIAL";
    blockingReasons.push("FORECAST_RISK_INPUTS_INCOMPLETE");
  } else {
    state = "READY";
  }

  const dailyOutlooks = buildDailyOutlooks({
    days,
    activeRules,
    risks: dedupedRisks,
    unitsByMetric: input.unitsByMetric,
    freshness: input.freshness,
    evaluationState: state,
  });

  return {
    state,
    risks: dedupedRisks,
    dailyOutlooks,
    missingMetrics,
    ruleEvaluations,
    noActiveRisksConfirmed: state === "READY" && dedupedRisks.length === 0,
    blockingReasons,
  };
}

export function evaluateForecast(input = {}) {
  const forecast = mergeForecasts(
    input.shortForecast ?? [],
    input.midForecast ?? [],
  );
  const riskResult = evaluateForecastRisks({
    ...input,
    forecast,
  });
  return {
    state: riskResult.state,
    coverage: null,
    blockingReasons: riskResult.blockingReasons,
    missingInputs: riskResult.missingMetrics.map(
      ({ ruleId, metric, date, reason }) => `${ruleId}:${metric}:${date}:${reason}`,
    ),
    qualityFlags: [],
    result: {
      ...forecast,
      risks: riskResult.risks,
      riskState: riskResult.state,
      noActiveRisksConfirmed: riskResult.noActiveRisksConfirmed,
      missingMetrics: riskResult.missingMetrics,
      ruleEvaluations: riskResult.ruleEvaluations,
      dailyOutlooks: riskResult.dailyOutlooks,
      outlookPolicy: {
        levels: ["DANGER", "CAUTION", "NORMAL", "FAVORABLE"],
        temperatureSafetyMargin: { ...TEMPERATURE_SAFETY_MARGIN },
        version: "forecast-outlook-v1",
      },
    },
  };
}

function buildDailyOutlooks({
  days,
  activeRules,
  risks,
  unitsByMetric,
  freshness,
  evaluationState,
}) {
  return days.map((day) => {
    const dayRisks = risks.filter((risk) => riskCoversDate(risk, day.date));
    if (dayRisks.some((risk) => risk.severity === "WARNING")) {
      return dailyOutlook(day, "DANGER", "WARNING_RULE_TRIGGERED", activeRules);
    }
    if (dayRisks.some((risk) => risk.severity === "CAUTION")) {
      return dailyOutlook(day, "CAUTION", "CAUTION_RULE_TRIGGERED", activeRules);
    }
    if (dayRisks.some((risk) => risk.severity === "INFO")) {
      return dailyOutlook(day, "NORMAL", "INFO_RULE_TRIGGERED", activeRules);
    }

    const readings = activeRules.map((rule) => ({
      rule,
      reading: metricReading(day, rule, unitsByMetric, freshness),
    }));
    const available = readings.filter(({ reading }) => reading.available);
    const missingRuleCount = readings.length - available.length;
    if (available.length === 0) {
      return dailyOutlook(
        day,
        "UNKNOWN",
        activeRules.length === 0 ? "NO_ACTIVE_RULES" : "NO_EVALUABLE_VALUES",
        activeRules,
        missingRuleCount,
      );
    }

    const withinSafetyMargin = available.some(({ rule, reading }) => {
      if (compare(reading.value, rule.comparison)) return true;
      const distance = safeDistanceFromThreshold(reading.value, rule.comparison);
      const margin = safetyMarginFor(day.sourceType, rule.metric);
      return distance === null || distance < margin;
    });
    const canConfirmFavorable =
      evaluationState === "READY" &&
      missingRuleCount === 0 &&
      available.length === activeRules.length &&
      !withinSafetyMargin;
    return dailyOutlook(
      day,
      canConfirmFavorable ? "FAVORABLE" : "NORMAL",
      canConfirmFavorable
        ? "ALL_RULES_OUTSIDE_SAFETY_MARGIN"
        : "NO_TRIGGER_WITHIN_SAFETY_MARGIN",
      activeRules,
      missingRuleCount,
    );
  });
}

function dailyOutlook(day, level, reason, activeRules, missingRuleCount = 0) {
  return {
    date: day.date,
    sourceType: day.sourceType,
    level,
    reason,
    evaluatedRuleCount: Math.max(0, activeRules.length - missingRuleCount),
    missingRuleCount,
  };
}

function riskCoversDate(risk, date) {
  return risk?.dateRange?.from <= date && date <= risk?.dateRange?.to;
}

function safetyMarginFor(sourceType, metric) {
  if (!["minTemperature", "maxTemperature"].includes(metric)) return 0;
  return TEMPERATURE_SAFETY_MARGIN[sourceType] ?? 3;
}

function safeDistanceFromThreshold(value, comparison) {
  if (!comparison || !Number.isFinite(comparison.threshold)) return null;
  if (["GT", "GTE"].includes(comparison.operator)) {
    return comparison.threshold - value;
  }
  if (["LT", "LTE"].includes(comparison.operator)) {
    return value - comparison.threshold;
  }
  return null;
}

function normalizeSourceDays(days, expectedSourceType) {
  if (days === null || days === undefined) return [];
  if (!Array.isArray(days)) {
    throw new DomainError(
      "INVALID_FORECAST_SCHEMA",
      "forecast source must be an array",
    );
  }
  const seen = new Set();
  return days
    .map((day) => normalizeDay(day, expectedSourceType))
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => {
      if (seen.has(day.date)) {
        throw new DomainError(
          "INVALID_FORECAST_SCHEMA",
          `duplicate ${expectedSourceType} forecast date: ${day.date}`,
        );
      }
      seen.add(day.date);
      return day;
    });
}

function normalizeMixedDays(days) {
  return days
    .map((day) => normalizeDay(day, day?.sourceType))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeDay(day, expectedSourceType) {
  if (day === null || typeof day !== "object" || Array.isArray(day)) {
    throw new DomainError("INVALID_FORECAST_SCHEMA", "forecast day must be an object");
  }
  if (!isIsoDate(day.date)) {
    throw new DomainError(
      "INVALID_FORECAST_DATE",
      "forecast day requires a real ISO calendar date",
      { details: { date: day.date } },
    );
  }
  if (
    !["SHORT_GRID", "MID_REGIONAL"].includes(expectedSourceType) ||
    day.sourceType !== expectedSourceType
  ) {
    throw new DomainError(
      "INVALID_FORECAST_SCHEMA",
      "forecast sourceType does not match its source collection",
      { details: { date: day.date, sourceType: day.sourceType, expectedSourceType } },
    );
  }
  for (const metric of NUMERIC_METRICS) {
    if (
      Object.hasOwn(day, metric) &&
      day[metric] !== null &&
      !Number.isFinite(day[metric])
    ) {
      throw new DomainError(
        "INVALID_FORECAST_SCHEMA",
        `${metric} must be finite or null`,
        { details: { date: day.date, metric } },
      );
    }
  }
  return deepFreeze(structuredClone(day));
}

function metricReading(day, rule, unitsByMetric, defaultFreshness) {
  const value = day[rule.metric];
  const unit =
    day.units?.[rule.metric] ??
    day.metricUnits?.[rule.metric] ??
    unitsByMetric?.[rule.metric] ??
    null;
  const freshness = resolveFreshness(day, defaultFreshness);
  if (freshness !== "CURRENT") {
    return {
      day,
      available: false,
      reason: freshness === null ? "FRESHNESS_UNKNOWN" : `SOURCE_${freshness}`,
    };
  }
  if (value === null || value === undefined) {
    return { day, available: false, reason: "MISSING_VALUE" };
  }
  if (!Number.isFinite(value)) {
    return { day, available: false, reason: "INVALID_VALUE" };
  }
  if (unit !== rule.unit) {
    return {
      day,
      available: false,
      reason: unit === null ? "UNIT_UNKNOWN" : "UNIT_MISMATCH",
    };
  }
  return { day, value, available: true };
}

function resolveFreshness(day, defaultFreshness) {
  const explicit = day.sourceFreshness ?? day.freshness ?? defaultFreshness;
  if (["CURRENT", "STALE", "SAMPLE"].includes(explicit)) return explicit;
  if (day.deliveryState === "SAMPLE") return "SAMPLE";
  if (day.qualityFlags?.includes("STALE")) return "STALE";
  if (day.deliveryState === "LIVE" || day.deliveryState === "CACHE") {
    return "CURRENT";
  }
  return null;
}

function evaluateDuration(rule, readings) {
  if (rule.duration.kind === "ANY_DAY") {
    return {
      risks: readings
        .filter(
          (reading) =>
            reading.available && compare(reading.value, rule.comparison),
        )
        .map((reading) =>
          riskFromReadings(rule, [reading], `${reading.day.date}`),
        ),
      incompleteWindows: [],
    };
  }

  const windowSize =
    rule.duration.kind === "CONSECUTIVE_DAYS"
      ? rule.duration.count
      : rule.duration.days;
  const results = [];
  const incompleteWindows = [];
  if (readings.length < windowSize) {
    incompleteWindows.push({
      dateRange:
        readings.length === 0
          ? "NO_DAYS"
          : `${readings[0].day.date}:${readings.at(-1).day.date}`,
      reason: "INSUFFICIENT_FORECAST_WINDOW",
    });
  }
  for (let index = 0; index <= readings.length - windowSize; index += 1) {
    const window = readings.slice(index, index + windowSize);
    if (window.some((reading) => !reading.available)) {
      continue;
    }
    const windowContinuity = consecutiveSourceStatus(window);
    if (windowContinuity !== null) {
      incompleteWindows.push({
        dateRange: `${window[0].day.date}:${window.at(-1).day.date}`,
        reason: windowContinuity,
      });
      continue;
    }
    const matches =
      rule.duration.kind === "CONSECUTIVE_DAYS"
        ? window.every((reading) => compare(reading.value, rule.comparison))
        : compare(
            window.reduce((sum, reading) => sum + reading.value, 0),
            rule.comparison,
          );
    if (matches) {
      results.push(
        riskFromReadings(
          rule,
          window,
          `${window[0].day.date}:${window.at(-1).day.date}`,
        ),
      );
    }
  }
  return { risks: results, incompleteWindows };
}

function riskFromReadings(rule, readings, suffix) {
  const evidenceIds = unique(
    readings.flatMap((reading) =>
      Array.isArray(reading.day.evidenceIds)
        ? reading.day.evidenceIds
        : [
            `forecast:${reading.day.sourceType}:${reading.day.date}:${rule.metric}`,
          ],
    ),
  ).sort();
  return {
    riskId: `${rule.ruleId}:${suffix}`,
    ruleId: rule.ruleId,
    dateRange: {
      from: readings[0].day.date,
      to: readings.at(-1).day.date,
    },
    sourceType: readings[0].day.sourceType,
    severity: rule.severity,
    actionId: rule.actionId,
    trigger: {
      metric: rule.metric,
      unit: rule.unit,
      comparison: structuredClone(rule.comparison),
      readings: readings.map(({ day, value }) => ({
        date: day.date,
        value,
      })),
    },
    guidance: structuredClone(rule.guidance),
    evidenceIds,
    sourceFreshness: "CURRENT",
  };
}

function compare(value, comparison) {
  if (comparison.operator === "GT") return value > comparison.threshold;
  if (comparison.operator === "GTE") return value >= comparison.threshold;
  if (comparison.operator === "LT") return value < comparison.threshold;
  if (comparison.operator === "LTE") return value <= comparison.threshold;
  return value >= comparison.lower && value <= comparison.upper;
}

function consecutiveSourceStatus(readings) {
  for (let index = 1; index < readings.length; index += 1) {
    if (readings[index].day.sourceType !== readings[0].day.sourceType) {
      return "SOURCE_BOUNDARY_IN_WINDOW";
    }
    if (nextIsoDate(readings[index - 1].day.date) !== readings[index].day.date) {
      return "NON_CONSECUTIVE_FORECAST_DATES";
    }
  }
  return null;
}

function nextIsoDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function invalidRuleMatchesContext(rule, input) {
  const request = input.request ?? {};
  const crop = input.crop ?? request.crop;
  const cultivationMode = input.cultivationMode ?? request.cultivationMode;
  if (crop && rule.crop && rule.crop !== crop) return false;
  if (
    cultivationMode &&
    rule.cultivationMode &&
    rule.cultivationMode !== cultivationMode
  ) {
    return false;
  }
  if (
    typeof rule.stage === "string" &&
    rule.stage.trim() !== "" &&
    !ruleStageMatchesRequestContext(rule, input)
  ) {
    return false;
  }
  return true;
}

function looksLikeForecastRule(rule) {
  return (
    rule?.module === "FORECAST" ||
    rule?.use === "FORECAST_RISK" ||
    (rule?.evidenceStatus === "RISK_ONLY" &&
      rule !== null &&
      typeof rule === "object" &&
      "comparison" in rule)
  );
}

function dedupeRisks(risks) {
  const byId = new Map();
  for (const risk of risks) {
    if (!byId.has(risk.riskId)) byId.set(risk.riskId, risk);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.dateRange.from.localeCompare(right.dateRange.from) ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.riskId.localeCompare(right.riskId),
  );
}

function isIsoDate(value) {
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
      : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function unique(values) {
  return [...new Set(values)];
}
