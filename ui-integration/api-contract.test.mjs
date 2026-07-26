import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  buildAnalysisRequest,
  buildAnalysisRequests,
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
        includeSmartfarmBenchmark: true,
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
  assert.equal(request.options.includeSmartfarmBenchmark, true);
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
        season: "current",
        analysisMonth: 7,
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
          season: "current",
          analysisMonth: 7,
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
  assert.equal(request.options.includeSmartfarmBenchmark, true);
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
  assert.equal(requests[0].options.includeSmartfarmBenchmark, true);
  assert.equal(requests[1].options.includeSmartfarmBenchmark, true);
});

test("multiple planning crops remain LAND_SEARCH without a growth-stage requirement", () => {
  const requests = buildAnalysisRequests(
    {
      situation: "planning",
      crops: ["apple", "potato"],
      analysisMonth: 7,
      cropSettings: {
        apple: {},
        potato: { season: "current" },
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

test("SmartFarm is requested only for exact supported crop and cultivation contexts", () => {
  const cucumberOutdoor = buildAnalysisRequest(
    {
      situation: "planning",
      crop: "cucumber",
      cultivation: "outdoor",
      season: "spring",
    },
    TOKEN,
  );
  const lettuceFacility = buildAnalysisRequest(
    {
      situation: "planning",
      crop: "lettuce",
      cultivation: "facility-soil",
      season: "spring",
    },
    TOKEN,
  );

  assert.equal(
    cucumberOutdoor.options.includeSmartfarmBenchmark,
    false,
  );
  assert.equal(
    lettuceFacility.options.includeSmartfarmBenchmark,
    false,
  );
});

test("active crop analysis uses the current calendar month without asking for a season", () => {
  const [request] = buildAnalysisRequests(
    {
      crops: ["potato"],
      cropSettings: { potato: {} },
      analysisMonth: 7,
      growth: "middle",
    },
    TOKEN,
  );

  assert.deepEqual(request.season, {
    kind: "CUSTOM",
    profileId: "CUSTOM",
    startMonth: 7,
    endMonth: 7,
    userConfirmed: true,
  });
});

test("automatic current-date analysis rejects an invalid device month", () => {
  assert.throws(
    () =>
      buildAnalysisRequests(
        {
          crops: ["lettuce"],
          cropSettings: {
            lettuce: { cultivation: "facility-soil" },
          },
          analysisMonth: 13,
          growth: "early",
        },
        TOKEN,
      ),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "ANALYSIS_MONTH_INVALID" &&
      error.field === "season",
  );
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
