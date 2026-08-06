import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaChangedError,
  UnsupportedContractError,
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_V2_CONTRACT,
  VERIFIED_SOIL_V2_CONTRACT_VERSION,
  createAdapterRegistry,
  createKakaoAdapter,
  createKmaMidForecastAdapter,
  createKmaShortForecastAdapter,
  createSoilV2Adapter,
  parseKakaoCandidates,
  parseKakaoCurrentAddressCandidates,
  parseKakaoRegionCandidates,
  parseKmaMidForecast,
  parseKmaShortForecast,
  parseSoilV2
} from "../src/adapters/index.js";

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return structuredClone(body);
    }
  };
}

function textResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return body;
    }
  };
}

function kakaoDocument({
  name,
  x,
  y,
  code,
  addressType = "ROAD_ADDR"
}) {
  return {
    address_name: name,
    address_type: addressType,
    x,
    y,
    address: { b_code: code }
  };
}

test("Kakao parser handles 0, 1, and multiple candidates without selecting the first", () => {
  assert.deepEqual(parseKakaoCandidates({ documents: [] }), []);

  const one = parseKakaoCandidates({
    documents: [
      kakaoDocument({
        name: "서울특별시 중구 세종대로 110",
        x: "126.9784",
        y: "37.5667",
        code: "1114010300"
      })
    ]
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].legalDongCode10, "1114010300");
  assert.equal(one[0].resolutionMode, "ADDRESS_RESOLVED");
  assert.equal(one[0].providerAddressType, "ROAD_ADDR");

  const many = parseKakaoCandidates({
    documents: [
      kakaoDocument({
        name: "후보 A",
        x: "126.9",
        y: "37.5",
        code: "1114010300"
      }),
      kakaoDocument({
        name: "후보 B",
        x: "127.0",
        y: "37.6",
        code: "1111010100"
      })
    ]
  });
  assert.equal(many.length, 2);
  assert.equal("selectedCandidate" in many, false);
  assert.equal("primary" in many[0], false);
});

test("Kakao coordinate parser keeps a legal-region fallback broad", () => {
  assert.deepEqual(
    parseKakaoRegionCandidates({
      documents: [
        {
          region_type: "H",
          address_name: "경기도 수원시 영통구 광교1동",
          code: "4111760000",
          x: 127.05,
          y: 37.28
        },
        {
          region_type: "B",
          address_name: "경기도 수원시 영통구 원천동",
          code: "4111710500",
          x: 127.045,
          y: 37.285
        }
      ]
    }),
    [
      {
        displayName: "경기도 수원시 영통구 원천동",
        resolutionMode: "ADMIN_AREA_BROAD",
        providerAddressType: "LEGAL_REGION_COORDINATE",
        legalDongCode10: "4111710500",
        longitude: null,
        latitude: null,
        providerCoordinatesExcluded: true,
        administrativeRepresentative: {
          longitude: 127.045,
          latitude: 37.285,
          purpose: "REGIONAL_FORECAST_ONLY"
        }
      }
    ]
  );
});

test("Kakao current-address parser derives a 19-digit parcel PNU from the GPS address", () => {
  const [candidate] = parseKakaoCurrentAddressCandidates(
    {
      documents: [
        {
          address: {
            address_name: "경기도 수원시 영통구 원천동 산 12-3",
            b_code: "4111710500",
            mountain_yn: "Y",
            main_address_no: "12",
            sub_address_no: "3"
          },
          road_address: {
            address_name: "경기도 수원시 영통구 월드컵로 206"
          }
        }
      ]
    },
    { latitude: 37.285, longitude: 127.045 }
  );

  assert.deepEqual(candidate, {
    displayName: "경기도 수원시 영통구 월드컵로 206",
    resolutionMode: "ADDRESS_RESOLVED",
    providerAddressType: "CURRENT_COORDINATE_ADDRESS",
    legalDongCode10: "4111710500",
    longitude: 127.045,
    latitude: 37.285,
    providerCoordinatesExcluded: false,
    fieldParcelLookupKey: "4111710500200120003"
  });
});

test("Kakao current-address parser combines parcel numbers with the verified legal-region code", () => {
  const [candidate] = parseKakaoCurrentAddressCandidates(
    {
      documents: [
        {
          address: {
            address_name: "경기 수원시 영통구 원천동 산 5-1",
            mountain_yn: "Y",
            main_address_no: "5",
            sub_address_no: "1"
          },
          road_address: null
        }
      ]
    },
    {
      latitude: 37.285,
      longitude: 127.045,
      legalDongCode10: "4111710500"
    }
  );

  assert.equal(candidate.fieldParcelLookupKey, "4111710500200050001");
  assert.equal(candidate.legalDongCode10, "4111710500");
});

test("Kakao REGION and ROAD candidates do not expose provider centroids as points", () => {
  for (const addressType of ["REGION", "ROAD"]) {
    const [candidate] = parseKakaoCandidates({
      documents: [
        kakaoDocument({
          name: "서울특별시",
          x: "126.978",
          y: "37.566",
          code: "1100000000",
          addressType
        })
      ]
    });
    assert.equal(candidate.resolutionMode, "ADMIN_AREA_BROAD");
    assert.equal(candidate.providerAddressType, addressType);
    assert.equal(candidate.longitude, null);
    assert.equal(candidate.latitude, null);
    assert.equal(candidate.providerCoordinatesExcluded, true);
    assert.deepEqual(candidate.administrativeRepresentative, {
      longitude: 126.978,
      latitude: 37.566,
      purpose: "REGIONAL_FORECAST_ONLY",
    });
  }
});

test("Kakao adapter returns all candidates and an explicit selection requirement", async () => {
  const payload = {
    documents: [
      kakaoDocument({
        name: "후보 A",
        x: "126.9",
        y: "37.5",
        code: "1114010300"
      }),
      kakaoDocument({
        name: "후보 B",
        x: "127.0",
        y: "37.6",
        code: "1111010100"
      })
    ]
  };
  let calls = 0;
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(payload);
    },
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  const result = await adapter.searchLocations("중구", {
    deadlineAt: Date.now() + 1000
  });
  const cached = await adapter.searchLocations("중구", {
    deadlineAt: Date.now() + 1000
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(result.deliveryState, "LIVE");
  assert.equal(cached.deliveryState, "CACHE");
  assert.equal(result.data.candidates.length, 2);
  assert.equal(result.data.requiresSelection, true);
  assert.equal("selectedCandidate" in result.data, false);
  assert.equal(calls, 1);
  assert.equal(result.sourceUrl.includes("fixture-key"), false);
});

test("Kakao adapter resolves current coordinates without exposing them in its cache key or source URL", async () => {
  const requestedUrls = [];
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes("coord2regioncode.json")) {
        return jsonResponse({
          documents: [
            {
              region_type: "B",
              address_name: "경기도 수원시 영통구 원천동",
              code: "4111710500",
              x: 127.045,
              y: 37.285
            }
          ]
        });
      }
      return jsonResponse({
        documents: [
          {
            address: {
              address_name: "경기도 수원시 영통구 원천동 12-3",
              mountain_yn: "N",
              main_address_no: "12",
              sub_address_no: "3"
            },
            road_address: null
          }
        ]
      });
    }
  });

  const result = await adapter.resolveCurrentLocation({
    latitude: 37.285,
    longitude: 127.045
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(result.data.candidates[0].legalDongCode10, "4111710500");
  assert.equal(result.data.candidates[0].fieldParcelLookupKey, "4111710500100120003");
  assert.match(requestedUrls[0], /coord2address\.json/);
  assert.match(requestedUrls[1], /coord2regioncode\.json/);
  assert.equal(requestedUrls.length, 2);
  assert.equal(result.sourceUrl.includes("37.285"), false);
  assert.equal(result.sourceUrl.includes("127.045"), false);
});

test("Kakao current-location lookup falls back to a broad region when no parcel address exists", async () => {
  const requestedUrls = [];
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes("coord2address.json")) {
        return jsonResponse({ documents: [] });
      }
      return jsonResponse({
        documents: [
          {
            region_type: "B",
            address_name: "경기도 수원시 영통구 원천동",
            code: "4111710500",
            x: 127.045,
            y: 37.285
          }
        ]
      });
    }
  });

  const result = await adapter.resolveCurrentLocation({
    latitude: 37.285,
    longitude: 127.045
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(result.data.candidates[0].resolutionMode, "ADMIN_AREA_BROAD");
  assert.equal("fieldParcelLookupKey" in result.data.candidates[0], false);
  assert.match(requestedUrls[0], /coord2address\.json/);
  assert.match(requestedUrls[1], /coord2regioncode\.json/);
});

test("Kakao empty result is NO_DATA, not schema failure", async () => {
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    fetchImpl: async () => jsonResponse({ documents: [] })
  });
  const result = await adapter.searchLocations("없는 주소");
  assert.equal(result.adapterState, "NO_DATA");
  assert.deepEqual(result.data.candidates, []);
});

test("Kakao schema changes are contained in an unavailable envelope", async () => {
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    fetchImpl: async () => jsonResponse({ unexpected: [] })
  });
  const result = await adapter.searchLocations("서울");
  assert.equal(result.adapterState, "SCHEMA_CHANGED");
  assert.equal(result.deliveryState, "UNAVAILABLE");
  assert.equal(result.data, null);
});

test("HTTP 401/403/429/5xx are classified without provider-body leakage", async (t) => {
  const cases = [
    { status: 401, expected: "AUTH_ERROR", expectedCalls: 1 },
    { status: 403, expected: "AUTH_ERROR", expectedCalls: 1 },
    {
      status: 429,
      expected: "RATE_LIMITED",
      expectedCalls: 1,
      headers: { "retry-after": "60" }
    },
    { status: 503, expected: "INTERNAL_ERROR", expectedCalls: 2 }
  ];

  for (const fixture of cases) {
    await t.test(String(fixture.status), async () => {
      let calls = 0;
      const adapter = createKakaoAdapter({
        enabled: true,
        apiKey: "fixture-key",
        contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(
            { secretProviderMessage: "must not escape" },
            fixture.status,
            fixture.headers
          );
        }
      });
      const result = await adapter.searchLocations("서울", {
        deadlineAt: Date.now() + 1000
      });
      assert.equal(result.adapterState, fixture.expected);
      assert.equal(result.deliveryState, "UNAVAILABLE");
      assert.equal(result.data, null);
      assert.equal(JSON.stringify(result).includes("must not escape"), false);
      assert.equal(calls, fixture.expectedCalls);
    });
  }
});

test("adapter timeout aborts fetch and returns TIMEOUT instead of throwing", async () => {
  let aborted = false;
  const adapter = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true }
        );
      })
  });
  const result = await adapter.searchLocations("서울");
  assert.equal(result.adapterState, "TIMEOUT");
  assert.equal(result.deliveryState, "UNAVAILABLE");
  assert.equal(aborted, true);
});

const SHORT_PROVIDER_FIXTURE = {
  response: {
    header: { resultCode: "00" },
    body: {
      items: {
        item: [
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0600",
            category: "TMN",
            fcstValue: "18"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1500",
            category: "TMX",
            fcstValue: "29"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "POP",
            fcstValue: "60"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "PCP",
            fcstValue: "1.5"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "WSD",
            fcstValue: "3.2"
          }
        ]
      }
    }
  }
};

test("short KMA parser preserves real date, issue time, validity, and forecast spatial level", () => {
  const [day] = parseKmaShortForecast(SHORT_PROVIDER_FIXTURE);
  assert.deepEqual(day, {
    date: "2026-07-23",
    sourceType: "SHORT_GRID",
    spatialLevel: "FORECAST_GRID",
    issueTime: "2026-07-22T17:00:00.000Z",
    validFrom: "2026-07-22T21:00:00.000Z",
    validTo: "2026-07-23T06:00:00.000Z",
    minTemperature: 18,
    maxTemperature: 29,
    precipitationProbability: 60,
    precipitationAmount: 1.5,
    windSpeed: 3.2,
    risks: []
  });
});

const SHORT_REPEATED_PROVIDER_FIXTURE = {
  response: {
    header: { resultCode: "00" },
    body: {
      items: {
        item: [
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0300",
            category: "TMP",
            fcstValue: "20"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0600",
            category: "TMP",
            fcstValue: "18"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1500",
            category: "TMP",
            fcstValue: "31"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0600",
            category: "TMN",
            fcstValue: "17"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0700",
            category: "TMN",
            fcstValue: "18"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1500",
            category: "TMX",
            fcstValue: "30"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1600",
            category: "TMX",
            fcstValue: "31"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0300",
            category: "POP",
            fcstValue: "20"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "POP",
            fcstValue: "70"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1800",
            category: "POP",
            fcstValue: "40"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0300",
            category: "PCP",
            fcstValue: "강수없음"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "PCP",
            fcstValue: "1.5mm"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1800",
            category: "PCP",
            fcstValue: "2"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "0300",
            category: "WSD",
            fcstValue: "1.5"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260723",
            fcstTime: "1200",
            category: "WSD",
            fcstValue: "4.8"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260724",
            fcstTime: "0600",
            category: "TMP",
            fcstValue: "21"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260724",
            fcstTime: "1500",
            category: "TMP",
            fcstValue: "28"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260724",
            fcstTime: "0600",
            category: "PCP",
            fcstValue: "1.0mm 미만"
          },
          {
            baseDate: "20260723",
            baseTime: "0200",
            fcstDate: "20260724",
            fcstTime: "1200",
            category: "PCP",
            fcstValue: "강수없음"
          }
        ]
      }
    }
  }
};

test("short KMA aggregates repeated hourly categories conservatively", () => {
  const days = parseKmaShortForecast(SHORT_REPEATED_PROVIDER_FIXTURE);
  assert.equal(days.length, 2);
  assert.equal(days[0].minTemperature, 18);
  assert.equal(days[0].maxTemperature, 31);
  assert.equal(days[0].precipitationProbability, 70);
  assert.equal(days[0].windSpeed, 4.8);
  assert.equal(days[0].precipitationAmount, 3.5);
  assert.ok(days[0].qualityFlags.includes("SHORT_TMN_MULTIPLE_VALUES"));
  assert.ok(days[0].qualityFlags.includes("SHORT_TMX_MULTIPLE_VALUES"));

  assert.equal(days[1].minTemperature, 21);
  assert.equal(days[1].maxTemperature, 28);
  assert.equal(days[1].precipitationAmount, null);
  assert.ok(days[1].qualityFlags.includes("SHORT_PCP_NON_QUANTITATIVE"));
});

test("short KMA adapter labels current-provider data as forecast, never observation", async () => {
  const adapter = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    fetchImpl: async () => jsonResponse(SHORT_PROVIDER_FIXTURE),
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  const result = await adapter.getForecast({
    nx: 60,
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(result.observedAt, null);
  assert.equal(result.issuedAt, "2026-07-22T17:00:00.000Z");
  assert.equal(result.validFrom, "2026-07-22T21:00:00.000Z");
  assert.equal(result.validTo, "2026-07-23T06:00:00.000Z");
  assert.equal(result.spatialLevel, "FORECAST_GRID");
  assert.equal(result.data.dataRole, "FORECAST");
  assert.equal("observation" in result.data, false);
});

test("short KMA cache is fresh-only and concurrent identical calls use one flight", async () => {
  let clock = Date.parse("2026-07-23T00:00:00.000Z");
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    cacheFreshForMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return jsonResponse(SHORT_PROVIDER_FIXTURE);
    },
    now: () => new Date(clock)
  });
  const parameters = {
    nx: 60,
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  };
  const first = adapter.getForecast(parameters);
  const second = adapter.getForecast(parameters);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.deliveryState, "LIVE");
  assert.equal(secondResult.deliveryState, "LIVE");

  const cached = await adapter.getForecast(parameters);
  assert.equal(cached.deliveryState, "CACHE");
  assert.equal(calls, 1);

  clock += 1001;
  const refreshed = await adapter.getForecast(parameters);
  assert.equal(refreshed.deliveryState, "LIVE");
  assert.equal(calls, 2);
});

test("shared short KMA work isolates each waiter's cancellation", async () => {
  let upstreamSignal;
  let release;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const adapter = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    fetchImpl: (_url, { signal }) => {
      upstreamSignal = signal;
      return new Promise((resolve, reject) => {
        release = () => resolve(jsonResponse(SHORT_PROVIDER_FIXTURE));
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        );
      });
    }
  });
  const parameters = {
    nx: 60,
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  };
  const first = adapter.getForecast(parameters, {
    signal: firstController.signal
  });
  const second = adapter.getForecast(parameters, {
    signal: secondController.signal
  });
  await new Promise((resolve) => setImmediate(resolve));

  firstController.abort();
  const cancelled = await first;
  assert.equal(cancelled.adapterState, "TIMEOUT");
  assert.equal(cancelled.deliveryState, "UNAVAILABLE");
  assert.equal(upstreamSignal.aborted, false);

  release();
  const survivor = await second;
  assert.equal(survivor.adapterState, "SUCCESS");
  assert.equal(survivor.deliveryState, "LIVE");
});

test("short KMA fails closed when different-key provider concurrency is saturated", async () => {
  let release;
  let calls = 0;
  const adapter = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    providerControl: {
      maxConcurrency: 1,
      maxQueue: 0
    },
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return jsonResponse(SHORT_PROVIDER_FIXTURE);
    }
  });
  const base = {
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  };
  const first = adapter.getForecast({ ...base, nx: 60 });
  await new Promise((resolve) => setImmediate(resolve));
  const saturated = await adapter.getForecast({ ...base, nx: 61 });
  assert.equal(saturated.adapterState, "RATE_LIMITED");
  assert.ok(
    saturated.qualityFlags.includes(
      "PROVIDER_CONCURRENCY_SATURATED"
    )
  );
  assert.equal(calls, 1);

  release();
  assert.equal((await first).adapterState, "SUCCESS");
});

test("adapter registry shares one KMA concurrency budget across short and mid calls", async () => {
  let release;
  let calls = 0;
  const registry = createAdapterRegistry({
    common: {
      fetchImpl: async () => {
        calls += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
        return jsonResponse(SHORT_PROVIDER_FIXTURE);
      }
    },
    kmaShort: {
      enabled: true,
      apiKey: "fixture-key",
      contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
      providerControl: {
        maxConcurrency: 1,
        maxQueue: 0
      }
    },
    kmaMid: {
      enabled: true,
      apiKey: "fixture-key",
      contractVersion: VERIFIED_KMA_MID_CONTRACT_VERSION
    }
  });
  const short = registry.kmaShort.getForecast({
    nx: 60,
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const mid = await registry.kmaMid.getForecast({
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
    tmFc: "202607230600"
  });
  assert.equal(mid.adapterState, "RATE_LIMITED");
  assert.ok(
    mid.qualityFlags.includes("PROVIDER_CONCURRENCY_SATURATED")
  );
  assert.equal(calls, 1);

  release();
  assert.equal((await short).adapterState, "SUCCESS");
});

test("short KMA circuit blocks new keys and recovers after its cooldown", async () => {
  let clock = Date.parse("2026-07-23T00:00:00.000Z");
  let calls = 0;
  let failing = true;
  const adapter = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    providerControl: {
      maxConcurrency: 1,
      maxQueue: 0,
      failureThreshold: 1,
      circuitCooldownMs: 100
    },
    fetchImpl: async () => {
      calls += 1;
      return failing
        ? jsonResponse({ hidden: "provider detail" }, 503)
        : jsonResponse(SHORT_PROVIDER_FIXTURE);
    },
    now: () => new Date(clock)
  });
  const base = {
    ny: 127,
    baseDate: "20260723",
    baseTime: "0200"
  };
  const failed = await adapter.getForecast({ ...base, nx: 60 });
  assert.equal(failed.adapterState, "INTERNAL_ERROR");
  assert.equal(calls, 2);

  failing = false;
  const open = await adapter.getForecast({ ...base, nx: 61 });
  assert.equal(open.adapterState, "RATE_LIMITED");
  assert.ok(open.qualityFlags.includes("PROVIDER_CIRCUIT_OPEN"));
  assert.equal(calls, 2);

  clock += 101;
  const recovered = await adapter.getForecast({ ...base, nx: 62 });
  assert.equal(recovered.adapterState, "SUCCESS");
  assert.equal(calls, 3);
});

test("non-allowlisted Kakao and KMA contract strings perform zero external calls", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  const kakao = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: "arbitrary-provider-contract",
    fetchImpl
  });
  const short = createKmaShortForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: "arbitrary-provider-contract",
    fetchImpl
  });
  const mid = createKmaMidForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: "arbitrary-provider-contract",
    fetchImpl
  });
  const [kakaoResult, shortResult, midResult] = await Promise.all([
    kakao.searchLocations("서울"),
    short.getForecast({
      nx: 60,
      ny: 127,
      baseDate: "20260723",
      baseTime: "0200"
    }),
    mid.getForecast({
      temperatureRegId: "11B10101",
      landRegId: "11B00000",
      tmFc: "202607230600"
    })
  ]);
  for (const result of [kakaoResult, shortResult, midResult]) {
    assert.equal(result.adapterState, "UNSUPPORTED");
    assert.equal(result.deliveryState, "UNAVAILABLE");
    assert.ok(result.qualityFlags.includes("PROVIDER_CONTRACT_UNSUPPORTED"));
  }
  assert.equal(calls, 0);
});

test("KMA normalized daily parser rejects impossible ISO dates", () => {
  assert.throws(
    () =>
      parseKmaShortForecast({
        days: [
          {
            date: "2026-02-30",
            issueTime: "2026-02-27T00:00:00Z",
            validFrom: "2026-03-01T00:00:00Z",
            validTo: "2026-03-01T23:59:59Z"
          }
        ]
      }),
    SchemaChangedError
  );
});

const MID_TEMPERATURE_FIXTURE = {
  response: {
    header: { resultCode: "00" },
    body: {
      items: {
        item: [
          {
            regId: "11B10101",
            taMin3: "-",
            taMax3: "31",
            taMin4: "20",
            taMax4: "30"
          }
        ]
      }
    }
  }
};

const MID_LAND_FIXTURE = {
  response: {
    header: { resultCode: "00" },
    body: {
      items: {
        item: [
          {
            regId: "11B00000",
            rnSt3Am: "20",
            rnSt3Pm: "60",
            wf3Am: "맑음",
            wf3Pm: "구름많음",
            rnSt4Am: "30",
            rnSt4Pm: "-",
            wf4Am: "흐림",
            wf4Pm: "흐림",
            rnSt8: "40",
            wf8: "구름많음"
          }
        ]
      }
    }
  }
};

test("mid KMA joins separate temperature and land payloads by actual date", () => {
  const days = parseKmaMidForecast(
    {
      temperature: MID_TEMPERATURE_FIXTURE,
      land: MID_LAND_FIXTURE
    },
    {
      issuedAt: "202607230600",
      temperatureRegId: "11B10101",
      landRegId: "11B00000"
    }
  );
  assert.deepEqual(
    days.map((day) => day.date),
    ["2026-07-26", "2026-07-27", "2026-07-31"]
  );
  assert.equal(days[0].sourceType, "MID_REGIONAL");
  assert.equal(days[0].spatialLevel, "FORECAST_REGION");
  assert.equal(days[0].minTemperature, null);
  assert.equal(days[0].maxTemperature, 31);
  assert.equal(days[0].precipitationProbability, 60);
  assert.equal(days[0].precipitationAmount, null);
  assert.equal(days[0].windSpeed, null);

  assert.equal(days[1].minTemperature, 20);
  assert.equal(days[1].precipitationProbability, null);
  assert.ok(days[1].qualityFlags.includes("MID_LAND_HALF_DAY_MISSING"));

  assert.equal(days[2].minTemperature, null);
  assert.equal(days[2].maxTemperature, null);
  assert.equal(days[2].precipitationProbability, 40);
});

test("mid KMA adapter calls getMidTa and getMidLandFcst separately and caches the join", async () => {
  const requestedUrls = [];
  const adapter = createKmaMidForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_MID_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedUrls.push(parsed);
      if (parsed.pathname.endsWith("/getMidTa")) {
        return jsonResponse(MID_TEMPERATURE_FIXTURE);
      }
      if (parsed.pathname.endsWith("/getMidLandFcst")) {
        return jsonResponse(MID_LAND_FIXTURE);
      }
      throw new Error("unexpected KMA mid operation");
    },
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  const parameters = {
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
    tmFc: "202607230600"
  };
  const live = await adapter.getForecast(parameters);
  const cached = await adapter.getForecast(parameters);

  assert.equal(live.adapterState, "SUCCESS");
  assert.equal(live.deliveryState, "LIVE");
  assert.equal(cached.deliveryState, "CACHE");
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every((url) => url.protocol === "https:"));
  assert.equal(
    requestedUrls.find((url) => url.pathname.endsWith("/getMidTa"))
      .searchParams.get("regId"),
    "11B10101"
  );
  assert.equal(
    requestedUrls.find((url) => url.pathname.endsWith("/getMidLandFcst"))
      .searchParams.get("regId"),
    "11B00000"
  );
  assert.deepEqual(cached.data.days, live.data.days);
});

test("mid KMA preserves one surviving source but marks a non-cacheable partial provider failure", async () => {
  let calls = 0;
  const adapter = createKmaMidForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_MID_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      calls += 1;
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/getMidTa")
        ? jsonResponse(MID_TEMPERATURE_FIXTURE)
        : jsonResponse({ hidden: "provider detail" }, 503);
    }
  });
  const parameters = {
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
    tmFc: "202607230600"
  };
  const first = await adapter.getForecast(parameters);
  assert.equal(first.adapterState, "SUCCESS");
  assert.equal(first.deliveryState, "LIVE");
  assert.equal(first.data.days.length, 2);
  assert.ok(first.qualityFlags.includes("PARTIAL_PROVIDER_FAILURE"));
  assert.ok(
    first.qualityFlags.includes("MID_LAND_PROVIDER_SERVER_ERROR")
  );
  assert.equal(first.data.days[0].maxTemperature, 31);
  assert.equal(first.data.days[0].precipitationProbability, null);

  const callsAfterFirst = calls;
  const second = await adapter.getForecast(parameters);
  assert.equal(second.deliveryState, "LIVE");
  assert.ok(calls > callsAfterFirst);
});

test("mid KMA legacy single regId mapping makes zero provider calls", async () => {
  let calls = 0;
  const adapter = createKmaMidForecastAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KMA_MID_CONTRACT_VERSION,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    }
  });
  const result = await adapter.getForecast({
    regId: "11B00000",
    tmFc: "202607230600"
  });
  assert.equal(result.adapterState, "UNSUPPORTED");
  assert.equal(result.deliveryState, "UNAVAILABLE");
  assert.equal(calls, 0);
});

const SOIL_CONTRACT = VERIFIED_SOIL_V2_CONTRACT;
const SOIL_AREA_CODE = "4717000000";

const SOIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><result_Code>200</result_Code><result_Msg>정상</result_Msg></header>
  <body><items><item>
    <stdg_Cd>${SOIL_AREA_CODE}</stdg_Cd>
    <bjd_Nm>경상북도 안동시</bjd_Nm>
    <acid_Pfld1_Area>10</acid_Pfld1_Area>
    <acid_Pfld2_Area>10</acid_Pfld2_Area>
    <acid_Pfld3_Area>20</acid_Pfld3_Area>
    <acid_Pfld4_Area>30</acid_Pfld4_Area>
    <acid_Pfld5_Area>20</acid_Pfld5_Area>
    <acid_Pfld6_Area>10</acid_Pfld6_Area>
  </item></items></body>
</response>`;

test("Soil V2 accepts only interval/area arrays and never creates a first-row representative", () => {
  const result = parseSoilV2(SOIL_XML, {
    contract: SOIL_CONTRACT,
    landUse: "PFLD",
    requestedAreaCode: SOIL_AREA_CODE
  });
  assert.equal(result.contractVersion, SOIL_CONTRACT.version);
  assert.equal(result.metrics.length, 1);
  assert.equal(result.metrics[0].intervals.length, 6);
  assert.equal(result.metrics[0].totalValidArea, 100);
  assert.equal(result.metrics[0].areaUnit, "ha");
  assert.equal(result.metrics[0].unit, "pH");
  assert.equal(result.metrics[0].boundarySemanticsVerified, true);
  assert.equal(result.metrics[0].areaToleranceVerified, true);
  assert.equal(result.metrics[0].areaTolerance, 0);
  assert.equal("representativeValue" in result.metrics[0], false);
  assert.equal("value" in result.metrics[0], false);
  assert.equal("mean" in result.metrics[0], false);
});

test("Soil V2 missing contract version or official field map is UNSUPPORTED", () => {
  assert.throws(
    () =>
      parseSoilV2(SOIL_XML, {
        contract: { ...SOIL_CONTRACT, version: "" },
        landUse: "PFLD"
      }),
    UnsupportedContractError
  );
  assert.throws(
    () =>
      parseSoilV2(SOIL_XML, {
        contract: {
          ...SOIL_CONTRACT,
          responseFields: {
            ...SOIL_CONTRACT.responseFields,
            areaCode: "otherCode"
          }
        },
        landUse: "PFLD"
      }),
    UnsupportedContractError
  );
});

test("Soil V2 empty, '-', and missing required numeric tags never become zero", () => {
  for (const replacement of ["", "-", null]) {
    const xml =
      replacement === null
        ? SOIL_XML.replace("<acid_Pfld1_Area>10</acid_Pfld1_Area>", "")
        : SOIL_XML.replace(
            "<acid_Pfld1_Area>10</acid_Pfld1_Area>",
            `<acid_Pfld1_Area>${replacement}</acid_Pfld1_Area>`
          );
    assert.throws(
      () =>
        parseSoilV2(xml, {
          contract: SOIL_CONTRACT,
          landUse: "PFLD",
          requestedAreaCode: SOIL_AREA_CODE
        }),
      SchemaChangedError
    );
  }
});

test("Soil V2 classifies an official all-dash land-use distribution as NO_DATA", () => {
  const xml = SOIL_XML
    .replaceAll("acid_Pfld", "acid_Fruit")
    .replace(
      /(<acid_Fruit[1-6]_Area>)\d+(<\/acid_Fruit[1-6]_Area>)/gu,
      "$1-$2",
    );
  assert.throws(
    () =>
      parseSoilV2(xml, {
        contract: SOIL_CONTRACT,
        landUse: "FRUIT",
        requestedAreaCode: SOIL_AREA_CODE
      }),
    (error) => error.adapterState === "NO_DATA"
  );
});

test("Soil V2 rejects DTDs, provider no-data, and a mismatched legal area", () => {
  assert.throws(
    () =>
      parseSoilV2(
        '<!DOCTYPE response [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><response/>',
        { contract: SOIL_CONTRACT, landUse: "PFLD" }
      ),
    SchemaChangedError
  );
  assert.throws(
    () =>
      parseSoilV2(
        "<response><header><result_Code>301</result_Code></header></response>",
        { contract: SOIL_CONTRACT, landUse: "PFLD" }
      ),
    (error) => error.adapterState === "NO_DATA"
  );
  assert.throws(
    () =>
      parseSoilV2(SOIL_XML, {
        contract: SOIL_CONTRACT,
        landUse: "PFLD",
        requestedAreaCode: "4717010100"
      }),
    SchemaChangedError
  );
});

test("Soil adapter returns success, NO_DATA, and SCHEMA_CHANGED envelopes from XML fixtures", async (t) => {
  const cases = [
    { name: "success", xml: SOIL_XML, state: "SUCCESS" },
    {
      name: "empty",
      xml: "<response><header><result_Code>301</result_Code></header></response>",
      state: "NO_DATA"
    },
    {
      name: "schema",
      xml: SOIL_XML.replace("<acid_Pfld6_Area>10</acid_Pfld6_Area>", ""),
      state: "SCHEMA_CHANGED"
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const adapter = createSoilV2Adapter({
        enabled: true,
        apiKey: "fixture-key",
        contract: SOIL_CONTRACT,
        fetchImpl: async () => textResponse(fixture.xml)
      });
      const result = await adapter.getDistribution({
        verifiedSoilAreaCode: SOIL_AREA_CODE,
        landUse: "PFLD"
      });
      assert.equal(result.adapterState, fixture.state);
      if (fixture.state === "SUCCESS") {
        assert.equal(result.data.metrics[0].intervals.length, 6);
        assert.equal(result.distanceKm, null);
      } else {
        assert.equal(result.deliveryState, "UNAVAILABLE");
        assert.equal(result.data, null);
      }
    });
  }
});

test("unfrozen Soil V2 and null verified area key perform zero external calls", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  const unfrozen = createSoilV2Adapter({
    enabled: true,
    apiKey: "fixture-key",
    contract: { ...SOIL_CONTRACT, frozen: false },
    fetchImpl
  });
  const unsupported = await unfrozen.getDistribution({
    verifiedSoilAreaCode: SOIL_AREA_CODE,
    landUse: "PFLD"
  });
  assert.equal(unsupported.adapterState, "UNSUPPORTED");

  const noKey = createSoilV2Adapter({
    enabled: true,
    apiKey: "fixture-key",
    contract: SOIL_CONTRACT,
    fetchImpl
  });
  const unavailable = await noKey.getDistribution({
    verifiedSoilAreaCode: null,
    landUse: "PFLD"
  });
  assert.equal(unavailable.deliveryState, "UNAVAILABLE");
  assert.ok(
    unavailable.qualityFlags.includes("VERIFIED_SOIL_AREA_CODE_MISSING")
  );
  assert.equal(calls, 0);
});

test("structurally valid Soil contracts with arbitrary versions perform zero fetches", async () => {
  let calls = 0;
  const adapter = createSoilV2Adapter({
    enabled: true,
    apiKey: "fixture-key",
    contract: {
      ...SOIL_CONTRACT,
      version: "arbitrary-structurally-valid-soil-contract"
    },
    fetchImpl: async () => {
      calls += 1;
      return textResponse(SOIL_XML);
    }
  });
  const result = await adapter.getDistribution({
    verifiedSoilAreaCode: SOIL_AREA_CODE,
    landUse: "PFLD"
  });
  assert.equal(result.adapterState, "UNSUPPORTED");
  assert.equal(result.deliveryState, "UNAVAILABLE");
  assert.ok(result.qualityFlags.includes("PROVIDER_CONTRACT_UNSUPPORTED"));
  assert.equal(calls, 0);
});

test("same-version Soil semantic contract drift performs zero fetches", async (t) => {
  const tamperedContracts = [
    {
      name: "metric unit",
      contract: {
        ...SOIL_CONTRACT,
        metricUnits: { PH: "kg/kg" }
      }
    },
    {
      name: "field mapping",
      contract: {
        ...SOIL_CONTRACT,
        responseFields: {
          ...SOIL_CONTRACT.responseFields,
          areaCode: "otherCode"
        }
      }
    },
    {
      name: "boundary mapping",
      contract: {
        ...SOIL_CONTRACT,
        landUses: {
          ...SOIL_CONTRACT.landUses,
          PFLD: {
            ...SOIL_CONTRACT.landUses.PFLD,
            intervals: SOIL_CONTRACT.landUses.PFLD.intervals.map(
              (interval, index) =>
                index === 0 ? { ...interval, upperInclusive: false } : interval
            )
          }
        }
      }
    },
    {
      name: "area unit",
      contract: {
        ...SOIL_CONTRACT,
        areaUnit: "m2"
      }
    },
    {
      name: "area tolerance",
      contract: {
        ...SOIL_CONTRACT,
        areaSumTolerance: 1
      }
    },
    {
      name: "request parameter meaning",
      contract: {
        ...SOIL_CONTRACT,
        requestFields: {
          ...SOIL_CONTRACT.requestFields,
          areaCode: "legalDongCode"
        }
      }
    },
    {
      name: "supported metric set",
      contract: {
        ...SOIL_CONTRACT,
        supportedMetrics: ["PH", "ORGANIC_MATTER"],
        metricUnits: {
          ...SOIL_CONTRACT.metricUnits,
          ORGANIC_MATTER: "g/kg"
        }
      }
    },
    {
      name: "unreviewed runtime property",
      contract: {
        ...SOIL_CONTRACT,
        defaultYear: 2025
      }
    }
  ];

  for (const fixture of tamperedContracts) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const adapter = createSoilV2Adapter({
        enabled: true,
        apiKey: "fixture-key",
        contract: fixture.contract,
        fetchImpl: async () => {
          calls += 1;
          return textResponse(SOIL_XML);
        }
      });
      const result = await adapter.getDistribution({
        verifiedSoilAreaCode: SOIL_AREA_CODE,
        landUse: "PFLD"
      });
      assert.equal(result.adapterState, "UNSUPPORTED");
      assert.equal(result.deliveryState, "UNAVAILABLE");
      assert.ok(
        result.qualityFlags.includes("PROVIDER_CONTRACT_UNSUPPORTED")
      );
      assert.equal(calls, 0);
    });
  }
});

test("custom Kakao and Soil endpoints are disclosed without query secrets", async () => {
  const kakao = createKakaoAdapter({
    enabled: true,
    apiKey: "fixture-key",
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    endpoint:
      "https://dapi.kakao.com/custom/address.json?embeddedSecret=hidden",
    fetchImpl: async () =>
      jsonResponse({
        documents: [
          kakaoDocument({
            name: "후보",
            x: "126.9",
            y: "37.5",
            code: "1114010300"
          })
        ]
      })
  });
  const kakaoResult = await kakao.searchLocations("서울");
  assert.equal(
    kakaoResult.sourceUrl,
    "https://dapi.kakao.com/custom/address.json"
  );
  assert.equal(kakaoResult.sourceUrl.includes("hidden"), false);

  const soil = createSoilV2Adapter({
    enabled: true,
    apiKey: "fixture-key",
    contract: SOIL_CONTRACT,
    endpoint:
      "https://apis.data.go.kr/custom/soil.xml?serviceKey=hidden",
    fetchImpl: async () => textResponse(SOIL_XML)
  });
  const soilResult = await soil.getDistribution({
    verifiedSoilAreaCode: SOIL_AREA_CODE,
    landUse: "PFLD"
  });
  assert.equal(
    soilResult.sourceUrl,
    "https://apis.data.go.kr/custom/soil.xml"
  );
  assert.equal(soilResult.sourceUrl.includes("hidden"), false);
});

test("Soil adapter sends the official legal-area parameter and caches per land use", async () => {
  let requestedUrl;
  let calls = 0;
  const adapter = createSoilV2Adapter({
    enabled: true,
    apiKey: "fixture-key",
    contract: SOIL_CONTRACT,
    fetchImpl: async (url) => {
      calls += 1;
      requestedUrl = url;
      return textResponse(SOIL_XML);
    }
  });
  const result = await adapter.getDistribution({
    verifiedSoilAreaCode: SOIL_AREA_CODE,
    landUse: "PFLD"
  });
  const cached = await adapter.getDistribution({
    verifiedSoilAreaCode: SOIL_AREA_CODE,
    landUse: "PFLD"
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(cached.deliveryState, "CACHE");
  assert.equal(result.data.landUse, "PFLD");
  assert.equal(
    requestedUrl.pathname,
    "/1390802/SoilEnviron/SoilExamStat/V2/getFarmExamPhInfo"
  );
  assert.equal(requestedUrl.searchParams.get("STDG_CD"), SOIL_AREA_CODE);
  assert.equal(requestedUrl.searchParams.has("year"), false);
  assert.equal(calls, 1);
});
