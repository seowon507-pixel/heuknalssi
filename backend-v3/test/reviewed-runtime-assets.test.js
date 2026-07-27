import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_SOIL_V2_CONTRACT,
} from "../src/adapters/index.js";
import {
  resolveLocationKeys,
  validateVerifiedLocationMappings,
} from "../src/application/index.js";
import {
  createRuleRegistry,
  evaluateForecastRisks,
  validateRuleRegistry,
} from "../src/domain/index.js";
import { createBackend } from "../server/app.js";
import { REVIEWED_CROP_RULES } from "../runtime/reviewed-crop-rules.js";
import { REVIEWED_LOCATION_MAPPINGS } from "../runtime/reviewed-location-mappings.js";
import { createRuntimeOptions } from "../runtime/reviewed-runtime.mjs";

const REVIEW_CLOCK = () => new Date("2026-07-25T12:00:00.000Z");
const REVIEWED_FORECAST_CONTEXTS = [
  ["APPLE", "OPEN_FIELD", "UNSPECIFIED"],
  ["PEAR", "OPEN_FIELD", "UNSPECIFIED"],
  ["PEAR", "OPEN_FIELD", "FLOWERING"],
  ["POTATO", "OPEN_FIELD", "UNSPECIFIED"],
  ["POTATO", "OPEN_FIELD", "TUBER_BULKING"],
  ["CUCUMBER", "OPEN_FIELD", "UNSPECIFIED"],
  ["CUCUMBER", "FACILITY_SOIL", "UNSPECIFIED"],
  ["CUCUMBER", "FACILITY_HYDRO", "UNSPECIFIED"],
  ["LETTUCE", "OPEN_FIELD", "UNSPECIFIED"],
  ["LETTUCE", "FACILITY_SOIL", "UNSPECIFIED"],
  ["LETTUCE", "FACILITY_SOIL", "FLOWER_DIFFERENTIATION"],
  ["LETTUCE", "FACILITY_HYDRO", "UNSPECIFIED"],
  ["LETTUCE", "FACILITY_HYDRO", "FLOWER_DIFFERENTIATION"],
];

test("reviewed crop rules pass the strict activation gate", () => {
  const validation = validateRuleRegistry(REVIEWED_CROP_RULES);

  assert.equal(validation.invalidRules.length, 0);
  assert.equal(validation.validRules.length, REVIEWED_CROP_RULES.length);
  assert.deepEqual(
    [...new Set(validation.validRules.map((rule) => rule.crop))].sort(),
    ["APPLE", "CUCUMBER", "LETTUCE", "PEAR", "POTATO"],
  );
  // 검수 묶음마다 검수일이 다르다. 날짜를 하나로 못 박는 대신 모든 규칙이
  // 실제 검수일(ISO)과 HTTPS 출처를 갖추었는지 확인한다.
  const REVIEWED_DATES = new Set(["2026-07-25", "2026-07-27"]);
  assert.ok(
    validation.validRules.every(
      (rule) =>
        REVIEWED_DATES.has(rule.reviewedAt) &&
        rule.sourceUrl.startsWith("https://") &&
        typeof rule.sourceTitle === "string" &&
        rule.sourceTitle !== "" &&
        typeof rule.sourcePageOrTable === "string" &&
        rule.sourcePageOrTable !== "",
    ),
  );
  assert.ok(
    validation.validRules
      .filter((rule) => rule.module === "FORECAST")
      .every(
        (rule) =>
          rule.use === "FORECAST_RISK" &&
          typeof rule.guidance?.headline === "string" &&
          typeof rule.guidance?.reason === "string" &&
          Array.isArray(rule.guidance?.actions) &&
          rule.guidance.actions.length > 0 &&
          rule.guidance.actions.every(
            (action) => typeof action === "string" && action.length > 0,
          ) &&
          typeof rule.guidance.recheck === "string" &&
          rule.guidance.recheck.length > 0 &&
          rule.guidance.sourceUrl.startsWith("https://"),
      ),
  );
});

test("all reviewed crop, cultivation, and growth contexts reach a complete forecast conclusion", () => {
  const days = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-07-${String(index + 24).padStart(2, "0")}`,
    sourceType: "SHORT_GRID",
    sourceFreshness: "CURRENT",
    minTemperature: 15,
    maxTemperature: 24,
  }));

  for (const [crop, cultivationMode, growthStage] of REVIEWED_FORECAST_CONTEXTS) {
    const result = evaluateForecastRisks({
      days,
      rules: REVIEWED_CROP_RULES,
      crop,
      cultivationMode,
      growthStage,
      unitsByMetric: {
        minTemperature: "℃",
        maxTemperature: "℃",
      },
    });

    assert.equal(
      result.state,
      "READY",
      `${crop}/${cultivationMode}/${growthStage}`,
    );
    assert.equal(
      result.noActiveRisksConfirmed,
      true,
      `${crop}/${cultivationMode}/${growthStage}`,
    );
    assert.ok(result.ruleEvaluations.length > 0);
  }
});

test("reviewed forecast contexts expose the exact missing date and metric instead of an incomplete judgement", () => {
  const completeDays = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-07-${String(index + 24).padStart(2, "0")}`,
    sourceType: "SHORT_GRID",
    sourceFreshness: "CURRENT",
    minTemperature: 15,
    maxTemperature: 24,
  }));

  for (const [crop, cultivationMode, growthStage] of REVIEWED_FORECAST_CONTEXTS) {
    const days = completeDays.map((day, index) =>
      index === 2 ? { ...day, maxTemperature: null } : day,
    );
    const result = evaluateForecastRisks({
      days,
      rules: REVIEWED_CROP_RULES,
      crop,
      cultivationMode,
      growthStage,
      unitsByMetric: {
        minTemperature: "℃",
        maxTemperature: "℃",
      },
    });

    assert.equal(
      result.state,
      "PARTIAL",
      `${crop}/${cultivationMode}/${growthStage}`,
    );
    assert.equal(result.noActiveRisksConfirmed, false);
    assert.ok(
      result.missingMetrics.some(
        ({ date, metric }) =>
          date === "2026-07-26" && metric === "maxTemperature",
      ),
      `${crop}/${cultivationMode}/${growthStage}`,
    );
  }
});

test("minimum-temperature gaps affect only contexts whose reviewed rules require daily lows", () => {
  const days = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-07-${String(index + 24).padStart(2, "0")}`,
    sourceType: "SHORT_GRID",
    sourceFreshness: "CURRENT",
    minTemperature: index === 2 ? null : 15,
    maxTemperature: 24,
  }));
  const lowTemperatureContexts = new Set([
    "PEAR/OPEN_FIELD/FLOWERING",
    "CUCUMBER/OPEN_FIELD/UNSPECIFIED",
    "CUCUMBER/FACILITY_SOIL/UNSPECIFIED",
    "CUCUMBER/FACILITY_HYDRO/UNSPECIFIED",
  ]);

  for (const [crop, cultivationMode, growthStage] of REVIEWED_FORECAST_CONTEXTS) {
    const context = `${crop}/${cultivationMode}/${growthStage}`;
    const result = evaluateForecastRisks({
      days,
      rules: REVIEWED_CROP_RULES,
      crop,
      cultivationMode,
      growthStage,
      unitsByMetric: {
        minTemperature: "℃",
        maxTemperature: "℃",
      },
    });

    assert.equal(
      result.state,
      lowTemperatureContexts.has(context) ? "PARTIAL" : "READY",
      context,
    );
  }
});

test("complete short-range values stay conclusive without mid-range days, while both ranges missing stay on hold", () => {
  const completeShortRange = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-07-${String(index + 24).padStart(2, "0")}`,
    sourceType: "SHORT_GRID",
    sourceFreshness: "CURRENT",
    minTemperature: 15,
    maxTemperature: 24,
  }));

  const shortOnly = evaluateForecastRisks({
    days: completeShortRange,
    rules: REVIEWED_CROP_RULES,
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    growthStage: "UNSPECIFIED",
    unitsByMetric: {
      minTemperature: "℃",
      maxTemperature: "℃",
    },
  });
  const noForecast = evaluateForecastRisks({
    days: [],
    rules: REVIEWED_CROP_RULES,
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    growthStage: "UNSPECIFIED",
    unitsByMetric: {
      minTemperature: "℃",
      maxTemperature: "℃",
    },
  });

  assert.equal(shortOnly.state, "READY");
  assert.equal(shortOnly.noActiveRisksConfirmed, true);
  assert.equal(noForecast.state, "HOLD");
  assert.equal(noForecast.noActiveRisksConfirmed, false);
});

test("custom open-field climate rules activate only selected crop months", () => {
  const registry = createRuleRegistry(REVIEWED_CROP_RULES);
  const request = {
    crop: "POTATO",
    cultivationMode: "OPEN_FIELD",
    growthStage: "UNSPECIFIED",
    season: {
      kind: "CUSTOM",
      profileId: "CUSTOM",
      months: [4, 5, 6],
    },
  };

  const active = registry.resolve(request, "CLIMATE");

  assert.deepEqual(
    active.map((rule) => rule.evaluationPeriod.month),
    [4, 5, 6],
  );
  assert.ok(active.every((rule) => rule.optimalRange.join(":") === "14:23"));
});

test("single targets and facility risks retain their evidence limitations", () => {
  const registry = createRuleRegistry(REVIEWED_CROP_RULES);
  const pearClimate = registry.resolve(
    {
      crop: "PEAR",
      cultivationMode: "OPEN_FIELD",
      season: {
        kind: "PROFILE",
        profileId: "PEAR_OPEN_FIELD_ANNUAL",
      },
    },
    "CLIMATE",
  );
  const cucumberFacilityRisks = registry.resolve(
    {
      crop: "CUCUMBER",
      cultivationMode: "FACILITY_SOIL",
      growthStage: "UNSPECIFIED",
      season: { kind: "NOT_APPLICABLE" },
    },
    "FORECAST",
  );

  assert.equal(pearClimate.length, 1);
  assert.equal(pearClimate[0].use, "SINGLE_TARGET");
  assert.equal(pearClimate[0].target, 20);
  assert.deepEqual(
    cucumberFacilityRisks.map((rule) => rule.comparison.threshold).sort((a, b) => a - b),
    [5, 35],
  );
  assert.ok(
    cucumberFacilityRisks.every(
      (rule) => rule.actionId === "CHECK_FACILITY_WEATHER",
    ),
  );
});

test("reviewed locations provide every P0 mapping and calculate ASOS distance from the confirmed address", () => {
  const validation = validateVerifiedLocationMappings(
    REVIEWED_LOCATION_MAPPINGS,
    { now: REVIEW_CLOCK },
  );

  assert.equal(validation.valid, true);
  // 검수 지역은 늘어난다. 개수를 못 박는 대신 모든 항목이 P0를 갖췄는지 본다.
  const reviewedCount = Object.keys(REVIEWED_LOCATION_MAPPINGS).length;
  assert.ok(reviewedCount >= 6, "검수 지역은 최소 6곳이어야 한다");
  assert.equal(validation.verifiedCount, reviewedCount);
  assert.equal(validation.p0ReadyCount, reviewedCount);
  assert.equal(validation.p0IncompleteAreaCodes.length, 0);

  const resolved = resolveLocationKeys(
    {
      resolutionMode: "ADDRESS_RESOLVED",
      adminAreaCode: "4717010100",
      legalDongCode: "4717010100",
      latitude: 36.5684,
      longitude: 128.7294,
    },
    REVIEWED_LOCATION_MAPPINGS,
    { now: REVIEW_CLOCK },
  );

  assert.equal(resolved.normalStationId, "136");
  assert.equal(resolved.verifiedSoilAreaCode, "4717000000");
  assert.deepEqual(resolved.midForecastRegionIds, {
    temperatureRegId: "11H10501",
    landRegId: "11H10000",
  });
  assert.equal(resolved.observationStationId, "136");
  assert.equal(resolved.observationDistanceKm, 2);
  assert.deepEqual(resolved.shortForecastGrid, { nx: 91, ny: 106 });
});

test("reviewed runtime exposes only rules, mappings, and the public frozen soil contract", async () => {
  const options = await createRuntimeOptions();

  assert.deepEqual(Object.keys(options).sort(), [
    "rules",
    "soilContract",
    "verifiedLocationMappings",
  ]);
  assert.equal(options.rules, REVIEWED_CROP_RULES);
  assert.equal(options.verifiedLocationMappings, REVIEWED_LOCATION_MAPPINGS);
  assert.equal(options.soilContract, VERIFIED_SOIL_V2_CONTRACT);
  assert.equal(JSON.stringify(options.soilContract).includes("serviceKey"), false);
});

test("preflight configures all five reviewed crops while preserving adapter and mapping HOLD gaps", async () => {
  const options = await createRuntimeOptions();
  const backend = createBackend({
    ...options,
    clock: () => Date.parse("2026-07-25T12:00:00.000Z"),
  });

  const preflight = await backend.services.getPreflight();
  const potatoCustom = preflight.ruleRegistry.contextCoverage.find(
    ({ contextId }) =>
      contextId === "POTATO|OPEN_FIELD|CUSTOM|CUSTOM|UNSPECIFIED",
  );
  const cucumberFacility = preflight.ruleRegistry.contextCoverage.find(
    ({ contextId }) =>
      contextId ===
      "CUCUMBER|FACILITY_SOIL|NOT_APPLICABLE|NOT_APPLICABLE|UNSPECIFIED",
  );

  assert.equal(preflight.serviceState, "HOLD");
  assert.deepEqual(preflight.ruleRegistry.configuredCrops, [
    "APPLE",
    "PEAR",
    "CUCUMBER",
    "POTATO",
    "LETTUCE",
  ]);
  assert.equal(potatoCustom.modules.CLIMATE.status, "CONFIGURED");
  assert.equal(potatoCustom.modules.SOIL.status, "CONFIGURED");
  assert.equal(potatoCustom.modules.FORECAST.status, "CONFIGURED");
  assert.equal(cucumberFacility.status, "CONFIGURED");
  assert.equal(
    preflight.locationMappings.verifiedCount,
    Object.keys(REVIEWED_LOCATION_MAPPINGS).length,
  );
  assert.equal(
    preflight.locationMappings.p0ReadyCount,
    Object.keys(REVIEWED_LOCATION_MAPPINGS).length,
  );
});
