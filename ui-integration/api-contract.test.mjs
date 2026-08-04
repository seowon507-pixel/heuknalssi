import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  buildAnalysisRequest,
  buildAnalysisRequests,
  buildCropCycleRequests,
  createIdempotencyKey,
} from "./api-contract.mjs";

const TOKEN = "candidate_token_123";

test("planning potato maps to a confirmed LAND_SEARCH request", () => {
  assert.deepEqual(
    buildAnalysisRequest(
      {
        situation: "planning",
        crop: "potato",
        season: "highland-summer",
        growth: "early",
        saveConsent: true,
      },
      TOKEN,
    ),
    {
      usageMode: "LAND_SEARCH",
      location: { candidateToken: TOKEN, userConfirmed: true },
      crop: "POTATO",
      cultivationMode: "OPEN_FIELD",
      season: {
        kind: "CUSTOM",
        profileId: "CUSTOM",
        startMonth: 4,
        endMonth: 9,
        userConfirmed: true,
      },
      options: {
        includeSmartfarmBenchmark: false,
        includeSatelliteObservation: false,
        saveConsent: true,
      },
    },
  );
});

test("generic growing stage stays explicit but does not impersonate a reviewed crop stage", () => {
  const request = buildAnalysisRequest(
    {
      situation: "growing",
      crop: "cucumber",
      cultivation: "facility-water",
      season: "autumn-winter",
      growth: "middle",
    },
    TOKEN,
  );

  assert.equal(request.usageMode, "ACTIVE_GROWING");
  assert.equal(request.cultivationMode, "FACILITY_HYDRO");
  assert.equal(request.options.includeSmartfarmBenchmark, false);
  assert.deepEqual(request.season, {
    kind: "CUSTOM",
    profileId: "CUSTOM",
    startMonth: 9,
    endMonth: 2,
    userConfirmed: true,
  });
  assert.equal(request.growthStage, "UNSPECIFIED");
});

test("reviewed crop-specific stages map only in their supported context", () => {
  assert.equal(
    buildAnalysisRequest(
      {
        situation: "growing",
        crop: "pear",
        growth: "flowering",
      },
      TOKEN,
    ).growthStage,
    "FLOWERING",
  );
  assert.equal(
    buildAnalysisRequest(
      {
        situation: "growing",
        crop: "potato",
        season: "highland-summer",
        growth: "tuber-bulking",
      },
      TOKEN,
    ).growthStage,
    "TUBER_BULKING",
  );
  assert.throws(
    () =>
      buildAnalysisRequest(
        {
          situation: "growing",
          crop: "cucumber",
          cultivation: "facility-soil",
          season: "summer",
          growth: "flowering",
        },
        TOKEN,
      ),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "GROWTH_STAGE_UNSUPPORTED",
  );
});

test("apple uses the reviewed annual profile selected by the backend", () => {
  const request = buildAnalysisRequest(
    {
      situation: "planning",
      crop: "apple",
      season: "annual",
    },
    TOKEN,
  );
  assert.equal(request.cultivationMode, "OPEN_FIELD");
  assert.equal("season" in request, false);
  assert.equal(request.options.includeSmartfarmBenchmark, false);
});

test("multiple active crops become independent backend requests", () => {
  const requests = buildAnalysisRequests(
    {
      situation: "growing",
      crops: ["apple", "cucumber", "apple"],
      cropSettings: {
        apple: {
          growth: "early",
        },
        cucumber: {
          cultivation: "facility-soil",
          season: "summer",
          growth: "middle",
        },
      },
      saveConsent: false,
    },
    TOKEN,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].crop, "APPLE");
  assert.equal(requests[0].usageMode, "ACTIVE_GROWING");
  assert.equal("season" in requests[0], false);
  assert.equal(requests[0].growthStage, "UNSPECIFIED");
  assert.equal(requests[1].crop, "CUCUMBER");
  assert.equal(requests[1].cultivationMode, "FACILITY_SOIL");
  assert.equal(requests[1].growthStage, "UNSPECIFIED");
  assert.deepEqual(requests[1].season, {
    kind: "CUSTOM",
    profileId: "CUSTOM",
    startMonth: 6,
    endMonth: 8,
    userConfirmed: true,
  });
  assert.equal(requests[0].options.includeSmartfarmBenchmark, false);
  assert.equal(requests[1].options.includeSmartfarmBenchmark, false);
});

test("multiple planning crops remain LAND_SEARCH without a growth-stage requirement", () => {
  const requests = buildAnalysisRequests(
    {
      situation: "planning",
      crops: ["apple", "potato"],
      cropSettings: {
        apple: {},
        potato: { season: "unknown" },
      },
    },
    TOKEN,
  );

  assert.deepEqual(
    requests.map(({ usageMode, crop, growthStage }) => ({
      usageMode,
      crop,
      growthStage,
    })),
    [
      { usageMode: "LAND_SEARCH", crop: "APPLE", growthStage: undefined },
      { usageMode: "LAND_SEARCH", crop: "POTATO", growthStage: undefined },
    ],
  );
});

test("재배주기 요청은 작물별 cycle 최소 필드만 서버 어댑터에 전달한다", () => {
  const requests = buildCropCycleRequests({
    situation: "growing",
    crops: ["apple", "potato"],
    cropSettings: {
      apple: {
        cycle: {
          seasonId: "season-apple-2026",
          anchorType: "FLOWERING",
          anchorDate: "2026-04-15",
          status: "ACTIVE",
        },
      },
      potato: {
        cycle: {
          seasonId: "season-potato-2026",
          anchorType: "SOWING",
          anchorDate: "2026-06-15",
          status: "ACTIVE",
          ignored: "not-forwarded",
        },
      },
    },
  });

  assert.deepEqual(requests, [
    {
      crop: "apple",
      cropId: "APPLE",
      input: {
        seasonId: "season-apple-2026",
        anchorType: "FLOWERING",
        anchorDate: "2026-04-15",
        status: "ACTIVE",
      },
    },
    {
      crop: "potato",
      cropId: "POTATO",
      input: {
        seasonId: "season-potato-2026",
        anchorType: "SOWING",
        anchorDate: "2026-06-15",
        status: "ACTIVE",
      },
    },
  ]);
});

test("SmartFarm 참고자료는 사전점검 READY와 지원 조합을 모두 만족할 때만 요청한다", () => {
  const supportedContexts = [
    { crop: "cucumber", cultivation: "facility-soil", season: "spring" },
    { crop: "apple" },
    { crop: "potato", season: "spring" },
  ];
  for (const context of supportedContexts) {
    const disabledRequest = buildAnalysisRequest(
      { situation: "planning", ...context },
      TOKEN,
    );
    assert.equal(disabledRequest.options.includeSmartfarmBenchmark, false);

    const enabledRequest = buildAnalysisRequest(
      {
        situation: "planning",
        ...context,
        smartfarmAvailable: true,
      },
      TOKEN,
    );
    assert.equal(
      enabledRequest.options.includeSmartfarmBenchmark,
      true,
      `${context.crop} 지원 조합은 READY일 때 SmartFarm을 요청해야 한다`,
    );
  }

  const unsupportedContexts = [
    { crop: "cucumber", cultivation: "outdoor", season: "spring" },
    { crop: "pear" },
    { crop: "lettuce", cultivation: "facility-soil", season: "spring" },
  ];
  for (const context of unsupportedContexts) {
    const request = buildAnalysisRequest(
      {
        situation: "planning",
        ...context,
        smartfarmAvailable: true,
      },
      TOKEN,
    );
    assert.equal(
      request.options.includeSmartfarmBenchmark,
      false,
      `${context.crop} 미지원 조합에 SmartFarm이 포함되면 안 된다`,
    );
  }
});

test("active crop analysis keeps an unconfirmed season explicitly unknown", () => {
  const [request] = buildAnalysisRequests(
    {
      crops: ["potato"],
      cropSettings: { potato: {} },
      growth: "middle",
    },
    TOKEN,
  );

  assert.deepEqual(request.season, {
    kind: "UNKNOWN",
    profileId: "UNKNOWN",
    startMonth: null,
    endMonth: null,
    userConfirmed: true,
  });
});

test("multiple crop request requires at least one selected crop", () => {
  assert.throws(
    () => buildAnalysisRequests({ crops: [], growth: "early" }, TOKEN),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "CROP_REQUIRED" &&
      error.field === "crop",
  );
});

test("unknown season is represented explicitly instead of guessed", () => {
  assert.deepEqual(
    buildAnalysisRequest(
      {
        situation: "planning",
        crop: "lettuce",
        cultivation: "outdoor",
        season: "unknown",
      },
      TOKEN,
    ).season,
    {
      kind: "UNKNOWN",
      profileId: "UNKNOWN",
      startMonth: null,
      endMonth: null,
      userConfirmed: true,
    },
  );
});

test("unknown cultivation is blocked at the UI contract boundary", () => {
  assert.throws(
    () =>
      buildAnalysisRequest(
        {
          situation: "planning",
          crop: "cucumber",
          cultivation: "unknown",
          season: "spring",
        },
        TOKEN,
      ),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "CULTIVATION_CONFIRMATION_REQUIRED" &&
      error.field === "cultivation",
  );
});

test("ACTIVE_GROWING keeps an unknown stage explicit as UNSPECIFIED", () => {
  assert.equal(
    buildAnalysisRequest(
      {
        situation: "growing",
        crop: "potato",
        season: "spring",
        growth: "unknown",
      },
      TOKEN,
    ).growthStage,
    "UNSPECIFIED",
  );
});

test("a location candidate token is mandatory", () => {
  assert.throws(
    () =>
      buildAnalysisRequest(
        {
          situation: "planning",
          crop: "potato",
          season: "spring",
        },
        "",
      ),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "LOCATION_CANDIDATE_REQUIRED",
  );
});

test("idempotency keys are namespaced and deterministic under injection", () => {
  assert.equal(
    createIdempotencyKey(() => "00000000-0000-4000-8000-000000000000"),
    "soil-weather-ui-00000000-0000-4000-8000-000000000000",
  );
});

test("a registered soil test rides along with the analysis request", () => {
  const request = buildAnalysisRequest(
    {
      situation: "planning",
      crop: "apple",
      soilTest: {
        ph: "6.1",
        organicMatter: "26",
        sampledOn: "2026-03-15",
        issuer: "  안동시농업기술센터  ",
        userConfirmed: true,
      },
    },
    TOKEN,
  );

  assert.deepEqual(request.soilTest, {
    ph: 6.1,
    organicMatter: 26,
    sampledOn: "2026-03-15",
    issuer: "안동시농업기술센터",
    userConfirmed: true,
  });
});

test("an analysis without a registered soil test omits the field entirely", () => {
  const request = buildAnalysisRequest(
    { situation: "planning", crop: "apple" },
    TOKEN,
  );
  assert.equal(Object.hasOwn(request, "soilTest"), false);

  const emptyPh = buildAnalysisRequest(
    { situation: "planning", crop: "apple", soilTest: { sampledOn: "2026-03-15" } },
    TOKEN,
  );
  assert.equal(Object.hasOwn(emptyPh, "soilTest"), false);
});

test("soil test values outside the reviewed range are rejected before sending", () => {
  assert.throws(
    () =>
      buildAnalysisRequest(
        {
          situation: "planning",
          crop: "apple",
          soilTest: { ph: 99, sampledOn: "2026-03-15" },
        },
        TOKEN,
      ),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "SOIL_TEST_OUT_OF_RANGE",
  );
  assert.throws(
    () =>
      buildAnalysisRequest(
        { situation: "planning", crop: "apple", soilTest: { ph: 6.1 } },
        TOKEN,
      ),
    (error) => error.code === "SOIL_TEST_DATE_REQUIRED",
  );
});

test("buildAnalysisRequests forwards the registered soil test to every crop", () => {
  const requests = buildAnalysisRequests(
    {
      situation: "planning",
      crops: ["apple", "potato"],
      cropSettings: { potato: { season: "spring" } },
      soilTest: { ph: 6.1, sampledOn: "2026-03-15", userConfirmed: true },
    },
    TOKEN,
  );

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.soilTest?.ph, 6.1);
    assert.equal(request.soilTest?.sampledOn, "2026-03-15");
  }
});

test("buildAnalysisRequests omits soilTest when none is registered", () => {
  const requests = buildAnalysisRequests(
    { situation: "planning", crops: ["apple"] },
    TOKEN,
  );
  assert.equal(Object.hasOwn(requests[0], "soilTest"), false);
});
