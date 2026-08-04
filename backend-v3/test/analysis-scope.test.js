import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisScopeContract,
  projectAnalysisScope,
} from "../src/domain/analysis-scope.js";
import { buildAnalysisScopeProjection } from "../src/application/analysis-scope.js";

const PRIVATE_PARCEL_KEY = "4111710500100010001";

function sourceEnvelope({
  sourceId,
  spatialLevel,
  adapterState = "SUCCESS",
  deliveryState = adapterState === "SUCCESS" ? "LIVE" : "UNAVAILABLE",
  data = adapterState === "SUCCESS" ? { available: true } : null,
  distanceKm = null,
  qualityFlags = [],
  freshness = deliveryState === "UNAVAILABLE" ? "NOT_APPLICABLE" : "CURRENT",
} = {}) {
  return {
    sourceId,
    sourceName: `${sourceId} 출처`,
    sourceUrl: `https://example.test/${sourceId}`,
    retrievedAt: "2026-08-04T00:00:00.000Z",
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel,
    spatialLabel: `${spatialLevel} 범위`,
    distanceKm,
    deliveryState,
    adapterState,
    freshness,
    qualityFlags,
    data,
    pnuCode: PRIVATE_PARCEL_KEY,
    rawProviderRow: { PNU_Cd: PRIVATE_PARCEL_KEY },
  };
}

function completeEnvelopes(overrides = {}) {
  return {
    soilExam: sourceEnvelope({
      sourceId: "soil-exam-v2",
      spatialLevel: "FIELD",
    }),
    fieldSoil: sourceEnvelope({
      sourceId: "soil-field-v3",
      spatialLevel: "FIELD",
    }),
    climate: sourceEnvelope({
      sourceId: "kma-climate-normal",
      spatialLevel: "NORMAL_STATION",
    }),
    observations: sourceEnvelope({
      sourceId: "kma-asos-observations",
      spatialLevel: "OBSERVATION_STATION",
    }),
    shortForecast: sourceEnvelope({
      sourceId: "kma-short-forecast",
      spatialLevel: "FORECAST_GRID",
    }),
    soil: sourceEnvelope({
      sourceId: "soil-v2",
      spatialLevel: "REGIONAL_SOIL_STAT",
    }),
    midForecast: sourceEnvelope({
      sourceId: "kma-mid-forecast",
      spatialLevel: "FORECAST_REGION",
    }),
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    cultivationMode: "OPEN_FIELD",
    options: {},
    ...overrides,
  };
}

function resolvedLocation(overrides = {}) {
  return {
    resolutionMode: "ADDRESS_RESOLVED",
    fieldParcelLookupKey: PRIVATE_PARCEL_KEY,
    latitude: 37.25,
    longitude: 127.05,
    ...overrides,
  };
}

function locationKeys(overrides = {}) {
  return {
    normalStationId: "119",
    observationStationId: "119",
    observationDistanceKm: 4.2,
    shortForecastGrid: { nx: 60, ny: 121 },
    shortForecastScope: "ADDRESS_GRID",
    verifiedSoilAreaCode: "4111710500",
    midForecastRegionIds: {
      temperatureRegId: "11B20601",
      landRegId: "11B00000",
    },
    ...overrides,
  };
}

function scopeItem(scope, overrides = {}) {
  return {
    itemId: `${scope}_ITEM`,
    label: `${scope} 자료`,
    scope,
    state: "AVAILABLE",
    missingReasonCode: null,
    distanceKm: null,
    source: sourceEnvelope({
      sourceId: scope.toLowerCase(),
      spatialLevel: "FIELD",
    }),
    limitationCodes: [],
    ...overrides,
  };
}

test("domain projection keeps the four user-facing scopes and allowlists source metadata", () => {
  const result = projectAnalysisScope({
    locationPrecision: "ADDRESS_RESOLVED",
    parcelState: "UNREGISTERED",
    items: analysisScopeContract.scopes.map((scope) => scopeItem(scope)),
  });

  assert.deepEqual(
    result.groups.map(({ scope, label }) => [scope, label]),
    [
      ["FIELD_MEASUREMENT", "필지 실측"],
      ["FIELD_SOIL_MAP", "필지 토양도"],
      ["ADDRESS_POINT", "주소 지점"],
      ["ADMIN_AREA_REFERENCE", "행정구역 참고"],
    ],
  );
  assert.equal(result.summary.highestPrecision, "FIELD_MEASUREMENT");
  assert.equal(result.summary.commonNotice, null);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PRIVATE_PARCEL_KEY), false);
  assert.equal(serialized.includes("rawProviderRow"), false);
  assert.equal(serialized.includes("pnuCode"), false);
});

test("application projection distinguishes every source scope and preserves verified station distance", () => {
  const result = buildAnalysisScopeProjection({
    request: request(),
    resolvedLocation: resolvedLocation(),
    locationKeys: locationKeys(),
    envelopes: completeEnvelopes(),
  });

  assert.deepEqual(result.summary.availableScopes, [
    "FIELD_MEASUREMENT",
    "FIELD_SOIL_MAP",
    "ADDRESS_POINT",
    "ADMIN_AREA_REFERENCE",
  ]);
  const items = result.groups.flatMap((group) => group.items);
  const observation = items.find(
    ({ itemId }) => itemId === "RECENT_OBSERVATION",
  );
  assert.equal(observation.scope, "ADDRESS_POINT");
  assert.equal(observation.distanceKm, 4.2);
  assert.equal(observation.source.sourceName, "kma-asos-observations 출처");
  assert.deepEqual(
    result.limitations.find(
      ({ code }) => code === "OBSERVATION_STATION_NOT_FIELD_MICROCLIMATE",
    ).itemIds,
    ["RECENT_OBSERVATION"],
  );
  assert.equal(
    items.find(({ itemId }) => itemId === "REGIONAL_SOIL_STATISTICS").scope,
    "ADMIN_AREA_REFERENCE",
  );
  assert.equal(JSON.stringify(result).includes(PRIVATE_PARCEL_KEY), false);
});

test("NO_DATA is the only provider state projected as no field soil exam history", () => {
  const noHistory = buildAnalysisScopeProjection({
    request: request(),
    resolvedLocation: resolvedLocation(),
    locationKeys: locationKeys(),
    envelopes: completeEnvelopes({
      soilExam: sourceEnvelope({
        sourceId: "soil-exam-v2",
        spatialLevel: "FIELD",
        adapterState: "NO_DATA",
      }),
    }),
  });
  assert.deepEqual(
    noHistory.missingReasons.find(
      ({ code }) => code === "NO_FIELD_SOIL_EXAM_HISTORY",
    ).itemIds,
    ["FIELD_SOIL_EXAM"],
  );

  const providerFailure = buildAnalysisScopeProjection({
    request: request(),
    resolvedLocation: resolvedLocation(),
    locationKeys: locationKeys(),
    envelopes: completeEnvelopes({
      soilExam: sourceEnvelope({
        sourceId: "soil-exam-v2",
        spatialLevel: "FIELD",
        adapterState: "AUTH_ERROR",
      }),
    }),
  });
  assert.equal(
    providerFailure.missingReasons.some(
      ({ code }) => code === "NO_FIELD_SOIL_EXAM_HISTORY",
    ),
    false,
  );
  assert.deepEqual(
    providerFailure.missingReasons.find(
      ({ code }) => code === "FIELD_SOIL_EXAM_UNAVAILABLE",
    ).itemIds,
    ["FIELD_SOIL_EXAM"],
  );
});

test("broad locations keep one common regional notice and never claim an observation distance", () => {
  const result = buildAnalysisScopeProjection({
    request: request(),
    resolvedLocation: resolvedLocation({
      resolutionMode: "ADMIN_AREA_BROAD",
      fieldParcelLookupKey: null,
      latitude: null,
      longitude: null,
    }),
    locationKeys: locationKeys({
      observationStationId: null,
      observationDistanceKm: null,
      shortForecastScope: "ADMIN_AREA_REPRESENTATIVE",
    }),
    envelopes: completeEnvelopes({
      observations: sourceEnvelope({
        sourceId: "kma-asos-observations",
        spatialLevel: "OBSERVATION_STATION",
        distanceKm: 0,
      }),
    }),
  });

  assert.equal(result.parcel.parcelState, "ADMIN_AREA_ONLY");
  assert.equal(result.summary.regionalReferenceOnly, true);
  assert.equal(result.summary.commonNotice.code, "ADMIN_AREA_REFERENCE_ONLY");
  assert.equal(
    result.groups
      .flatMap(({ items }) => items)
      .find(({ itemId }) => itemId === "RECENT_OBSERVATION").distanceKm,
    null,
  );
  assert.equal(JSON.stringify(result).includes('"distanceKm":0'), false);
  assert.deepEqual(
    result.missingReasons.find(
      ({ code }) => code === "DETAILED_ADDRESS_REQUIRED_FOR_OBSERVATION",
    ).itemIds,
    ["RECENT_OBSERVATION"],
  );
  assert.equal(
    JSON.stringify(result).match(/상세 주소 없이 확인 가능한 지역 자료만 사용했으며/gu)
      ?.length,
    1,
  );
  assert.equal(JSON.stringify(result).includes("확인필요"), false);
});

test("parcel and satellite state are projected without geometry or internal parcel keys", () => {
  const result = buildAnalysisScopeProjection({
    request: request({
      parcel: {
        userConfirmed: true,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [127.0, 37.0],
              [127.1, 37.0],
              [127.1, 37.1],
              [127.0, 37.0],
            ],
          ],
        },
      },
      options: { includeSatelliteObservation: true },
    }),
    resolvedLocation: resolvedLocation(),
    locationKeys: locationKeys(),
    envelopes: completeEnvelopes(),
    satellite: {
      state: "UNSUPPORTED",
      blockingReasons: ["SATELLITE_P2_NOT_ENABLED"],
    },
  });

  assert.deepEqual(result.parcel, {
    parcelState: "POLYGON_REGISTERED",
    satelliteState: "UNAVAILABLE",
    missingReasonCode: "SATELLITE_NOT_ENABLED",
    limitationCodes: ["SATELLITE_REMOTE_OBSERVATION_NOT_DIAGNOSIS"],
  });
  assert.deepEqual(
    result.missingReasons.find(({ code }) => code === "SATELLITE_NOT_ENABLED")
      .itemIds,
    ["SATELLITE_OBSERVATION"],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("geometry"), false);
  assert.equal(serialized.includes(PRIVATE_PARCEL_KEY), false);
  assert.equal(serialized.includes("127.1"), false);
});
