import {
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  makeAdapterCacheKey
} from "./cache.js";
import { createUnavailableEnvelope } from "./data-envelope.js";
import {
  AdapterError,
  NoDataError,
  SchemaChangedError
} from "./errors.js";
import { requestProviderJson } from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import {
  parseStrictFiniteNumber,
  requireNonEmptyString
} from "./strict-values.js";

const FACILITY_ENDPOINT =
  "https://www.smartfarmkorea.net/Agree_WS/webservices/DataMartItemRestService/getFcltyInfoDataList";
const OUTDOOR_ENDPOINT =
  "https://www.smartfarmkorea.net/Agree_WS/webservices/OutdoorFarmRest/getIdentityDataList";
const FACILITY_DOCS_URL =
  "https://smartfarmkorea.net/openApi/openApiList.do?menuId=M1104030104";
const OUTDOOR_DOCS_URL =
  "https://smartfarmkorea.net/openApi/openApiList.do?menuId=M11040302";
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const OUTDOOR_ITEM_CODES = Object.freeze({
  APPLE: "060100",
  POTATO: "050100"
});

const REFERENCE_PROFILES = Object.freeze({
  APPLE: Object.freeze({
    OPEN_FIELD: Object.freeze({
      datasetType: "OUTDOOR_BIG_DATA",
      cropName: "사과",
      itemCode: OUTDOOR_ITEM_CODES.APPLE
    })
  }),
  POTATO: Object.freeze({
    OPEN_FIELD: Object.freeze({
      datasetType: "OUTDOOR_BIG_DATA",
      cropName: "감자",
      itemCode: OUTDOOR_ITEM_CODES.POTATO
    })
  }),
  CUCUMBER: Object.freeze({
    FACILITY_SOIL: Object.freeze({
      datasetType: "FACILITY_ITEM_DATA",
      cropName: "오이",
      cultivationNames: Object.freeze(["토경"])
    }),
    FACILITY_HYDRO: Object.freeze({
      datasetType: "FACILITY_ITEM_DATA",
      cropName: "오이",
      cultivationNames: Object.freeze(["수경", "양액"])
    })
  })
});

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function nullableString(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return requireNonEmptyString(value, field);
}

function requiredCode(value, field) {
  const code = requireNonEmptyString(value, field);
  if (!/^\d{6}$/u.test(code)) {
    throw new SchemaChangedError(`${field} must be a six-digit item code.`);
  }
  return code;
}

function requiredInteger(value, field) {
  const parsed = parseStrictFiniteNumber(value, {
    field,
    min: 0
  });
  if (!Number.isInteger(parsed)) {
    throw new SchemaChangedError(`${field} must be an integer.`);
  }
  return parsed;
}

function providerRows(payload) {
  if (!Array.isArray(payload)) {
    throw new SchemaChangedError("SmartFarm response must be an array.");
  }
  if (payload.length === 0) {
    throw new NoDataError("SmartFarm response contains no rows.");
  }
  if (payload.some((row) => !isPlainRecord(row))) {
    throw new SchemaChangedError("SmartFarm response contains an invalid row.");
  }
  const statusRow = payload[0];
  if (
    statusRow.statusCode !== null &&
    statusRow.statusCode !== undefined &&
    statusRow.statusCode !== "00"
  ) {
    if (statusRow.statusCode === "30") {
      throw new AdapterError(
        "SmartFarm service key is not registered for this API.",
        {
          adapterState: "AUTH_ERROR",
          code: "SMARTFARM_SERVICE_KEY_NOT_REGISTERED",
          retryable: false
        }
      );
    }
    throw new AdapterError("SmartFarm provider returned an error status.", {
      adapterState: "INTERNAL_ERROR",
      code: "SMARTFARM_PROVIDER_ERROR",
      retryable: false
    });
  }
  return payload;
}

function normalizeFacilityRow(row, index) {
  const year = requireNonEmptyString(
    row.fcltyYear,
    `SmartFarm facility row ${index} fcltyYear`
  );
  if (!/^\d{4}$/u.test(year)) {
    throw new SchemaChangedError(
      `SmartFarm facility row ${index} fcltyYear must be YYYY.`
    );
  }
  return {
    facilityId: requireNonEmptyString(
      row.fcltyId,
      `SmartFarm facility row ${index} fcltyId`
    ),
    seasonId: requiredInteger(
      row.crpsnSn,
      `SmartFarm facility row ${index} crpsnSn`
    ),
    year: Number(year),
    itemCode: requiredCode(
      row.itemCode,
      `SmartFarm facility row ${index} itemCode`
    ),
    cropName: requireNonEmptyString(
      row.itemCodeNm,
      `SmartFarm facility row ${index} itemCodeNm`
    ),
    variety: nullableString(
      row.spciesCodeNm,
      `SmartFarm facility row ${index} spciesCodeNm`
    ),
    greenhouseStructure: nullableString(
      row.scspnMltspnSeCodeNm,
      `SmartFarm facility row ${index} scspnMltspnSeCodeNm`
    ),
    sizeBand: nullableString(
      row.ctvtArNm,
      `SmartFarm facility row ${index} ctvtArNm`
    ),
    province: nullableString(
      row.fcltySidoCodeNm,
      `SmartFarm facility row ${index} fcltySidoCodeNm`
    ),
    district: nullableString(
      row.fcltySigunguCodeNm,
      `SmartFarm facility row ${index} fcltySigunguCodeNm`
    ),
    facilityType: nullableString(
      row.fcltyTyCodeNm,
      `SmartFarm facility row ${index} fcltyTyCodeNm`
    ),
    cultivationMethod: nullableString(
      row.ctvtMthdCodeNm,
      `SmartFarm facility row ${index} ctvtMthdCodeNm`
    )
  };
}

function normalizeOutdoorRow(row, index) {
  return {
    userId: requireNonEmptyString(
      row.userId,
      `SmartFarm outdoor row ${index} userId`
    ),
    facilityId: requireNonEmptyString(
      row.facilityId,
      `SmartFarm outdoor row ${index} facilityId`
    ),
    addressName: requireNonEmptyString(
      row.addressName,
      `SmartFarm outdoor row ${index} addressName`
    ),
    itemCode: requiredCode(
      row.itemCode,
      `SmartFarm outdoor row ${index} itemCode`
    )
  };
}

function normalizedRegionParts(regionLabel) {
  return String(regionLabel ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2);
}

function regionMatchCounts(rows, regionLabel, addressForRow) {
  const [province, district] = normalizedRegionParts(regionLabel);
  const sameProvinceCount = province
    ? rows.filter((row) => addressForRow(row).includes(province)).length
    : 0;
  const sameDistrictCount =
    province && district
      ? rows.filter((row) => {
          const address = addressForRow(row);
          return address.includes(province) && address.includes(district);
        }).length
      : 0;
  return {
    sameProvinceCount,
    sameDistrictCount,
    comparisonLevel:
      sameDistrictCount > 0
        ? "SAME_DISTRICT"
        : sameProvinceCount > 0
          ? "SAME_PROVINCE"
          : "NATIONAL"
  };
}

function topCounts(values, limit = 5) {
  const counts = new Map();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const normalized = value.trim();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName, "ko")
    )
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function baseReference({
  profile,
  regionLabel,
  farmCount,
  recordCount,
  comparison
}) {
  return {
    referenceType: "PUBLIC_PEER_COHORT",
    decisionUse: "REFERENCE_ONLY",
    affectsDecision: false,
    affectsScore: false,
    selectedCrop: profile.cropName,
    requestedRegion: normalizedRegionParts(regionLabel).join(" ") || null,
    comparisonLevel: comparison.comparisonLevel,
    sameProvinceCount: comparison.sameProvinceCount,
    sameDistrictCount: comparison.sameDistrictCount,
    farmCount,
    recordCount,
    privacy: {
      individualFarmIdsExposed: false,
      individualFarmSelected: false,
      aggregation: "COHORT_ONLY"
    }
  };
}

export function resolveSmartfarmReferenceProfile(crop, cultivationMode) {
  return REFERENCE_PROFILES[crop]?.[cultivationMode] ?? null;
}

export function parseSmartfarmFacilityReference(
  payload,
  { crop, cultivationMode, regionLabel }
) {
  const profile = resolveSmartfarmReferenceProfile(crop, cultivationMode);
  if (!profile || profile.datasetType !== "FACILITY_ITEM_DATA") {
    throw new TypeError("SmartFarm facility context is unsupported.");
  }
  const rows = providerRows(payload).map(normalizeFacilityRow);
  const cropRows = rows.filter((row) => row.cropName === profile.cropName);
  const comparableRows = cropRows.filter((row) =>
    profile.cultivationNames.some((name) =>
      row.cultivationMethod?.includes(name)
    )
  );
  if (comparableRows.length === 0) {
    throw new NoDataError(
      "SmartFarm contains no facility cohort for the requested context."
    );
  }
  const comparison = regionMatchCounts(
    comparableRows,
    regionLabel,
    (row) => `${row.province ?? ""} ${row.district ?? ""}`.trim()
  );
  const years = comparableRows.map((row) => row.year);
  const uniqueFarmIds = new Set(
    comparableRows.map((row) => row.facilityId)
  );
  const uniqueSeasons = new Set(
    comparableRows.map((row) => `${row.facilityId}:${row.seasonId}`)
  );
  return {
    ...baseReference({
      profile,
      regionLabel,
      farmCount: uniqueFarmIds.size,
      recordCount: comparableRows.length,
      comparison
    }),
    datasetType: profile.datasetType,
    datasetName: "스마트팜코리아 품목별 시설원예 데이터",
    datasetPeriod: {
      fromYear: Math.min(...years),
      toYear: Math.max(...years)
    },
    datasetUpdateCycle: "ANNUAL_AFTER_SEASON",
    seasonCount: uniqueSeasons.size,
    regions: topCounts(
      comparableRows.map((row) =>
        [row.province, row.district].filter(Boolean).join(" ")
      )
    ),
    cultivationMethods: topCounts(
      comparableRows.map((row) => row.cultivationMethod)
    ),
    facilityTypes: topCounts(
      comparableRows.map((row) => row.facilityType)
    ),
    greenhouseStructures: topCounts(
      comparableRows.map((row) => row.greenhouseStructure)
    ),
    sizeBands: topCounts(comparableRows.map((row) => row.sizeBand)),
    varieties: topCounts(comparableRows.map((row) => row.variety)),
    fetchedDataTypes: ["FARM_SEASON_METADATA"],
    availableDataTypes: [
      "CROP_SEASON",
      "ENVIRONMENT",
      "CONTROL",
      "GROWTH",
      "GROWTH_IMAGE",
      "CONSULTING_REPORT",
      "PRODUCTION",
      "COST"
    ],
    limitations: [
      "PUBLIC_COHORT_NOT_USER_FARM",
      "NO_ENVIRONMENT_VALUE_USED_AS_OPTIMUM",
      "ANNUAL_DATASET_NOT_REAL_TIME"
    ]
  };
}

export function parseSmartfarmOutdoorReference(
  payload,
  { crop, cultivationMode, regionLabel }
) {
  const profile = resolveSmartfarmReferenceProfile(crop, cultivationMode);
  if (!profile || profile.datasetType !== "OUTDOOR_BIG_DATA") {
    throw new TypeError("SmartFarm outdoor context is unsupported.");
  }
  const rows = providerRows(payload).map(normalizeOutdoorRow);
  const comparableRows = rows.filter(
    (row) => row.itemCode === profile.itemCode
  );
  if (comparableRows.length === 0) {
    throw new NoDataError(
      "SmartFarm contains no outdoor cohort for the requested crop."
    );
  }
  const comparison = regionMatchCounts(
    comparableRows,
    regionLabel,
    (row) => row.addressName
  );
  const uniqueFarmIds = new Set(
    comparableRows.map((row) => row.facilityId)
  );
  return {
    ...baseReference({
      profile,
      regionLabel,
      farmCount: uniqueFarmIds.size,
      recordCount: comparableRows.length,
      comparison
    }),
    datasetType: profile.datasetType,
    datasetName: "스마트팜코리아 노지 빅데이터",
    datasetPeriod: {
      fromYear: 2019,
      toYear: 2026
    },
    datasetUpdateCycle: "REAL_TIME_COLLECTION",
    seasonCount: null,
    regions: topCounts(comparableRows.map((row) => row.addressName)),
    cultivationMethods: [{ name: "노지", count: comparableRows.length }],
    facilityTypes: [],
    greenhouseStructures: [],
    sizeBands: [],
    varieties: [],
    fetchedDataTypes: ["FARM_IDENTITY_METADATA"],
    availableDataTypes: [
      "CROP_SEASON",
      "ENVIRONMENT",
      ...(crop === "APPLE" ? ["GROWTH"] : [])
    ],
    limitations: [
      "PUBLIC_COHORT_NOT_USER_FARM",
      "NO_ENVIRONMENT_VALUE_USED_AS_OPTIMUM",
      ...(crop === "POTATO"
        ? ["POTATO_GROWTH_OPERATION_NOT_CONFIRMED"]
        : [])
    ]
  };
}

function endpointWithCredential(endpoint, credential) {
  const key = requireNonEmptyString(
    credential,
    "SmartFarm service credential"
  );
  return `${endpoint}/${encodeURIComponent(key)}`;
}

export function createSmartfarmAdapter({
  enabled = false,
  serviceKey = null,
  contractVersion = null,
  facilityEndpoint = FACILITY_ENDPOINT,
  outdoorEndpoint = OUTDOOR_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  adapterVersion = "1.0.0",
  now = () => new Date(),
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = DEFAULT_CACHE_TTL_MS
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(
      "SmartFarm cacheFreshForMs must be between 0 and 86400000."
    );
  }
  const cacheClock = () => new Date(now()).getTime();
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 50,
      maxTtlMs: MAX_CACHE_TTL_MS,
      now: cacheClock
    });
  const liveSingleFlight = singleFlight ?? new SingleFlight();
  const liveExecutionGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 2,
      maxQueue: 6,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "SMARTFARM",
      now: providerControl.now ?? cacheClock
    });

  return Object.freeze({
    id: "smartfarm-reference",
    async getReference(
      { crop, cultivationMode, regionLabel },
      { signal, deadlineAt } = {}
    ) {
      const profile = resolveSmartfarmReferenceProfile(
        crop,
        cultivationMode
      );
      const docsUrl =
        profile?.datasetType === "FACILITY_ITEM_DATA"
          ? FACILITY_DOCS_URL
          : OUTDOOR_DOCS_URL;
      const envelopeBase = {
        sourceId: "smartfarm-reference",
        sourceName: "스마트팜코리아 공개 비교자료",
        sourceUrl: docsUrl,
        observedAt: null,
        issuedAt: null,
        validFrom: null,
        validTo: null,
        spatialLevel: "REFERENCE_DATASET",
        spatialLabel: "동종 작물 공개 농가 코호트",
        distanceKm: null,
        unit: null,
        provenance: {
          adapterId: "smartfarm-reference",
          adapterVersion,
          operationId: profile?.datasetType ?? "unsupported-context",
          contractVersion,
          providerIssueTime: null
        }
      };
      if (!profile) {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["SMARTFARM_CONTEXT_UNSUPPORTED"],
          now
        });
      }

      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: profile.datasetType,
        verifiedLocationKey: null,
        requestedPeriod: null,
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion,
          crop,
          cultivationMode,
          region: normalizedRegionParts(regionLabel).join(" ")
        }
      });
      return runCachedAdapterCall({
        enabled,
        credential: serviceKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION
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
          const facility = profile.datasetType === "FACILITY_ITEM_DATA";
          const payload = await requestProviderJson({
            fetchImpl,
            url: endpointWithCredential(
              facility ? facilityEndpoint : outdoorEndpoint,
              serviceKey
            ),
            provider: "SMARTFARM",
            requestInit: {
              headers: {
                Accept: "application/json"
              }
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: () => new Date(now()).getTime()
          });
          const data = facility
            ? parseSmartfarmFacilityReference(payload, {
                crop,
                cultivationMode,
                regionLabel
              })
            : parseSmartfarmOutdoorReference(payload, {
                crop,
                cultivationMode,
                regionLabel
              });
          return {
            data,
            qualityFlags: [
              "REFERENCE_ONLY",
              "NOT_USER_FARM_MEASUREMENT",
              "NO_DECISION_WEIGHT"
            ]
          };
        }
      });
    }
  });
}
