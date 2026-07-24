import { createDataEnvelope } from "../backend-v3/src/adapters/index.js";

const SAMPLE_AREA_CODE = "4111710500";
const SAMPLE_FLAGS = Object.freeze([
  "DEVELOPMENT_FIXTURE",
  "DO_NOT_USE_FOR_FARMING_DECISIONS",
]);
const RULE_PROVENANCE = Object.freeze({
  sourceTitle: "UI-API 연결 검증용 개발 샘플",
  sourceUrl: "https://example.test/heuknalssi-development-fixture",
  sourcePageOrTable: "local integration fixture",
  sourceVersion: "sample-2026-07",
  reviewedAt: "2026-07-24",
  ruleVersion: "development-sample-v1",
});
const CROP_MODES = Object.freeze({
  APPLE: Object.freeze(["OPEN_FIELD"]),
  PEAR: Object.freeze(["OPEN_FIELD"]),
  POTATO: Object.freeze(["OPEN_FIELD"]),
  CUCUMBER: Object.freeze([
    "OPEN_FIELD",
    "FACILITY_SOIL",
    "FACILITY_HYDRO",
  ]),
  LETTUCE: Object.freeze([
    "OPEN_FIELD",
    "FACILITY_SOIL",
    "FACILITY_HYDRO",
  ]),
});
const GROWTH_STAGES = Object.freeze([
  "BEFORE",
  "EARLY",
  "MIDDLE",
  "HARVEST",
]);

/**
 * This runtime exists only to exercise the real HTTP/session/domain flow while
 * developing the UI. Every envelope is SAMPLE, so backend-v3 downgrades the
 * result and never represents these values as current farming evidence.
 */
export async function createRuntimeOptions({ clock = Date.now } = {}) {
  return {
    adapters: createSampleAdapters(clock),
    rules: createSampleRules(),
    verifiedLocationMappings: {
      [SAMPLE_AREA_CODE]: createSampleMapping(),
    },
    runtimeStatus: {
      adapters: {
        kakao: "SAMPLE",
        climate: "SAMPLE",
        observations: "SAMPLE",
        soilV2: "SAMPLE",
        kmaShort: "SAMPLE",
        kmaMid: "SAMPLE",
      },
    },
  };
}

function createSampleAdapters(clock) {
  return {
    kakao: {
      async searchLocations() {
        return sampleEnvelope(
          {
            sourceId: "sample-location",
            sourceName: "개발 샘플 위치",
            spatialLevel: "FIELD",
            spatialLabel: "UI 연결 검증용 고정 위치",
            data: {
              candidates: [
                {
                  displayName: "경기도 수원시 영통구 원천동 · 개발 샘플",
                  resolutionMode: "ADDRESS_RESOLVED",
                  latitude: 37.285,
                  longitude: 127.045,
                  legalDongCode10: SAMPLE_AREA_CODE,
                  adminAreaCode: SAMPLE_AREA_CODE,
                },
              ],
            },
          },
          clock,
        );
      },
    },
    climate: {
      async getNormals() {
        return sampleEnvelope(
          {
            sourceId: "sample-climate",
            sourceName: "개발 샘플 기후평년",
            spatialLevel: "NORMAL_STATION",
            spatialLabel: "UI 연결 검증용 관측지점",
            observedAt: relativeIso(clock, -1),
            data: {
              observations: Array.from({ length: 12 }, (_, index) => ({
                metric: "meanTemperature",
                month: index + 1,
                value: 20,
                unit: "degC",
              })),
            },
          },
          clock,
        );
      },
    },
    observations: {
      async getRecent() {
        const now = currentDate(clock);
        const readings = Array.from({ length: 7 }, (_, index) => {
          const date = new Date(now);
          date.setUTCDate(date.getUTCDate() - (7 - index));
          return {
            date: isoDate(date),
            stationId: "119",
            minTemperature: 17 + index / 10,
            maxTemperature: 25 + index / 10,
            meanTemperature: 21 + index / 10,
            precipitationAmount: index === 4 ? 2 : 0,
          };
        });
        return sampleEnvelope(
          {
            sourceId: "sample-observations",
            sourceName: "개발 샘플 최근 관측",
            spatialLevel: "OBSERVATION_STATION",
            spatialLabel: "UI 연결 검증용 관측지점",
            observedAt: relativeIso(clock, -1),
            data: {
              stationId: "119",
              stationName: "개발 샘플 관측소",
              readings,
              monthlyNormals: [
                {
                  stationId: "119",
                  month: now.getUTCMonth() + 1,
                  meanTemperature: 21,
                },
              ],
            },
          },
          clock,
        );
      },
    },
    soilV2: {
      async getDistribution() {
        return sampleEnvelope(
          {
            sourceId: "sample-soil",
            sourceName: "개발 샘플 토양 통계",
            spatialLevel: "REGIONAL_SOIL_STAT",
            spatialLabel: "UI 연결 검증용 지역 통계",
            observedAt: relativeIso(clock, -30),
            data: {
              metrics: [
                {
                  metric: "soilPh",
                  unit: "pH",
                  boundarySemanticsVerified: true,
                  areaToleranceVerified: true,
                  areaTolerance: 0,
                  totalValidArea: 100,
                  areaUnit: "ha",
                  intervals: [
                    {
                      lower: 6,
                      upper: 7,
                      lowerInclusive: true,
                      upperInclusive: true,
                      area: 100,
                      areaUnit: "ha",
                    },
                  ],
                },
              ],
            },
          },
          clock,
        );
      },
    },
    kmaShort: {
      async getForecast() {
        const day = forecastDay(clock, 1, "SHORT_GRID");
        return sampleEnvelope(
          {
            sourceId: "sample-short-forecast",
            sourceName: "개발 샘플 단기예보",
            spatialLevel: "FORECAST_GRID",
            spatialLabel: "UI 연결 검증용 격자",
            issuedAt: currentDate(clock).toISOString(),
            validFrom: day.validFrom,
            validTo: day.validTo,
            data: { days: [day] },
          },
          clock,
        );
      },
    },
    kmaMid: {
      async getForecast() {
        const day = forecastDay(clock, 2, "MID_REGIONAL");
        return sampleEnvelope(
          {
            sourceId: "sample-mid-forecast",
            sourceName: "개발 샘플 중기예보",
            spatialLevel: "FORECAST_REGION",
            spatialLabel: "UI 연결 검증용 예보구역",
            issuedAt: currentDate(clock).toISOString(),
            validFrom: day.validFrom,
            validTo: day.validTo,
            data: { days: [day] },
          },
          clock,
        );
      },
    },
  };
}

function sampleEnvelope(input, clock) {
  const issuedAt = input.issuedAt ?? null;
  return createDataEnvelope(
    {
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      sourceUrl: "https://example.test/heuknalssi-development-fixture",
      retrievedAt: currentDate(clock).toISOString(),
      observedAt: input.observedAt ?? null,
      issuedAt,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      spatialLevel: input.spatialLevel,
      spatialLabel: input.spatialLabel,
      distanceKm: null,
      unit: null,
      deliveryState: "SAMPLE",
      adapterState: "SUCCESS",
      qualityFlags: [...SAMPLE_FLAGS],
      cacheMeta: null,
      data: input.data,
      provenance: {
        adapterId: input.sourceId,
        adapterVersion: "development-sample-v1",
        operationId: `${input.sourceId}-fixture`,
        contractVersion: "development-sample-v1",
        providerIssueTime: issuedAt,
      },
    },
    { now: () => currentDate(clock) },
  );
}

function createSampleRules() {
  const rules = [];
  for (const [crop, modes] of Object.entries(CROP_MODES)) {
    for (const cultivationMode of modes) {
      const seasonProfileId = annualProfile(crop) ?? "CUSTOM";
      if (cultivationMode === "OPEN_FIELD") {
        for (let month = 1; month <= 12; month += 1) {
          rules.push({
            ...RULE_PROVENANCE,
            ruleId: `sample-climate-${crop}-${cultivationMode}-${month}`,
            module: "CLIMATE",
            crop,
            cultivationMode,
            stage: "ANY",
            seasonProfileId,
            evaluationPeriod: { grain: "MONTH", month },
            metric: "meanTemperature",
            unit: "degC",
            use: "DEVIATION",
            evidenceStatus: "CONFIRMED_RANGE",
            optimalRange: [10, 30],
            toleranceRange: null,
            sensitivityTier: "CRITICAL",
            critical: true,
          });
        }
      }
      if (cultivationMode !== "FACILITY_HYDRO") {
        rules.push({
          ...RULE_PROVENANCE,
          ruleId: `sample-soil-${crop}-${cultivationMode}`,
          module: "SOIL",
          crop,
          cultivationMode,
          stage: "ANY",
          evaluationPeriod: {
            grain: "SEASON_AGGREGATE",
            aggregation: "MEAN",
          },
          metric: "soilPh",
          unit: "pH",
          use: "DEVIATION",
          evidenceStatus: "CONFIRMED_RANGE",
          optimalRange: [6, 7],
          toleranceRange: null,
          sensitivityTier: "CRITICAL",
          critical: true,
        });
      }
      rules.push({
        ...RULE_PROVENANCE,
        ruleId: `sample-forecast-${crop}-${cultivationMode}`,
        crop,
        cultivationMode,
        stage: "ANY",
        metric: "maxTemperature",
        unit: "℃",
        comparison: { operator: "GT", threshold: 32 },
        duration: { kind: "ANY_DAY" },
        severity: "WARNING",
        actionId: "CHECK_HEAT",
        evidenceStatus: "RISK_ONLY",
      });
      for (const stage of GROWTH_STAGES) {
        rules.push({
          ...RULE_PROVENANCE,
          ruleId: `sample-stage-${crop}-${cultivationMode}-${stage}`,
          module: "CLIMATE",
          crop,
          cultivationMode,
          stage,
          seasonProfileId,
          evaluationPeriod: { grain: "MONTH", month: 1 },
          metric: `stageMarker${stage}`,
          unit: "flag",
          use: "DISPLAY_ONLY",
          evidenceStatus: "UNCONFIRMED",
        });
      }
    }
  }
  return rules;
}

function annualProfile(crop) {
  if (crop === "APPLE") return "APPLE_OPEN_FIELD_ANNUAL";
  if (crop === "PEAR") return "PEAR_OPEN_FIELD_ANNUAL";
  return null;
}

function createSampleMapping() {
  return {
    provenance: {
      sourceTitle: "UI-API 연결 검증용 개발 샘플 위치 매핑",
      sourceUrl: "https://example.test/heuknalssi-development-fixture",
      version: "development-sample-v1",
      reviewedAt: "2026-07-24",
      validFrom: "2026-01-01",
      validTo: "2027-12-31",
    },
    soil: { verified: true, code: "41117" },
    midForecast: {
      verified: true,
      temperatureRegId: "11B20601",
      landRegId: "11B00000",
    },
    normalStation: { verified: true, id: "119" },
    observationStation: {
      verified: true,
      id: "119",
      distanceKm: 4.2,
      operationalVerified: true,
      periodDataVerified: true,
    },
  };
}

function forecastDay(clock, dayOffset, sourceType) {
  const date = currentDate(clock);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  const dateText = isoDate(date);
  return {
    date: dateText,
    sourceType,
    spatialLevel:
      sourceType === "SHORT_GRID" ? "FORECAST_GRID" : "FORECAST_REGION",
    issueTime: currentDate(clock).toISOString(),
    validFrom: `${dateText}T00:00:00.000Z`,
    validTo: `${dateText}T23:59:59.000Z`,
    minTemperature: 17,
    maxTemperature: 25,
    precipitationProbability: 20,
    precipitationAmount: 0,
    windSpeed: 1.5,
    risks: [],
  };
}

function currentDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("sample runtime clock returned an invalid date");
  }
  return date;
}

function relativeIso(clock, days) {
  const date = currentDate(clock);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
