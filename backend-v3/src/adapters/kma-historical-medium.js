import {
  VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
  runCachedAdapterCall,
} from "./adapter-call.js";
import { InMemoryAdapterCache, SingleFlight, makeAdapterCacheKey } from "./cache.js";
import { SchemaChangedError } from "./errors.js";
import { requestProviderText } from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import { kmaDateTimeToIso } from "./strict-values.js";

const HISTORICAL_MID_TEMPERATURE_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ01/url/fct_afs_wc.php";
const HISTORICAL_MID_LAND_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ01/url/fct_afs_wl.php";
const REQUIRED_COLUMNS = Object.freeze({
  TEMPERATURE: Object.freeze(["REG_ID", "TM_FC", "TM_EF", "MIN", "MAX"]),
  LAND: Object.freeze(["REG_ID", "TM_FC", "TM_EF", "RN_ST"]),
});

function appendQuery(url, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
}

function clockMs(now) {
  return new Date(now()).getTime();
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new SchemaChangedError("Historical medium CSV has an open quote.");
  cells.push(current.trim());
  return cells;
}

function columns(line) {
  const normalized = line.trim().replace(/^#+\s*/u, "");
  return normalized.includes(",")
    ? splitCsvLine(normalized)
    : normalized.split(/\s+/u);
}

function finiteOrNull(value, field, { min, max }) {
  const text = String(value ?? "").trim();
  if (text === "" || text === "-" || text === "-99") return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new SchemaChangedError(`${field} is outside its documented range.`);
  }
  return number;
}

function compactIssue(value) {
  const text = String(value ?? "").trim().replace(/[^0-9]/gu, "");
  if (!/^\d{10}(?:\d{2})?$/u.test(text)) {
    throw new SchemaChangedError("Historical medium issue time is invalid.");
  }
  return kmaDateTimeToIso(text.slice(0, 8), `${text.slice(8, 10)}${text.slice(10, 12) || "00"}`, {
    field: "KMA historical medium issue time",
  });
}

function compactValid(value) {
  const text = String(value ?? "").trim().replace(/[^0-9]/gu, "");
  if (!/^\d{8}(?:\d{2}(?:\d{2})?)?$/u.test(text)) {
    throw new SchemaChangedError("Historical medium valid time is invalid.");
  }
  return {
    date: `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`,
    instant: kmaDateTimeToIso(
      text.slice(0, 8),
      `${text.slice(8, 10) || "00"}${text.slice(10, 12) || "00"}`,
      { field: "KMA historical medium valid time" },
    ),
  };
}

export function parseKmaHistoricalMediumTable(text, { kind } = {}) {
  const required = REQUIRED_COLUMNS[kind];
  if (!required) throw new TypeError("Historical medium kind is invalid.");
  if (typeof text !== "string" || !text.includes("#START7777")) {
    throw new SchemaChangedError("Historical medium response is missing its marker.");
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  const headerLine = lines.find((line) => {
    const fields = columns(line);
    return required.every((field) => fields.includes(field));
  });
  if (!headerLine) {
    throw new SchemaChangedError("Historical medium response is missing columns.");
  }
  const header = columns(headerLine);
  const rows = lines
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line, index) => {
      const values = columns(line);
      // The live typ01 API appends one undocumented `,=` record terminator.
      // Accept only that exact extra cell; any other drift remains fail-closed.
      if (values.length === header.length + 1 && values.at(-1) === "=") {
        values.pop();
      }
      if (values.length !== header.length) {
        throw new SchemaChangedError(
          `Historical medium row ${index} does not match its CSV header.`,
        );
      }
      return Object.fromEntries(header.map((field, column) => [field, values[column]]));
    })
    .map((row) => {
      const valid = compactValid(row.TM_EF);
      return Object.freeze({
        regionId: String(row.REG_ID ?? "").trim(),
        issuedAt: compactIssue(row.TM_FC),
        validDate: valid.date,
        validAt: valid.instant,
        periodMode: String(row.MOD ?? "").trim() || null,
        minTemperature:
          kind === "TEMPERATURE"
            ? finiteOrNull(row.MIN, "Historical medium MIN", { min: -100, max: 100 })
            : null,
        maxTemperature:
          kind === "TEMPERATURE"
            ? finiteOrNull(row.MAX, "Historical medium MAX", { min: -100, max: 100 })
            : null,
        precipitationProbability:
          kind === "LAND"
            ? finiteOrNull(row.RN_ST, "Historical medium RN_ST", { min: 0, max: 100 })
            : null,
      });
    });
  if (rows.some(({ regionId }) => !/^[0-9]{2}[A-Z][0-9]{5}$/u.test(regionId))) {
    throw new SchemaChangedError("Historical medium response has an invalid region ID.");
  }
  return Object.freeze(rows);
}

function normalizeRegions(regions) {
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > 100) {
    throw new TypeError("Historical medium regions must contain 1 to 100 rows.");
  }
  const ids = new Set();
  return regions.map((region, index) => {
    const id = String(region?.id ?? "").trim();
    const temperatureRegId = String(region?.temperatureRegId ?? "").trim();
    const landRegId = String(region?.landRegId ?? "").trim();
    if (
      !id ||
      ids.has(id) ||
      !/^11[0-9A-Z]{6}$/u.test(temperatureRegId) ||
      !/^11[0-9A-Z]{6}$/u.test(landRegId)
    ) {
      throw new TypeError(`Historical medium region ${index} is invalid.`);
    }
    ids.add(id);
    return Object.freeze({ id, temperatureRegId, landRegId });
  });
}

function joinRegions({ temperatureRows, landRows, regions, targetDate }) {
  return regions.map((region) => {
    const temperatures = temperatureRows.filter(
      (row) => row.regionId === region.temperatureRegId && row.validDate === targetDate,
    );
    const land = landRows.filter(
      (row) => row.regionId === region.landRegId && row.validDate === targetDate,
    );
    const minimums = temperatures.map(({ minTemperature }) => minTemperature).filter(Number.isFinite);
    const maximums = temperatures.map(({ maxTemperature }) => maxTemperature).filter(Number.isFinite);
    const precipitation = land
      .map(({ precipitationProbability }) => precipitationProbability)
      .filter(Number.isFinite);
    return Object.freeze({
      id: region.id,
      temperatureRegId: region.temperatureRegId,
      landRegId: region.landRegId,
      minTemperature: minimums.length > 0 ? Math.min(...minimums) : null,
      maxTemperature: maximums.length > 0 ? Math.max(...maximums) : null,
      precipitationProbability:
        precipitation.length > 0 ? Math.max(...precipitation) : null,
      precipitationPeriodCount: precipitation.length,
    });
  });
}

export function createKmaHistoricalMediumForecastAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  temperatureEndpoint = HISTORICAL_MID_TEMPERATURE_ENDPOINT,
  landEndpoint = HISTORICAL_MID_LAND_ENDPOINT,
  timeoutMs = 20_000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 24 * 60 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  const cacheClock = () => clockMs(now);
  const liveCache =
    cache ?? new InMemoryAdapterCache({ maxEntries: 100, maxTtlMs: 7 * 24 * 60 * 60 * 1000, now: cacheClock });
  const liveSingleFlight = singleFlight ?? new SingleFlight();
  const liveExecutionGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 2,
      maxQueue: 4,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "KMA",
      now: providerControl.now ?? cacheClock,
    });
  const envelopeBase = {
    sourceId: "kma-historical-medium-forecast",
    sourceName: "기상청 과거 발행 중기예보",
    sourceUrl: "https://apihub.kma.go.kr/apiInfo.do",
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FORECAST_REGION",
    spatialLabel: "중기예보 구역",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "kma-historical-medium-forecast",
      adapterVersion,
      operationId: "get-historical-medium-five-day",
      contractVersion,
      providerIssueTime: null,
    },
  };

  return Object.freeze({
    id: "kmaHistoricalMid",
    async getFiveDayForecast(
      { baseDate, baseTime = "1800", targetDate, regions } = {},
      { signal, deadlineAt } = {},
    ) {
      const regionKey = Array.isArray(regions)
        ? regions.map(({ id, temperatureRegId, landRegId }) => ({ id, temperatureRegId, landRegId }))
        : regions ?? null;
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-historical-medium-five-day",
        verifiedLocationKey: regionKey,
        requestedPeriod: { targetDate: targetDate ?? null },
        providerIssueTime: `${baseDate ?? ""}${baseTime ?? ""}`,
        normalizedParameters: { contractVersion },
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION],
        envelopeBase,
        cache: liveCache,
        singleFlight: liveSingleFlight,
        executionGuard: liveExecutionGuard,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        operation: async ({ signal: upstreamSignal, deadlineAt: upstreamDeadlineAt }) => {
          const normalizedRegions = normalizeRegions(regions);
          const issuedAt = kmaDateTimeToIso(baseDate, baseTime, {
            field: "KMA historical medium base time",
          });
          const compactIssue = `${baseDate}${baseTime}`;
          const compactTarget = String(targetDate ?? "").replaceAll("-", "");
          if (!/^\d{8}$/u.test(compactTarget)) {
            throw new TypeError("Historical medium targetDate must be an ISO date.");
          }
          const request = async (endpoint, kind) => {
            const url = new URL(endpoint);
            appendQuery(url, {
              tmfc1: compactIssue,
              tmfc2: compactIssue,
              tmef1: compactTarget,
              tmef2: compactTarget,
              disp: 1,
              help: 1,
              authKey: apiKey.trim(),
            });
            const text = await requestProviderText({
              fetchImpl,
              url,
              provider: "KMA",
              requestInit: { headers: { Accept: "text/plain" } },
              signal: upstreamSignal,
              timeoutMs,
              deadlineAt: upstreamDeadlineAt,
              now: cacheClock,
              maxResponseBytes: 2 * 1024 * 1024,
            });
            return parseKmaHistoricalMediumTable(text, { kind });
          };
          const [temperatureRows, landRows] = await Promise.all([
            request(temperatureEndpoint, "TEMPERATURE"),
            request(landEndpoint, "LAND"),
          ]);
          const points = joinRegions({
            temperatureRows,
            landRows,
            regions: normalizedRegions,
            targetDate: `${compactTarget.slice(0, 4)}-${compactTarget.slice(4, 6)}-${compactTarget.slice(6, 8)}`,
          });
          const usableCount = points.filter(
            (point) =>
              Number.isFinite(point.minTemperature) ||
              Number.isFinite(point.maxTemperature) ||
              Number.isFinite(point.precipitationProbability),
          ).length;
          const validFrom = kmaDateTimeToIso(compactTarget, "0000", {
            field: "KMA historical medium target time",
          });
          const validTo = new Date(
            new Date(validFrom).getTime() + 24 * 60 * 60 * 1000 - 1000,
          ).toISOString();
          return {
            adapterState: usableCount > 0 ? "SUCCESS" : "NO_DATA",
            issuedAt,
            validFrom,
            validTo,
            provenance: { ...envelopeBase.provenance, providerIssueTime: issuedAt },
            qualityFlags: [
              "KMA_HISTORICAL_MEDIUM_TYP01",
              ...(usableCount < points.length ? ["MISSING_REGION_VALUES"] : []),
            ],
            data: {
              dataRole: "HISTORICAL_ISSUED_MEDIUM_FORECAST",
              targetDate: `${compactTarget.slice(0, 4)}-${compactTarget.slice(4, 6)}-${compactTarget.slice(6, 8)}`,
              points,
            },
          };
        },
      });
    },
  });
}

export {
  HISTORICAL_MID_LAND_ENDPOINT,
  HISTORICAL_MID_TEMPERATURE_ENDPOINT,
};
