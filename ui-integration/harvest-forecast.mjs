const DAY_MS = 86_400_000;

const TEMPERATURE_LIMITS = Object.freeze({
  apple: Object.freeze({ coldMean: 10, hotMaximum: 34 }),
  pear: Object.freeze({ coldMean: 10, hotMaximum: 34 }),
  cucumber: Object.freeze({ coldMean: 15, hotMaximum: 35 }),
  potato: Object.freeze({ coldMean: 10, hotMaximum: 32 }),
  lettuce: Object.freeze({ coldMean: 8, hotMaximum: 28 }),
});

/**
 * Builds a display forecast without replacing the reviewed crop-cycle rule.
 * Season-to-date ASOS can move the reviewed window by at most 14 days, the
 * next seven-day forecast can delay it by at most seven more days, and a photo
 * can add a bounded delay only near the expected first harvest.
 */
export function buildHarvestForecast({
  crop,
  projection,
  seasonWeather = null,
  forecastDays = [],
  photoAssessment = null,
  asOf = new Date(),
} = {}) {
  const firstHarvest = normalizeWindow(projection?.harvestWindow);
  const harvestSeason = normalizeWindow(
    projection?.harvestSeasonWindow ?? projection?.harvestWindow,
  );
  const history = historicalWeatherAdjustment(seasonWeather);
  const weather = weatherDelay({ crop, forecastDays });
  const afterWeather = shiftWindow(
    firstHarvest,
    history.adjustmentDays + weather.delayDays,
  );
  const photo = photoDelay({
    assessment: photoAssessment,
    firstHarvest: afterWeather,
    asOf,
  });
  const totalAdjustmentDays =
    history.adjustmentDays + weather.delayDays + photo.delayDays;
  const adjustedFirstHarvest = shiftWindow(firstHarvest, totalAdjustmentDays);
  const adjustedHarvestSeason = shiftWindow(harvestSeason, totalAdjustmentDays);
  const preparationWindow = optionalWindow(projection?.preparationStartsOn);

  return Object.freeze({
    firstHarvestWindow: adjustedFirstHarvest,
    harvestSeasonWindow: adjustedHarvestSeason,
    preparationWindow: preparationWindow
      ? shiftWindow(preparationWindow, totalAdjustmentDays)
      : null,
    progressPercent: scheduleProgress({
      projection,
      firstHarvest: adjustedFirstHarvest,
      asOf,
    }),
    totalAdjustmentDays,
    totalDelayDays: totalAdjustmentDays,
    history,
    weather,
    photo,
    sourceLabel: scheduleSourceLabel({
      totalAdjustmentDays,
      historyAvailable: history.available,
    }),
  });
}

function historicalWeatherAdjustment(value) {
  const available = value && typeof value === "object";
  const applied = available && value.adjustmentApplied === true;
  const adjustmentDays = applied
    ? clamp(Math.round(finite(value.adjustmentDays) ?? 0), -14, 14)
    : 0;
  return Object.freeze({
    available,
    applied,
    adjustmentDays,
    pairedDayCount: finite(value?.pairedDayCount),
    coverage: finite(value?.coverage),
    paceRatio: finite(value?.paceRatio),
    summary: String(
      value?.summary ?? "재배기간 누적날씨는 다음 분석부터 반영",
    ),
  });
}

function scheduleSourceLabel({ totalAdjustmentDays, historyAvailable }) {
  const basis = historyAvailable
    ? "기준일·누적날씨·예보"
    : "기준일·예보";
  if (totalAdjustmentDays < 0) {
    return `${basis} ${Math.abs(totalAdjustmentDays)}일 앞당김`;
  }
  if (totalAdjustmentDays > 0) return `${basis} +${totalAdjustmentDays}일`;
  return `${basis} 반영`;
}

function weatherDelay({ crop, forecastDays }) {
  const limits = TEMPERATURE_LIMITS[normalizeCrop(crop)]
    ?? TEMPERATURE_LIMITS.cucumber;
  const days = Array.isArray(forecastDays) ? forecastDays.slice(0, 7) : [];
  let delayScore = 0;
  let usableDayCount = 0;
  let coldDayCount = 0;
  let hotDayCount = 0;
  for (const day of days) {
    const maximum = finite(day?.maxTemperature);
    const minimum = finite(day?.minTemperature);
    if (maximum === null && minimum === null) continue;
    usableDayCount += 1;
    const mean = maximum !== null && minimum !== null
      ? (maximum + minimum) / 2
      : (maximum ?? minimum);
    if (mean < limits.coldMean) {
      coldDayCount += 1;
      delayScore += Math.min(1.5, (limits.coldMean - mean) / 4);
    }
    if (maximum !== null && maximum > limits.hotMaximum) {
      hotDayCount += 1;
      delayScore += Math.min(1.5, (maximum - limits.hotMaximum) / 4);
    }
  }
  const delayDays = clamp(Math.round(delayScore), 0, 7);
  const summary = usableDayCount === 0
    ? "예보값이 없어 기준 일정만 사용"
    : delayDays === 0
      ? "7일 예보에서 일정 지연 신호 없음"
      : `저온 ${coldDayCount}일·고온 ${hotDayCount}일을 반영해 ${delayDays}일 늦춤`;
  return Object.freeze({
    delayDays,
    usableDayCount,
    coldDayCount,
    hotDayCount,
    summary,
  });
}

function photoDelay({ assessment, firstHarvest, asOf }) {
  const state = String(assessment?.state ?? "NOT_ASSESSED").toUpperCase();
  const quality = String(assessment?.quality ?? "UNKNOWN").toUpperCase();
  const confidence = clampNumber(assessment?.confidence, 0, 1, 0);
  const asOfKey = dateKey(asOf);
  const nearHarvest =
    daysBetween(asOfKey, firstHarvest.earliest) <= 7 &&
    daysBetween(asOfKey, firstHarvest.latest) >= -14;
  const trusted = quality === "USABLE" && confidence >= 0.65;
  const requestedDelay = clamp(
    Math.round(finite(assessment?.suggestedDelayDays) ?? 0),
    0,
    14,
  );
  const delayDays = state === "NOT_READY" && trusted && nearHarvest
    ? Math.max(1, requestedDelay)
    : 0;
  const summary = state === "NOT_ASSESSED"
    ? "수확 사진 미확인"
    : !trusted
      ? "사진만으로 수확 시점을 조정하지 않음"
      : state === "NOT_READY" && !nearHarvest
        ? "첫 수확 7일 전부터 사진 결과를 일정에 반영"
        : state === "NOT_READY"
          ? `사진상 아직 이른 상태로 ${delayDays}일 늦춤`
          : state === "READY"
            ? "사진상 수확 가능 신호 확인"
            : "사진상 수확 여부 판단 보류";
  return Object.freeze({ state, quality, confidence, delayDays, summary });
}

function scheduleProgress({ projection, firstHarvest, asOf }) {
  if (projection?.status === "COMPLETED") return 100;
  if (projection?.status === "PLANNING") return 0;
  const anchor = String(projection?.anchorDate ?? "");
  if (!isDateKey(anchor)) {
    const minimum = finite(projection?.progress?.minPercent) ?? 0;
    const maximum = finite(projection?.progress?.maxPercent) ?? minimum;
    return clamp(Math.round((minimum + maximum) / 2), 0, 100);
  }
  const today = dateKey(asOf);
  const target = midpointDate(firstHarvest);
  const total = Math.max(1, daysBetween(anchor, target));
  const elapsed = Math.max(0, daysBetween(anchor, today));
  return clamp(Math.round((elapsed / total) * 100), 0, 100);
}

function normalizeWindow(value) {
  const earliest = String(value?.earliest ?? "");
  const latest = String(value?.latest ?? "");
  if (!isDateKey(earliest) || !isDateKey(latest) || earliest > latest) {
    throw new TypeError("수확 일정 범위를 확인해 주세요.");
  }
  return Object.freeze({ earliest, latest });
}

function optionalWindow(value) {
  if (!value) return null;
  return normalizeWindow(value);
}

function shiftWindow(window, days) {
  return Object.freeze({
    earliest: addDays(window.earliest, days),
    latest: addDays(window.latest, days),
  });
}

function midpointDate(window) {
  const difference = daysBetween(window.earliest, window.latest);
  return addDays(window.earliest, Math.round(difference / 2));
}

function daysBetween(from, to) {
  return Math.round((dateValue(to) - dateValue(from)) / DAY_MS);
}

function addDays(value, days) {
  return new Date(dateValue(value) + days * DAY_MS).toISOString().slice(0, 10);
}

function dateValue(value) {
  if (!isDateKey(value)) throw new TypeError("invalid date");
  return new Date(`${value}T00:00:00Z`).getTime();
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid date");
  return date.toISOString().slice(0, 10);
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeCrop(value) {
  return String(value ?? "").trim().toLowerCase();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = finite(value);
  return number === null ? fallback : clamp(number, minimum, maximum);
}
