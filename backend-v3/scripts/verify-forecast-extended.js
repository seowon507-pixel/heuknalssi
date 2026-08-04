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

const args = parseArgs(process.argv.slice(2));
const to = args.to ?? lastCompletedKstDate(new Date());
const from = args.from ?? to;
const dates = datesInRange(from, to).slice(0, args.limit ?? 365);
if (dates.length === 0 || dates.length > 365) {
  throw new TypeError("Extended forecast verification requires 1 to 365 dates.");
}

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
  providerControl: { maxConcurrency: 2, maxQueue: 4, failureThreshold: 5 },
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
const observations = await loadObservations({
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
const shortRows = existing.shortRows ?? [];
const mediumRows = existing.mediumRows ?? [];
// Failures describe this execution only. Cached rows are resumable evidence,
// but a transient provider failure must not remain after a later successful run.
const failures = [];
const shortKeys = new Set(shortRows.map(shortKey));
const mediumKeys = new Set(mediumRows.map((row) => `${row.validDate}|${row.areaCode}`));
// Re-probe once per execution so a previously cached 403 does not keep the
// medium forecast disabled after the provider grants the requested service.
let mediumPermissionState = null;

for (const [dateIndex, validDate] of dates.entries()) {
  for (const leadDays of [1, 3]) {
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
    const snapshots = await runBatches(requests, 2);
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
    mediumPermissionState = envelope.adapterState;
    if (envelope.adapterState === "SUCCESS") {
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

const shortMetrics = summarizeRows(shortRows, observations, [1, 3]);
const mediumMetrics = summarizeRows(mediumRows, observations, [5]);
const result = {
  auditKind: "EXTENDED_PRECIPITATION_AND_FIVE_DAY_FORECAST_BACKTEST",
  generatedAt: new Date().toISOString(),
  state:
    shortMetrics.state === "READY" && mediumMetrics.state === "READY"
      ? "READY"
      : shortMetrics.state !== "HOLD" || mediumMetrics.state !== "HOLD"
        ? "PARTIAL"
        : "HOLD",
  scope: {
    from: dates[0],
    to: dates.at(-1),
    requestedDayCount: dates.length,
    locationCount: locations.length,
    shortLeadDays: [1, 3],
    mediumLeadDays: [5],
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

function summarizeRows(rows, observationMap, leadDays) {
  const byLeadLocation = [];
  for (const leadDay of leadDays) {
    for (const location of locations) {
      const calculation = calculateIssuedForecastMetrics({
        issuedForecasts: rows
          .filter((row) => row.leadDays === leadDay && row.areaCode === location.areaCode)
          .map((row) => ({
            issuedAt: row.issuedAt,
            validAt: row.validAt,
            validDate: row.validDate,
            minTemperature: row.minTemperature ?? null,
            maxTemperature: row.maxTemperature ?? null,
            precipitationProbability: row.precipitationProbability,
          })),
        observations: observationMap.get(location.areaCode) ?? [],
      });
      byLeadLocation.push({
        leadDays: leadDay,
        areaCode: location.areaCode,
        region: location.displayName,
        state: calculation.state,
        matchedForecastRatio: calculation.matchedForecastRatio,
        temperature: calculation.temperature,
        precipitation: calculation.precipitation,
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
  return {
    state:
      precipitationSampleCount > 0 &&
      (leadDays.every((lead) => lead < 5) || temperatureSampleCount > 0)
        ? "READY"
        : rows.length > 0
          ? "PARTIAL"
          : "HOLD",
    rowCount: rows.length,
    precipitationSampleCount,
    brierScore: weightedBrier,
    temperatureSampleCount,
    byLeadLocation,
  };
}

async function runBatches(tasks, batchSize) {
  const results = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    results.push(...(await Promise.all(tasks.slice(index, index + batchSize).map((task) => task()))));
  }
  return results;
}

async function readExtract(filePath, fromDate, toDate) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed.schemaVersion === 1 && parsed.from === fromDate && parsed.to === toDate
      ? parsed
      : {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {};
  }
}

async function writeExtract(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify({ schemaVersion: 1, ...payload }, null, 2)}\n`, "utf8");
}

function shortKey({ validDate, leadDays, areaCode }) {
  return `${validDate}|${leadDays}|${areaCode}`;
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    const date = /^--(from|to)=(\d{4}-\d{2}-\d{2})$/u.exec(value);
    if (date) parsed[date[1]] = date[2];
    const limit = /^--limit=(\d+)$/u.exec(value);
    if (limit) parsed.limit = Number(limit[1]);
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
