import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaHistoricalMediumForecastAdapter,
  createKmaHistoricalShortForecastAdapter,
} from "../src/adapters/index.js";
import {
  aggregateDailyPrecipitationProbability,
  buildRollingTemperatureBiasCalibration,
  calculateIssuedForecastMetrics,
  toKmaGrid,
} from "../src/application/index.js";
import { REVIEWED_LOCATION_MAPPINGS } from "../runtime/reviewed-location-mappings.js";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const OUTPUT_DIRECTORY = path.resolve(
  process.cwd(),
  "../product_upgrade_validation/backtest_1y",
);
const HOURLY_VALID_TIMES = Object.freeze(
  Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}00`),
);
const EXTRACT_SCHEMA_VERSION = 2;

const args = parseArgs(process.argv.slice(2));
const to = args.to ?? lastCompletedKstDate(new Date());
const from = args.from ?? to;
const dates = datesInRange(from, to).slice(0, args.limit ?? 365);
if (dates.length === 0 || dates.length > 365) {
  throw new TypeError("Extended forecast verification requires 1 to 365 dates.");
}
const shortLeadDays = args.mediumOnly ? [] : [1, 3];
const shortConcurrency = args.concurrency ?? 2;
const shortRequestDelayMs = args.delayMs ?? 0;

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim() || null;
const apiHubKey = process.env.KMA_API_HUB_AUTH_KEY?.trim() || null;
const observationAdapter = createKmaAsosObservationAdapter({
  enabled: Boolean(serviceKey),
  apiKey: serviceKey,
  timeoutMs: 20_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
});
const shortAdapter = createKmaHistoricalShortForecastAdapter({
  enabled: Boolean(apiHubKey),
  apiKey: apiHubKey,
  timeoutMs: 20_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  providerControl: {
    maxConcurrency: shortConcurrency,
    maxQueue: shortConcurrency * 2,
    failureThreshold: 5,
  },
});
const mediumAdapter = createKmaHistoricalMediumForecastAdapter({
  enabled: Boolean(apiHubKey),
  apiKey: apiHubKey,
  timeoutMs: 20_000,
  cacheFreshForMs: 0,
  contractVersion: VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
});

const locations = Object.entries(REVIEWED_LOCATION_MAPPINGS).map(
  ([areaCode, mapping]) => ({
    areaCode,
    displayName: mapping.displayName,
    stationId: mapping.observationStation.id,
    stationElevationM: Number.isFinite(mapping.observationStation.elevationM)
      ? mapping.observationStation.elevationM
      : null,
    point: {
      id: areaCode,
      ...toKmaGrid(
        mapping.observationStation.latitude,
        mapping.observationStation.longitude,
      ),
    },
    temperatureRegId: mapping.midForecast.temperatureRegId,
    landRegId: mapping.midForecast.landRegId,
  }),
);
const observations = args.observationsCsv
  ? await loadObservationsFromCsv(path.resolve(process.cwd(), args.observationsCsv), locations)
  : await loadObservations({
      adapter: observationAdapter,
      locations,
      from: dates[0],
      to: dates.at(-1),
    });

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const extractPath = path.join(
  OUTPUT_DIRECTORY,
  `extended-forecast-extract-${dates[0]}-${dates.at(-1)}.json`,
);
const existing = await readExtract(extractPath, dates[0], dates.at(-1));
const seed = args.seedFrom
  ? await readExtract(
      path.join(
        OUTPUT_DIRECTORY,
        `extended-forecast-extract-${args.seedFrom}-${args.seedTo}.json`,
      ),
      args.seedFrom,
      args.seedTo,
    )
  : {};
const targetDates = new Set(dates);
const shortRows = mergeRows(
  [...(seed.shortRows ?? []), ...(existing.shortRows ?? [])].filter(
    (row) => targetDates.has(row.validDate) && shortLeadDays.includes(row.leadDays),
  ),
  shortKey,
);
const mediumRows = mergeRows(
  [...(seed.mediumRows ?? []), ...(existing.mediumRows ?? [])].filter(
    (row) => targetDates.has(row.validDate) && row.leadDays === 5,
  ),
  (row) => `${row.validDate}|${row.areaCode}`,
);
// Failures describe this execution only. Cached rows are resumable evidence,
// but a transient provider failure must not remain after a later successful run.
const failures = [];
const shortKeys = new Set(shortRows.map(shortKey));
const mediumKeys = new Set(mediumRows.map((row) => `${row.validDate}|${row.areaCode}`));
// Successful cached rows prove the service permission worked. Cached failures
// never block a new probe after the provider later grants the service.
let mediumPermissionState = mediumRows.length > 0 ? "SUCCESS" : null;

for (const [dateIndex, validDate] of dates.entries()) {
  if (args.reportOnly) continue;
  for (const leadDays of shortLeadDays) {
    const expectedKeys = locations.map((location) =>
      shortKey({ validDate, leadDays, areaCode: location.areaCode }),
    );
    if (expectedKeys.every((key) => shortKeys.has(key))) continue;
    const baseDate = addDays(validDate, -leadDays).replaceAll("-", "");
    const requests = HOURLY_VALID_TIMES.map((validTime) => async () => ({
      validTime,
      envelope: await shortAdapter.getGridSnapshot(
        {
          baseDate,
          baseTime: "1700",
          validDate: validDate.replaceAll("-", ""),
          validTime,
          variable: "POP",
          points: locations.map(({ point }) => point),
        },
        { deadlineAt: Date.now() + 60_000 },
      ),
    }));
    const snapshots = await runBatches(
      requests,
      shortConcurrency,
      shortRequestDelayMs,
    );
    const states = snapshots.map(({ envelope }) => envelope.adapterState);
    if (!states.every((state) => state === "SUCCESS")) {
      failures.push({ source: "SHORT_HOURLY_POP", validDate, leadDays, states });
      continue;
    }
    for (const location of locations) {
      const periods = snapshots.map(({ envelope }) => ({
        validAt: envelope.validFrom,
        precipitationProbability:
          envelope.data.points.find(({ id }) => id === location.areaCode)?.value ?? null,
      }));
      const aggregate = aggregateDailyPrecipitationProbability({
        issuedAt: snapshots[0].envelope.issuedAt,
        validDate,
        periods,
      });
      const row = {
        areaCode: location.areaCode,
        region: location.displayName,
        stationId: location.stationId,
        leadDays,
        issuedAt: aggregate.issuedAt,
        validAt: periods.at(-1).validAt,
        validDate,
        precipitationProbability: aggregate.precipitationProbability,
        hourlyPeriodCount: aggregate.validPeriodCount,
        aggregationState: aggregate.state,
      };
      shortRows.push(row);
      shortKeys.add(shortKey(row));
    }
  }

  const expectedMediumKeys = locations.map(
    (location) => `${validDate}|${location.areaCode}`,
  );
  if (
    mediumPermissionState !== "AUTH_ERROR" &&
    !expectedMediumKeys.every((key) => mediumKeys.has(key))
  ) {
    const baseDate = addDays(validDate, -5).replaceAll("-", "");
    const envelope = await mediumAdapter.getFiveDayForecast(
      {
        baseDate,
        baseTime: "1800",
        targetDate: validDate,
        regions: locations.map((location) => ({
          id: location.areaCode,
          temperatureRegId: location.temperatureRegId,
          landRegId: location.landRegId,
        })),
      },
      { deadlineAt: Date.now() + 60_000 },
    );
    if (envelope.adapterState === "SUCCESS") {
      mediumPermissionState = "SUCCESS";
      for (const location of locations) {
        const point = envelope.data.points.find(({ id }) => id === location.areaCode);
        const row = {
          areaCode: location.areaCode,
          region: location.displayName,
          stationId: location.stationId,
          leadDays: 5,
          issuedAt: envelope.issuedAt,
          validAt: envelope.validTo,
          validDate,
          minTemperature: point?.minTemperature ?? null,
          maxTemperature: point?.maxTemperature ?? null,
          precipitationProbability: point?.precipitationProbability ?? null,
          precipitationPeriodCount: point?.precipitationPeriodCount ?? 0,
        };
        mediumRows.push(row);
        mediumKeys.add(`${validDate}|${location.areaCode}`);
      }
    } else {
      if (mediumRows.length === 0) {
        mediumPermissionState = envelope.adapterState;
      }
      failures.push({
        source: "HISTORICAL_MEDIUM_FIVE_DAY",
        validDate,
        state: envelope.adapterState,
        qualityFlags: envelope.qualityFlags,
      });
    }
  }

  await writeExtract(extractPath, {
    from: dates[0],
    to: dates.at(-1),
    shortRows,
    mediumRows,
    failures,
    mediumPermissionState,
  });
  process.stderr.write(
    `[extended-forecast] ${dateIndex + 1}/${dates.length} dates; short=${shortRows.length}; medium=${mediumRows.length}\n`,
  );
}

const shortMetrics = args.mediumOnly
  ? skippedMetrics()
  : summarizeRows(shortRows, observations, shortLeadDays, dates.length);
const mediumMetrics = summarizeRows(mediumRows, observations, [5], dates.length);
const result = {
  auditKind: "EXTENDED_PRECIPITATION_AND_FIVE_DAY_FORECAST_BACKTEST",
  generatedAt: new Date().toISOString(),
  state: args.mediumOnly
    ? mediumMetrics.state
    : shortMetrics.state === "READY" && mediumMetrics.state === "READY"
      ? "READY"
      : shortMetrics.state !== "HOLD" || mediumMetrics.state !== "HOLD"
        ? "PARTIAL"
        : "HOLD",
  scope: {
    from: dates[0],
    to: dates.at(-1),
    requestedDayCount: dates.length,
    locationCount: locations.length,
    shortLeadDays,
    mediumLeadDays: [5],
    shortConcurrency,
    shortRequestDelayMs,
    reportOnly: args.reportOnly === true,
    dailyPopAggregation: "MAX_OF_24_HOURLY_POP",
  },
  shortHourlyPrecipitation: shortMetrics,
  historicalMediumFiveDay: {
    ...mediumMetrics,
    permissionState: mediumPermissionState,
  },
  guarantees: {
    incompleteHourlyPopScored: false,
    currentForecastSubstitutedForHistoricalIssue: false,
    missingValuesImputed: false,
    credentialsDisclosed: false,
  },
  failures,
  artifacts: { extractJson: repositoryRelativePath(extractPath) },
};
const resultPath = path.join(
  OUTPUT_DIRECTORY,
  `extended-forecast-backtest-${dates[0]}-${dates.at(-1)}.json`,
);
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ ...result, outputPath: repositoryRelativePath(resultPath) }, null, 2)}\n`,
);

async function loadObservations({ adapter, locations: targetLocations, from: start, to: end }) {
  const rows = new Map();
  for (const location of targetLocations) {
    const envelope = await adapter.getDailyRange(
      { stationId: location.stationId, from: start, to: end },
      { deadlineAt: Date.now() + 60_000 },
    );
    rows.set(location.areaCode, envelope.data?.readings ?? []);
  }
  return rows;
}

async function loadObservationsFromCsv(filePath, targetLocations) {
  const records = parseCsv(await readFile(filePath, "utf8"));
  if (records.length === 0) throw new TypeError("Observation CSV is missing its header.");
  const [headers, ...rows] = records;
  const requiredHeaders = [
    "date",
    "area_code",
    "min_temperature_c",
    "max_temperature_c",
    "precipitation_mm",
  ];
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) {
      throw new TypeError(`Observation CSV is missing ${header}.`);
    }
  }
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const allowedAreaCodes = new Set(targetLocations.map(({ areaCode }) => areaCode));
  const deduplicated = new Map();
  for (const row of rows) {
    const areaCode = row[columns.area_code];
    const date = row[columns.date];
    if (!allowedAreaCodes.has(areaCode)) continue;
    const key = `${areaCode}|${date}`;
    const observation = {
      date,
      minTemperature: csvNumberOrNull(row[columns.min_temperature_c]),
      maxTemperature: csvNumberOrNull(row[columns.max_temperature_c]),
      precipitationAmount: csvNumberOrNull(row[columns.precipitation_mm]),
    };
    const existing = deduplicated.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new TypeError(`Observation CSV contains conflicting values for ${key}.`);
    }
    deduplicated.set(key, observation);
  }
  const grouped = new Map(targetLocations.map(({ areaCode }) => [areaCode, []]));
  for (const [key, observation] of deduplicated) {
    grouped.get(key.split("|")[0]).push(observation);
  }
  for (const observationsForArea of grouped.values()) {
    observationsForArea.sort((left, right) => left.date.localeCompare(right.date));
  }
  return grouped;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const normalized = String(text).replace(/^\uFEFF/u, "");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && normalized[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new TypeError("Observation CSV contains an open quote.");
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function csvNumberOrNull(value) {
  if (value === "" || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Invalid CSV number: ${value}`);
  return number;
}

function summarizeRows(rows, observationMap, leadDays, expectedDayCount) {
  const expectedRowCount = expectedDayCount * locations.length * leadDays.length;
  const byLeadLocation = [];
  for (const leadDay of leadDays) {
    for (const location of locations) {
      const locationForecasts = rows
        .filter((row) => row.leadDays === leadDay && row.areaCode === location.areaCode)
        .map((row) => ({
          issuedAt: row.issuedAt,
          validAt: row.validAt,
          validDate: row.validDate,
          minTemperature: row.minTemperature ?? null,
          maxTemperature: row.maxTemperature ?? null,
          precipitationProbability: row.precipitationProbability,
        }));
      const locationObservations = observationMap.get(location.areaCode) ?? [];
      const calculation = calculateIssuedForecastMetrics({
        issuedForecasts: locationForecasts,
        observations: locationObservations,
      });
      const biasCalibration =
        leadDay === 5
          ? summarizeRollingBiasCalibration({
              issuedForecasts: locationForecasts,
              observations: locationObservations,
            })
          : notApplicableBiasCalibration();
      byLeadLocation.push({
        leadDays: leadDay,
        areaCode: location.areaCode,
        region: location.displayName,
        state: calculation.state,
        expectedDayCount,
        forecastDayCount: locationForecasts.length,
        forecastCoverageRatio:
          expectedDayCount === 0 ? 0 : locationForecasts.length / expectedDayCount,
        matchedForecastRatio: calculation.matchedForecastRatio,
        temperature: calculation.temperature,
        precipitation: calculation.precipitation,
        validationSpatialScope: {
          forecastSpatialLevel: "REGIONAL_FORECAST",
          observationSpatialLevel: "ASOS_POINT",
          stationId: location.stationId,
          stationElevationM: location.stationElevationM,
          farmElevationM: null,
          physicalElevationCorrectionApplied: false,
          limitation:
            "REGIONAL_FORECAST_VALIDATED_AGAINST_POINT_ASOS_NOT_FIELD_MICROCLIMATE",
        },
        biasCalibration,
      });
    }
  }
  const precipitationSampleCount = byLeadLocation.reduce(
    (sum, row) => sum + row.precipitation.sampleCount,
    0,
  );
  const temperatureSampleCount = byLeadLocation.reduce(
    (sum, row) =>
      sum +
      row.temperature.minTemperature.sampleCount +
      row.temperature.maxTemperature.sampleCount,
    0,
  );
  const weightedBrier =
    precipitationSampleCount === 0
      ? null
      : byLeadLocation.reduce(
          (sum, row) =>
            sum +
            (row.precipitation.brierScore ?? 0) * row.precipitation.sampleCount,
          0,
        ) / precipitationSampleCount;
  const temperature = {
    minTemperature: combineTemperatureMetrics(byLeadLocation, "minTemperature"),
    maxTemperature: combineTemperatureMetrics(byLeadLocation, "maxTemperature"),
  };
  const biasCalibration = combineBiasCalibration(byLeadLocation);
  const completePrecipitation =
    expectedRowCount > 0 && precipitationSampleCount === expectedRowCount;
  const temperatureExpected = leadDays.some((lead) => lead >= 5);
  const completeTemperature =
    !temperatureExpected || temperatureSampleCount === expectedRowCount * 2;
  return {
    state: completePrecipitation && completeTemperature
      ? "READY"
      : rows.length > 0
        ? "PARTIAL"
        : "HOLD",
    expectedRowCount,
    rowCount: rows.length,
    rowCoverageRatio:
      expectedRowCount === 0 ? 0 : Math.min(1, rows.length / expectedRowCount),
    precipitationSampleCount,
    brierScore: weightedBrier,
    temperatureSampleCount,
    temperature,
    biasCalibration,
    byLeadLocation,
  };
}

function summarizeRollingBiasCalibration({ issuedForecasts, observations }) {
  const calibration = buildRollingTemperatureBiasCalibration({
    issuedForecasts,
    observations,
    minimumTrainingSampleCount: 30,
    rollingWindowDays: 90,
    maximumAbsoluteAdjustmentC: 5,
  });
  const calibratedRows = calibration.rows.filter((row) =>
    ["minTemperature", "maxTemperature"].some(
      (metric) => row.metrics[metric].adjustedValue !== null,
    ),
  );
  const rawComparable = calculateIssuedForecastMetrics({
    issuedForecasts: calibratedRows.map((row) => ({
      issuedAt: row.issuedAt,
      validAt: row.validAt,
      validDate: row.validDate,
      minTemperature: row.metrics.minTemperature.rawValue,
      maxTemperature: row.metrics.maxTemperature.rawValue,
      precipitationProbability: null,
    })),
    observations,
  });
  const adjusted = calculateIssuedForecastMetrics({
    issuedForecasts: calibratedRows.map((row) => ({
      issuedAt: row.issuedAt,
      validAt: row.validAt,
      validDate: row.validDate,
      minTemperature: row.metrics.minTemperature.adjustedValue,
      maxTemperature: row.metrics.maxTemperature.adjustedValue,
      precipitationProbability: null,
    })),
    observations,
  });
  const improvement = Object.fromEntries(
    ["minTemperature", "maxTemperature"].map((metric) => [
      metric,
      temperatureImprovement(
        rawComparable.temperature[metric],
        adjusted.temperature[metric],
      ),
    ]),
  );
  return {
    state: calibration.state,
    method: calibration.method,
    minimumTrainingSampleCount: calibration.minimumTrainingSampleCount,
    rollingWindowDays: calibration.rollingWindowDays,
    maximumAbsoluteAdjustmentC: calibration.maximumAbsoluteAdjustmentC,
    appliedForecastCount: calibration.appliedForecastCount,
    lookAheadPairsUsed: calibration.lookAheadPairsUsed,
    providerValuesMutated: calibration.providerValuesMutated,
    rawTemperatureOnCalibratedPairs: rawComparable.temperature,
    adjustedTemperature: adjusted.temperature,
    improvement,
    deploymentEligibility: Object.fromEntries(
      ["minTemperature", "maxTemperature"].map((metric) => [
        metric,
        calibrationDeploymentEligibility({
          raw: rawComparable.temperature[metric],
          adjusted: adjusted.temperature[metric],
          improvement: improvement[metric],
        }),
      ]),
    ),
  };
}

function temperatureImprovement(raw, adjusted) {
  return {
    meanAbsoluteErrorReduction:
      raw.meanAbsoluteError === null || adjusted.meanAbsoluteError === null
        ? null
        : raw.meanAbsoluteError - adjusted.meanAbsoluteError,
    rootMeanSquaredErrorReduction:
      raw.rootMeanSquaredError === null || adjusted.rootMeanSquaredError === null
        ? null
        : raw.rootMeanSquaredError - adjusted.rootMeanSquaredError,
  };
}

function calibrationDeploymentEligibility({ raw, adjusted, improvement }) {
  const reasons = [];
  if (adjusted.sampleCount < 180) reasons.push("FEWER_THAN_180_OUT_OF_SAMPLE_PAIRS");
  if (
    improvement.meanAbsoluteErrorReduction === null ||
    improvement.meanAbsoluteErrorReduction < 0.1
  ) {
    reasons.push("MAE_REDUCTION_BELOW_0_1C");
  }
  if (
    improvement.rootMeanSquaredErrorReduction === null ||
    improvement.rootMeanSquaredErrorReduction < 0.1
  ) {
    reasons.push("RMSE_REDUCTION_BELOW_0_1C");
  }
  if (
    raw.bias === null ||
    adjusted.bias === null ||
    Math.abs(adjusted.bias) >= Math.abs(raw.bias)
  ) {
    reasons.push("ABSOLUTE_BIAS_NOT_REDUCED");
  }
  return {
    eligible: reasons.length === 0,
    activationState: reasons.length === 0 ? "VALIDATED_CANDIDATE" : "RAW_ONLY",
    reasons,
  };
}

function notApplicableBiasCalibration() {
  return {
    state: "NOT_APPLICABLE",
    method: null,
    appliedForecastCount: 0,
    lookAheadPairsUsed: 0,
    providerValuesMutated: false,
    rawTemperatureOnCalibratedPairs: null,
    adjustedTemperature: null,
    improvement: null,
    deploymentEligibility: null,
  };
}

function combineBiasCalibration(rows) {
  const applicable = rows.filter(
    ({ biasCalibration }) => biasCalibration.state !== "NOT_APPLICABLE",
  );
  if (applicable.length === 0) return notApplicableBiasCalibration();
  const metricRows = (field) =>
    applicable
      .filter(({ biasCalibration }) => biasCalibration[field] !== null)
      .map(({ biasCalibration }) => ({ temperature: biasCalibration[field] }));
  const rawRows = metricRows("rawTemperatureOnCalibratedPairs");
  const adjustedRows = metricRows("adjustedTemperature");
  const rawTemperatureOnCalibratedPairs = Object.fromEntries(
    ["minTemperature", "maxTemperature"].map((metric) => [
      metric,
      combineTemperatureMetrics(rawRows, metric),
    ]),
  );
  const adjustedTemperature = Object.fromEntries(
    ["minTemperature", "maxTemperature"].map((metric) => [
      metric,
      combineTemperatureMetrics(adjustedRows, metric),
    ]),
  );
  return {
    state: applicable.some(({ biasCalibration }) =>
      ["READY", "PARTIAL"].includes(biasCalibration.state),
    )
      ? "READY"
      : "WARMUP",
    method: "ROLLING_MEAN_ERROR_SUBTRACTION",
    minimumTrainingSampleCount: 30,
    rollingWindowDays: 90,
    maximumAbsoluteAdjustmentC: 5,
    appliedForecastCount: applicable.reduce(
      (sum, { biasCalibration }) => sum + biasCalibration.appliedForecastCount,
      0,
    ),
    lookAheadPairsUsed: 0,
    providerValuesMutated: false,
    rawTemperatureOnCalibratedPairs,
    adjustedTemperature,
    improvement: Object.fromEntries(
      ["minTemperature", "maxTemperature"].map((metric) => [
        metric,
        temperatureImprovement(
          rawTemperatureOnCalibratedPairs[metric],
          adjustedTemperature[metric],
        ),
      ]),
    ),
    deploymentEligibility: null,
  };
}

function combineTemperatureMetrics(rows, metric) {
  const usable = rows
    .map((row) => row.temperature[metric])
    .filter(({ sampleCount }) => sampleCount > 0);
  const sampleCount = usable.reduce((sum, row) => sum + row.sampleCount, 0);
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
    meanAbsoluteError:
      usable.reduce(
        (sum, row) => sum + row.meanAbsoluteError * row.sampleCount,
        0,
      ) / sampleCount,
    rootMeanSquaredError: Math.sqrt(
      usable.reduce(
        (sum, row) => sum + row.rootMeanSquaredError ** 2 * row.sampleCount,
        0,
      ) / sampleCount,
    ),
    bias:
      usable.reduce((sum, row) => sum + row.bias * row.sampleCount, 0) /
      sampleCount,
  };
}

function skippedMetrics() {
  return {
    state: "SKIPPED",
    rowCount: 0,
    precipitationSampleCount: 0,
    brierScore: null,
    temperatureSampleCount: 0,
    temperature: {
      minTemperature: {
        sampleCount: 0,
        meanAbsoluteError: null,
        rootMeanSquaredError: null,
        bias: null,
      },
      maxTemperature: {
        sampleCount: 0,
        meanAbsoluteError: null,
        rootMeanSquaredError: null,
        bias: null,
      },
    },
    biasCalibration: notApplicableBiasCalibration(),
    byLeadLocation: [],
  };
}

async function runBatches(tasks, batchSize, delayMs = 0) {
  const results = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    results.push(...(await Promise.all(tasks.slice(index, index + batchSize).map((task) => task()))));
    if (delayMs > 0 && index + batchSize < tasks.length) {
      await delay(delayMs);
    }
  }
  return results;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readExtract(filePath, fromDate, toDate) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed.schemaVersion === EXTRACT_SCHEMA_VERSION && parsed.from === fromDate && parsed.to === toDate
      ? parsed
      : {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {};
  }
}

async function writeExtract(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify({ schemaVersion: EXTRACT_SCHEMA_VERSION, ...payload }, null, 2)}\n`, "utf8");
}

function shortKey({ validDate, leadDays, areaCode }) {
  return `${validDate}|${leadDays}|${areaCode}`;
}

function mergeRows(rows, keyFor) {
  return [...new Map(rows.map((row) => [keyFor(row), row])).values()];
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (value === "--medium-only") parsed.mediumOnly = true;
    if (value === "--report-only") parsed.reportOnly = true;
    const date = /^--(from|to)=(\d{4}-\d{2}-\d{2})$/u.exec(value);
    if (date) parsed[date[1]] = date[2];
    const limit = /^--limit=(\d+)$/u.exec(value);
    if (limit) parsed.limit = Number(limit[1]);
    const concurrency = /^--concurrency=(\d+)$/u.exec(value);
    if (concurrency) parsed.concurrency = Number(concurrency[1]);
    const delayMatch = /^--delay-ms=(\d+)$/u.exec(value);
    if (delayMatch) parsed.delayMs = Number(delayMatch[1]);
    const seedDate = /^--seed-(from|to)=(\d{4}-\d{2}-\d{2})$/u.exec(value);
    if (seedDate) parsed[`seed${seedDate[1] === 'from' ? 'From' : 'To'}`] = seedDate[2];
    const observationsCsv = /^--observations-csv=(.+)$/u.exec(value);
    if (observationsCsv) parsed.observationsCsv = observationsCsv[1];
  }
  if (
    parsed.concurrency !== undefined &&
    (!Number.isInteger(parsed.concurrency) ||
      parsed.concurrency < 1 ||
      parsed.concurrency > 8)
  ) {
    throw new TypeError('--concurrency must be an integer between 1 and 8.');
  }
  if (
    parsed.delayMs !== undefined &&
    (!Number.isInteger(parsed.delayMs) ||
      parsed.delayMs < 0 ||
      parsed.delayMs > 5_000)
  ) {
    throw new TypeError('--delay-ms must be an integer between 0 and 5000.');
  }
  if ((parsed.seedFrom === undefined) !== (parsed.seedTo === undefined)) {
    throw new TypeError('--seed-from and --seed-to must be supplied together.');
  }
  if (parsed.seedFrom && parsed.seedFrom > parsed.seedTo) {
    throw new TypeError('--seed-from must not be later than --seed-to.');
  }
  return parsed;
}

function datesInRange(fromDate, toDate) {
  const rows = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) rows.push(date);
  return rows;
}

function addDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function lastCompletedKstDate(date) {
  const today = new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
  return addDays(today, -1);
}

function repositoryRelativePath(targetPath) {
  return path.relative(path.resolve(process.cwd(), ".."), targetPath);
}
