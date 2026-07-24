import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationServices } from "../backend-v3/src/application/index.js";
import { createRuleRegistry } from "../backend-v3/src/domain/index.js";
import { createRuntimeOptions } from "./sample-runtime.mjs";

const FIXED_TIME = Date.parse("2026-07-24T03:00:00.000Z");
const clock = () => FIXED_TIME;

test("sample runtime is structurally valid and remains explicitly non-live", async () => {
  const options = await createRuntimeOptions({ clock });
  const registry = createRuleRegistry(options.rules);

  assert.equal(registry.invalidRules.length, 0);
  assert.ok(registry.rules.length > 0);
  assert.equal(Object.keys(options.verifiedLocationMappings).length, 1);

  for (const adapter of Object.values(options.adapters)) {
    const method =
      adapter.searchLocations ??
      adapter.getNormals ??
      adapter.getRecent ??
      adapter.getDistribution ??
      adapter.getForecast;
    const envelope = await method.call(adapter, {});
    assert.equal(envelope.deliveryState, "SAMPLE");
    assert.equal(envelope.freshness, "SAMPLE");
    assert.ok(envelope.qualityFlags.includes("DO_NOT_USE_FOR_FARMING_DECISIONS"));
  }
});

test("sample runtime exercises location, analysis, ownership, and report flow", async () => {
  const options = await createRuntimeOptions({ clock });
  const services = createApplicationServices({ ...options, clock });
  const ownerSessionId = "sample-owner";

  const locations = await services.searchLocations({
    ownerSessionId,
    query: "강원특별자치도 평창군",
  });
  assert.equal(locations.candidates.length, 1);
  assert.equal(locations.sourceState, "SUCCESS");

  const analysis = await services.createAnalysis({
    ownerSessionId,
    input: {
      usageMode: "LAND_SEARCH",
      location: {
        candidateToken: locations.candidates[0].candidateToken,
        userConfirmed: true,
      },
      crop: "CUCUMBER",
      cultivationMode: "OPEN_FIELD",
      season: {
        kind: "CUSTOM",
        profileId: "CUSTOM",
        startMonth: 3,
        endMonth: 5,
        userConfirmed: true,
      },
      options: {
        includeSmartfarmBenchmark: false,
        includeSatelliteObservation: false,
        saveConsent: false,
      },
    },
  });

  assert.equal(analysis.state, "PARTIAL");
  assert.equal(analysis.conditionState, "PARTIAL");
  assert.equal(analysis.riskState, "PARTIAL");
  assert.equal(
    analysis.dataSources.every((source) => source.deliveryState === "SAMPLE"),
    true,
  );
  assert.notEqual(analysis.climate.state, "READY");
  assert.notEqual(analysis.soil.state, "READY");
  assert.notEqual(analysis.forecast.state, "READY");
  assert.equal("score" in analysis, false);

  const strangerLookup = await services.getAnalysis({
    ownerSessionId: "different-owner",
    analysisId: analysis.analysisId,
  });
  assert.equal(strangerLookup, null);

  const requested = await services.requestReport({
    ownerSessionId,
    analysisId: analysis.analysisId,
  });
  assert.equal(requested.analysis.report.state, "PENDING");
  await new Promise((resolve) => setImmediate(resolve));

  const completed = await services.getAnalysis({
    ownerSessionId,
    analysisId: analysis.analysisId,
  });
  assert.equal(completed.report.state, "FALLBACK");
  assert.equal(completed.lifecycle.currentState, "COMPLETE");
});

test("sample annual profile and reviewed UI growth-stage mapping are accepted", async () => {
  const options = await createRuntimeOptions({ clock });
  const services = createApplicationServices({ ...options, clock });
  const ownerSessionId = "sample-apple-owner";
  const locations = await services.searchLocations({
    ownerSessionId,
    query: "경기도 수원시",
  });

  const analysis = await services.createAnalysis({
    ownerSessionId,
    input: {
      usageMode: "ACTIVE_GROWING",
      location: {
        candidateToken: locations.candidates[0].candidateToken,
        userConfirmed: true,
      },
      crop: "APPLE",
      cultivationMode: "OPEN_FIELD",
      growthStage: "EARLY",
      options: {
        includeSmartfarmBenchmark: false,
        includeSatelliteObservation: false,
        saveConsent: false,
      },
    },
  });

  assert.equal(analysis.inputSummary.seasonLabel, "APPLE_OPEN_FIELD_ANNUAL");
  assert.equal(analysis.inputSummary.growthStage, "EARLY");
  assert.equal(analysis.state, "PARTIAL");
});
