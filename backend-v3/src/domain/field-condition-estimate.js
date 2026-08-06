const OPEN_FIELD = "OPEN_FIELD";
const MINIMUM_RECENT_DAYS = 3;
const MAXIMUM_CONFIDENCE = 0.7;

/**
 * Provides a conservative, weather-balance estimate for screens that need a
 * soil-condition hint before a field sensor or a recent soil examination is
 * available. This is deliberately separate from growth-score-v2.
 *
 * Reference evapotranspiration follows FAO-56 Hargreaves equation 52. The
 * moisture index is a versioned product heuristic, not volumetric water
 * content: 50 is a neutral prior and recent rainfall minus reference ET moves
 * the index within a deliberately broad uncertainty range.
 */
export function estimateFieldConditions(input = {}) {
  if (input.cultivationMode !== OPEN_FIELD) {
    return unavailableEstimate(
      "NOT_APPLICABLE",
      "OUTDOOR_WEATHER_CANNOT_ESTIMATE_FACILITY_ROOT_ZONE",
    );
  }

  const recentDays = normalizeRecentDays(
    input.recentDays ?? input.observations?.result?.days ?? [],
  );
  const latitude = normalizedLatitude(input.latitude);
  if (recentDays.length < MINIMUM_RECENT_DAYS || latitude === null) {
    return unavailableEstimate(
      "HOLD",
      recentDays.length < MINIMUM_RECENT_DAYS
        ? "FEWER_THAN_3_RECENT_WEATHER_DAYS"
        : "LOCATION_LATITUDE_UNAVAILABLE",
    );
  }

  const waterBalanceDays = recentDays.map((day) => {
    const referenceEvapotranspiration = hargreavesReferenceEt({
      date: day.date,
      latitude,
      minTemperature: day.minTemperature,
      maxTemperature: day.maxTemperature,
      meanTemperature: day.meanTemperature,
    });
    return {
      date: day.date,
      precipitationAmount: day.precipitationAmount,
      referenceEvapotranspiration,
      balance:
        referenceEvapotranspiration === null
          ? null
          : day.precipitationAmount - referenceEvapotranspiration,
    };
  });
  const usableBalanceDays = waterBalanceDays.filter((day) =>
    Number.isFinite(day.balance),
  );
  if (usableBalanceDays.length < MINIMUM_RECENT_DAYS) {
    return unavailableEstimate(
      "HOLD",
      "RECENT_WATER_BALANCE_INPUTS_INCOMPLETE",
    );
  }

  const cumulativeRainfall = sum(
    usableBalanceDays.map((day) => day.precipitationAmount),
  );
  const cumulativeReferenceEt = sum(
    usableBalanceDays.map((day) => day.referenceEvapotranspiration),
  );
  const cumulativeBalance = cumulativeRainfall - cumulativeReferenceEt;
  const centralIndex = round(
    clamp(50 + cumulativeBalance * 1.5, 5, 95),
    0,
  );
  const observationDistanceKm = finiteOrNull(input.observationDistanceKm);
  const uncertainty = clamp(
    20 +
      (7 - usableBalanceDays.length) * 3 +
      Math.min(Math.max(observationDistanceKm ?? 20, 0) * 0.25, 10),
    20,
    40,
  );
  const confidenceScore = estimateConfidence({
    usableDayCount: usableBalanceDays.length,
    observationDistanceKm,
    recentDays,
  });
  const temperature = estimateSoilTemperature({
    recentDays,
    forecastDays: input.forecastDays ?? [],
    observationDistanceKm,
  });

  return {
    state:
      usableBalanceDays.length === recentDays.length ? "READY" : "PARTIAL",
    method: "WEATHER_BALANCE_ESTIMATE_V1",
    measured: false,
    affectsGrowthScore: false,
    surfaceMoisture: {
      metric: "surfaceMoistureIndex",
      unit: "relative_index_0_100",
      central: centralIndex,
      lower: round(clamp(centralIndex - uncertainty, 0, 100), 0),
      upper: round(clamp(centralIndex + uncertainty, 0, 100), 0),
      trend: moistureTrend(cumulativeBalance),
      cumulativeRainfallMm: round(cumulativeRainfall, 1),
      cumulativeReferenceEtMm: round(cumulativeReferenceEt, 1),
      cumulativeBalanceMm: round(cumulativeBalance, 1),
      window: {
        from: usableBalanceDays[0].date,
        to: usableBalanceDays.at(-1).date,
        dayCount: usableBalanceDays.length,
      },
    },
    soilTemperature: temperature,
    confidence: {
      level: confidenceScore >= 0.5 ? "MEDIUM" : "LOW",
      score: round(confidenceScore, 2),
      maximumPossible: MAXIMUM_CONFIDENCE,
    },
    inputsUsed: {
      recentWeatherDayCount: usableBalanceDays.length,
      observationDistanceKm,
      stationSoilTemperatureDayCount: recentDays.filter((day) =>
        Number.isFinite(day.soilTemperature5cm),
      ).length,
    },
    supplementaryInputsAvailable: {
      fieldProfile: Boolean(input.fieldProfile),
      humidityDayCount: recentDays.filter((day) =>
        Number.isFinite(day.averageRelativeHumidity),
      ).length,
    },
    qualityFlags: unique([
      "ESTIMATE_NOT_SENSOR_MEASUREMENT",
      "UNKNOWN_INITIAL_SOIL_MOISTURE",
      "IRRIGATION_NOT_INCLUDED",
      ...(observationDistanceKm === null
        ? ["OBSERVATION_DISTANCE_UNKNOWN"]
        : []),
      ...(temperature?.basis === "AIR_TEMPERATURE_PROXY"
        ? ["SOIL_TEMPERATURE_USES_AIR_PROXY"]
        : []),
    ]),
    provenance: {
      referenceEvapotranspiration: "FAO56_HARGREAVES_EQUATION_52",
      moistureIndex: "HEUKNALSSI_NEUTRAL_PRIOR_WATER_BALANCE_V1",
      version: "field-condition-estimate-v1",
    },
  };
}

function normalizeRecentDays(days) {
  if (!Array.isArray(days)) return [];
  return days
    .filter(
      (day) =>
        day &&
        /^\d{4}-\d{2}-\d{2}$/u.test(day.date) &&
        Number.isFinite(day.minTemperature) &&
        Number.isFinite(day.maxTemperature) &&
        Number.isFinite(day.meanTemperature) &&
        Number.isFinite(day.precipitationAmount) &&
        day.precipitationAmount >= 0,
    )
    .map((day) => structuredClone(day))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-7);
}

function hargreavesReferenceEt({
  date,
  latitude,
  minTemperature,
  maxTemperature,
  meanTemperature,
}) {
  const temperatureRange = maxTemperature - minTemperature;
  if (temperatureRange < 0) return null;
  const dayOfYear = isoDayOfYear(date);
  if (dayOfYear === null) return null;
  const radiationMj = extraterrestrialRadiationMj(latitude, dayOfYear);
  const radiationEquivalentMm = radiationMj * 0.408;
  return Math.max(
    0,
    0.0023 *
      (meanTemperature + 17.8) *
      Math.sqrt(temperatureRange) *
      radiationEquivalentMm,
  );
}

function extraterrestrialRadiationMj(latitude, dayOfYear) {
  const latitudeRadians = (latitude * Math.PI) / 180;
  const inverseRelativeDistance =
    1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365);
  const solarDeclination =
    0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39);
  const sunsetHourAngle = Math.acos(
    clamp(
      -Math.tan(latitudeRadians) * Math.tan(solarDeclination),
      -1,
      1,
    ),
  );
  return (
    ((24 * 60) / Math.PI) *
    0.082 *
    inverseRelativeDistance *
    (sunsetHourAngle *
      Math.sin(latitudeRadians) *
      Math.sin(solarDeclination) +
      Math.cos(latitudeRadians) *
        Math.cos(solarDeclination) *
        Math.sin(sunsetHourAngle))
  );
}

function estimateSoilTemperature({
  recentDays,
  forecastDays,
  observationDistanceKm,
}) {
  const recent = recentDays.slice(-3);
  const stationSoilValues = recent
    .map((day) => day.soilTemperature5cm)
    .filter(Number.isFinite);
  const stationGroundValues = recent
    .map((day) => day.groundTemperature)
    .filter(Number.isFinite);
  let basis;
  let values;
  let baseUncertainty;
  if (stationSoilValues.length > 0) {
    basis = "ASOS_5CM_SOIL_TEMPERATURE";
    values = stationSoilValues;
    baseUncertainty = 2.5;
  } else if (stationGroundValues.length > 0) {
    basis = "ASOS_GROUND_TEMPERATURE";
    values = stationGroundValues;
    baseUncertainty = 4;
  } else {
    basis = "AIR_TEMPERATURE_PROXY";
    values = recent.map((day) => day.meanTemperature).filter(Number.isFinite);
    baseUncertainty = 5;
  }
  if (values.length === 0) return null;

  let central = weightedRecentAverage(values);
  const nextForecast = Array.isArray(forecastDays)
    ? forecastDays.find(
        (day) =>
          Number.isFinite(day?.minTemperature) &&
          Number.isFinite(day?.maxTemperature),
      )
    : null;
  const latestAir = recent.at(-1)?.meanTemperature;
  if (nextForecast && Number.isFinite(latestAir)) {
    const nextAirMean =
      (nextForecast.minTemperature + nextForecast.maxTemperature) / 2;
    central += (nextAirMean - latestAir) * 0.25;
  }
  const distanceUncertainty = Math.min(
    Math.max(observationDistanceKm ?? 20, 0) * 0.05,
    3,
  );
  const uncertainty = baseUncertainty + distanceUncertainty;
  return {
    metric: "soilTemperatureEstimate",
    unit: "degC",
    central: round(central, 1),
    lower: round(central - uncertainty, 1),
    upper: round(central + uncertainty, 1),
    basis,
    asOf: recent.at(-1)?.date ?? null,
  };
}

function estimateConfidence({
  usableDayCount,
  observationDistanceKm,
  recentDays,
}) {
  const distancePenalty = Math.min(
    Math.max(observationDistanceKm ?? 20, 0) / 100,
    0.2,
  );
  const observedSoilTemperature = recentDays.some(
    (day) =>
      Number.isFinite(day.soilTemperature5cm) ||
      Number.isFinite(day.groundTemperature),
  );
  return clamp(
    0.25 +
      (usableDayCount / 7) * 0.25 +
      (observedSoilTemperature ? 0.1 : 0) -
      distancePenalty,
    0.15,
    MAXIMUM_CONFIDENCE,
  );
}

function moistureTrend(balanceMm) {
  if (balanceMm <= -10) return "DRYING";
  if (balanceMm >= 10) return "WETTING";
  return "STABLE";
}

function unavailableEstimate(state, reason) {
  return {
    state,
    method: "WEATHER_BALANCE_ESTIMATE_V1",
    measured: false,
    affectsGrowthScore: false,
    surfaceMoisture: null,
    soilTemperature: null,
    confidence: null,
    inputsUsed: null,
    supplementaryInputsAvailable: null,
    qualityFlags: ["ESTIMATE_NOT_SENSOR_MEASUREMENT"],
    blockingReasons: [reason],
    provenance: {
      version: "field-condition-estimate-v1",
    },
  };
}

function isoDayOfYear(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor((date - Date.UTC(year, 0, 0)) / 86_400_000);
}

function normalizedLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90 ? value : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function weightedRecentAverage(values) {
  const weights = values.map((_, index) => index + 1);
  return (
    values.reduce((total, value, index) => total + value * weights[index], 0) /
    sum(weights)
  );
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function unique(values) {
  return [...new Set(values)];
}
