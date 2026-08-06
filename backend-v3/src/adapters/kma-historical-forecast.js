import {
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import { InMemoryAdapterCache, SingleFlight, makeAdapterCacheKey } from "./cache.js";
import { SchemaChangedError } from "./errors.js";
import { requestProviderText } from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import { kmaDateTimeToIso } from "./strict-values.js";

const HISTORICAL_SHORT_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-dfs_shrt_grd";
const KMA_GRID_WIDTH = 149;
const KMA_GRID_HEIGHT = 253;
const KMA_GRID_CELL_COUNT = KMA_GRID_WIDTH * KMA_GRID_HEIGHT;
const MISSING_GRID_VALUE = -99;
const SUPPORTED_VARIABLES = Object.freeze(
  new Set([
    "TMP",
    "TMX",
    "TMN",
    "UUU",
    "VVV",
    "VEC",
    "WSD",
    "SKY",
    "PTY",
    "POP",
    "PCP",
    "SNO",
    "REH",
    "WAV"
  ])
);

const VARIABLE_UNITS = Object.freeze({
  TMP: "celsius",
  TMX: "celsius",
  TMN: "celsius",
  UUU: "m/s",
  VVV: "m/s",
  VEC: "degree",
  WSD: "m/s",
  SKY: "code",
  PTY: "code",
  POP: "percent",
  PCP: "mm",
  SNO: "cm",
  REH: "percent",
  WAV: "m"
});

function clockMs(now) {
  return new Date(now()).getTime();
}

function appendQuery(url, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
}

function requireVariable(value) {
  if (typeof value !== "string" || !SUPPORTED_VARIABLES.has(value)) {
    throw new TypeError("KMA historical grid variable is not supported.");
  }
  return value;
}

function normalizePoints(points) {
  if (!Array.isArray(points) || points.length === 0 || points.length > 100) {
    throw new TypeError("KMA historical grid requires 1 to 100 points.");
  }
  const ids = new Set();
  return points.map((point, index) => {
    if (point === null || typeof point !== "object" || Array.isArray(point)) {
      throw new TypeError(`KMA historical grid point ${index} must be an object.`);
    }
    const id = String(point.id ?? "").trim();
    if (!id || ids.has(id)) {
      throw new TypeError("KMA historical grid point ids must be unique.");
    }
    if (
      !Number.isInteger(point.nx) ||
      point.nx < 1 ||
      point.nx > KMA_GRID_WIDTH ||
      !Number.isInteger(point.ny) ||
      point.ny < 1 ||
      point.ny > KMA_GRID_HEIGHT
    ) {
      throw new TypeError("KMA historical grid point is outside the official grid.");
    }
    ids.add(id);
    return Object.freeze({ id, nx: point.nx, ny: point.ny });
  });
}

function gridIndex({ nx, ny }) {
  return (ny - 1) * KMA_GRID_WIDTH + (nx - 1);
}

function parsedGridNumber(token) {
  if (typeof token !== "string" || token.trim() === "") return null;
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new SchemaChangedError("Historical forecast grid contains a non-number.");
  }
  return value <= MISSING_GRID_VALUE ? null : value;
}

export function parseKmaHistoricalGrid(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new SchemaChangedError("Historical forecast grid response is empty.");
  }
  const tokens = text.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length !== KMA_GRID_CELL_COUNT) {
    throw new SchemaChangedError(
      `Historical forecast grid expected ${KMA_GRID_CELL_COUNT} cells but received ${tokens.length}.`
    );
  }
  return tokens.map(parsedGridNumber);
}

function selectedPointValues(grid, points) {
  return points.map((point) => ({
    ...point,
    value: grid[gridIndex(point)]
  }));
}

/**
 * Reads a grid snapshot that was actually issued at a historical KMA base
 * time. The endpoint returns all 37,697 cells, so one response is shared by
 * every reviewed location in the backtest.
 */
export function createKmaHistoricalShortForecastAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = HISTORICAL_SHORT_ENDPOINT,
  timeoutMs = 20_000,
  adapterVersion = "2",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 24 * 60 * 60 * 1000,
  now = () => new Date()
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new TypeError(
      "KMA historical short cacheFreshForMs must be between 0 and 604800000ms."
    );
  }

  const cacheClock = () => clockMs(now);
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 100,
      maxTtlMs: 7 * 24 * 60 * 60 * 1000,
      now: cacheClock
    });
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
      now: providerControl.now ?? cacheClock
    });
  const envelopeBase = {
    sourceId: "kma-historical-short-forecast-grid",
    sourceName: "기상청 과거 발행 단기예보 격자자료",
    sourceUrl: HISTORICAL_SHORT_ENDPOINT,
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FORECAST_GRID",
    spatialLabel: "과거 단기예보 5km 격자",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "kma-historical-short-forecast-grid",
      adapterVersion,
      operationId: "get-historical-short-grid-snapshot",
      contractVersion,
      providerIssueTime: null
    }
  };

  return Object.freeze({
    id: "kmaHistoricalShort",
    async getGridSnapshot(
      {
        baseDate,
        baseTime,
        validDate,
        validTime,
        variable,
        points
      } = {},
      { signal, deadlineAt } = {}
    ) {
      let issueTime = null;
      let forecastTime = null;
      try {
        issueTime = kmaDateTimeToIso(baseDate, baseTime, {
          field: "KMA historical base time"
        });
        forecastTime = kmaDateTimeToIso(validDate, validTime, {
          field: "KMA historical valid time"
        });
      } catch {
        // Input validation is contained by the adapter envelope below.
      }
      const pointKey = Array.isArray(points)
        ? points.map(({ id, nx, ny }) => ({ id, nx, ny }))
        : points ?? null;
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-historical-short-grid-snapshot",
        verifiedLocationKey: pointKey,
        requestedPeriod: { validDate: validDate ?? null },
        providerIssueTime: issueTime,
        normalizedParameters: {
          contractVersion,
          validTime: forecastTime,
          variable: variable ?? null
        }
      });

      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION
        ],
        envelopeBase,
        cache: liveCache,
        singleFlight: liveSingleFlight,
        executionGuard: liveExecutionGuard,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        operation: async ({
          signal: upstreamSignal,
          deadlineAt: upstreamDeadlineAt
        }) => {
          const normalizedPoints = normalizePoints(points);
          const normalizedVariable = requireVariable(variable);
          const issuedAt = kmaDateTimeToIso(baseDate, baseTime, {
            field: "KMA historical base time"
          });
          const validAt = kmaDateTimeToIso(validDate, validTime, {
            field: "KMA historical valid time"
          });
          if (Date.parse(issuedAt) >= Date.parse(validAt)) {
            throw new TypeError(
              "KMA historical forecast must be issued before its valid time."
            );
          }
          const url = new URL(endpoint);
          appendQuery(url, {
            tmfc: `${baseDate}${baseTime.slice(0, 2)}`,
            tmef: `${validDate}${validTime.slice(0, 2)}`,
            vars: normalizedVariable,
            authKey: apiKey.trim()
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
            maxResponseBytes: 512 * 1024
          });
          const selected = selectedPointValues(
            parseKmaHistoricalGrid(text),
            normalizedPoints
          );
          const missingCount = selected.filter(({ value }) => value === null).length;
          return {
            adapterState:
              missingCount === selected.length ? "NO_DATA" : "SUCCESS",
            issuedAt,
            validFrom: validAt,
            validTo: validAt,
            unit: VARIABLE_UNITS[normalizedVariable],
            provenance: {
              ...envelopeBase.provenance,
              providerIssueTime: issuedAt
            },
            qualityFlags: [
              "KMA_HISTORICAL_SHORT_GRID",
              ...(missingCount > 0 ? ["MISSING_GRID_VALUES"] : [])
            ],
            data: {
              dataRole: "HISTORICAL_ISSUED_FORECAST_GRID_SNAPSHOT",
              variable: normalizedVariable,
              validAt,
              gridWidth: KMA_GRID_WIDTH,
              gridHeight: KMA_GRID_HEIGHT,
              points: selected
            }
          };
        }
      });
    }
  });
}

export {
  HISTORICAL_SHORT_ENDPOINT,
  KMA_GRID_CELL_COUNT,
  KMA_GRID_HEIGHT,
  KMA_GRID_WIDTH
};
