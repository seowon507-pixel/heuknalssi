import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  buildAnalysisRequest,
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

test("growing cucumber maps cultivation, wrapped season, and growth stage", () => {
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
  assert.deepEqual(request.season, {
    kind: "CUSTOM",
    profileId: "CUSTOM",
    startMonth: 9,
    endMonth: 2,
    userConfirmed: true,
  });
  assert.equal(request.growthStage, "MIDDLE");
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
