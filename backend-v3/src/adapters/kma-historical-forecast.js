import {
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import { InMemoryAdapterCache, SingleFlight, makeAdapterCacheKey } from "./cache.js";
import { SchemaChangedError } from "./errors.js";
import { parseKmaShortForecast } from "./kma.js";
import { requestProviderJson } from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import { kmaDateTimeToIso } from "./strict-values.js";

const HISTORICAL_SHORT_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst";

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

function dateRange(days) {
  if (days.length === 0) {
    return { issuedAt: null, validFrom: null, validTo: null };
  }
  const issueTimes = [...new Set(days.map((day) => day.issueTime))];
  if (issueTimes.length !== 1) {
    throw new SchemaChangedError(
      "Historical forecast response contains mixed issue times."
    );
  }
  const byTime = (left, right) => Date.parse(left) - Date.parse(right);
  return {
    issuedAt: issueTimes[0],
    validFrom: days.map((day) => day.validFrom).sort(byTime)[0],
    validTo: days.map((day) => day.validTo).sort(byTime).at(-1)
  };
}

function allDayQualityFlags(days) {
  return [...new Set(days.flatMap((day) => day.qualityFlags ?? []))];
}

/**
 * Reads the forecast that was actually issued at a historical base date/time.
 * This adapter is deliberately separate from the operational data.go.kr
 * adapter so a current forecast can never be substituted in a backtest.
 */
export function createKmaHistoricalShortForecastAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = HISTORICAL_SHORT_ENDPOINT,
  timeoutMs = 10_000,
  adapterVersion = "1",
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
    sourceId: "kma-historical-short-forecast",
    sourceName: "기상청 과거 발행 단기예보",
    sourceUrl: HISTORICAL_SHORT_ENDPOINT,
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FORECAST_GRID",
    spatialLabel: "과거 단기예보 격자",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "kma-historical-short-forecast",
      adapterVersion,
      operationId: "get-historical-vilage-forecast",
      contractVersion,
      providerIssueTime: null
    }
  };

  return Object.freeze({
    id: "kmaHistoricalShort",
    async getIssuedForecast(
      { nx, ny, baseDate, baseTime, pageNo = 1, numOfRows = 1000 } = {},
      { signal, deadlineAt } = {}
    ) {
      let issueTime = null;
      try {
        issueTime = kmaDateTimeToIso(baseDate, baseTime, {
          field: "KMA historical base time"
        });
      } catch {
        // Input validation is contained by the adapter envelope below.
      }
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-historical-vilage-forecast",
        verifiedLocationKey: { nx: nx ?? null, ny: ny ?? null },
        requestedPeriod: { baseDate: baseDate ?? null },
        providerIssueTime: issueTime,
        normalizedParameters: { contractVersion, pageNo, numOfRows }
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
          if (
            !Number.isInteger(nx) ||
            !Number.isInteger(ny) ||
            nx < 1 ||
            ny < 1
          ) {
            throw new TypeError(
              "KMA historical forecast requires positive nx and ny."
            );
          }
          kmaDateTimeToIso(baseDate, baseTime, {
            field: "KMA historical base time"
          });
          const url = new URL(endpoint);
          appendQuery(url, {
            authKey: apiKey.trim(),
            pageNo,
            numOfRows,
            dataType: "JSON",
            base_date: baseDate,
            base_time: baseTime,
            nx,
            ny
          });
          const payload = await requestProviderJson({
            fetchImpl,
            url,
            provider: "KMA",
            requestInit: { headers: { Accept: "application/json" } },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock
          });
          const days = parseKmaShortForecast(payload);
          const range = dateRange(days);
          return {
            adapterState: days.length === 0 ? "NO_DATA" : "SUCCESS",
            ...range,
            provenance: {
              ...envelopeBase.provenance,
              providerIssueTime: range.issuedAt
            },
            qualityFlags: allDayQualityFlags(days),
            data: {
              dataRole: "HISTORICAL_ISSUED_FORECAST",
              days
            }
          };
        }
      });
    }
  });
}

export { HISTORICAL_SHORT_ENDPOINT };
