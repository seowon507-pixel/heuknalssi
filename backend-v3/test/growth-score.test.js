import assert from "node:assert/strict";
import test from "node:test";

import { calculateGrowthScore } from "../src/domain/index.js";

const CROPS = ["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"];

test("all five crops receive a high score when every applicable axis is suitable", () => {
  for (const crop of CROPS) {
    const result = calculateGrowthScore({
      request: { crop, cultivationMode: "OPEN_FIELD" },
      climate: climateModule(0),
      soil: soilModule({ fitRatio: 1, basis: "USER_SOIL_TEST" }),
      forecast: safeForecastModule(),
      now: "2026-08-03T00:00:00Z",
    });

    assert.equal(result.state, "READY", crop);
    assert.equal(result.score, 96, crop);
    assert.equal(result.label, "양호", crop);
    assert.equal(result.confidence.level, "HIGH", crop);
  }
});

test("regional soil statistics inform but cannot dominate the whole score", () => {
  const lowRegionalSoil = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: soilModule({ fitRatio: 0, basis: "REGIONAL_STATISTICS" }),
    forecast: safeForecastModule(),
  });
  const highRegionalSoil = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: soilModule({ fitRatio: 1, basis: "REGIONAL_STATISTICS" }),
    forecast: safeForecastModule(),
  });

  assert.equal(lowRegionalSoil.components.soil.score, 0);
  assert.equal(lowRegionalSoil.components.soil.trust, 0.25);
  assert.ok(highRegionalSoil.rawScore - lowRegionalSoil.rawScore <= 12);
  assert.ok(
    lowRegionalSoil.components.soil.effectiveWeight /
      lowRegionalSoil.confidence.evidenceStrength <=
      0.12,
  );
  assert.equal(
    lowRegionalSoil.calculation,
    "EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS",
  );
});

test("regional soil raw-score sensitivity stays within 12 points at every forecast coverage", () => {
  for (const coverage of [0.4, 0.6, 0.8, 1]) {
    const low = calculateGrowthScore({
      cultivationMode: "OPEN_FIELD",
      climate: climateModule(0),
      soil: soilModule({ fitRatio: 0, basis: "REGIONAL_STATISTICS" }),
      forecast: forecastWithCoverage(coverage),
    });
    const high = calculateGrowthScore({
      cultivationMode: "OPEN_FIELD",
      climate: climateModule(0),
      soil: soilModule({ fitRatio: 1, basis: "REGIONAL_STATISTICS" }),
      forecast: forecastWithCoverage(coverage),
    });

    assert.ok(
      high.rawScore - low.rawScore <= 12,
      `coverage ${coverage}: ${high.rawScore - low.rawScore}`,
    );
  }
});

test("a warning forecast preserves a risk cap even when other axes are suitable", () => {
  const result = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: soilModule({ fitRatio: 1, basis: "USER_SOIL_TEST" }),
    forecast: warningForecastModule(),
  });

  assert.equal(result.rawScore > 49, true);
  assert.equal(result.score, 49);
  assert.deepEqual(result.scoreCap, {
    value: 49,
    reason: "WARNING_FORECAST",
  });
  assert.equal(result.label, "위험");
});

test("a high-trust field soil result uses a continuous score-plus-20 guardrail", () => {
  const result = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: soilModule({ fitRatio: 0.4, basis: "PROVIDER_SOIL_TEST" }),
    forecast: safeForecastModule(),
  });

  assert.equal(result.components.soil.score, 40);
  assert.equal(result.components.soil.trust, 0.95);
  assert.equal(result.score, 60);
  assert.deepEqual(result.scoreCap, {
    value: 60,
    reason: "FIELD_SOIL_CONTINUOUS_GUARDRAIL",
  });
});

test("field-soil 49.9 to 50.0 cannot cause a discontinuous score jump", () => {
  const scoreAt = (soilScore) => {
    const deviation = 100 / soilScore - 1;
    return calculateGrowthScore({
      cultivationMode: "OPEN_FIELD",
      climate: climateModule(0),
      soil: soilModule({
        fitRatio: 0,
        basis: "USER_SOIL_TEST",
        observedValue: 5 - deviation,
        optimalRange: [5, 6],
      }),
      forecast: safeForecastModule(),
    });
  };
  const below = scoreAt(49.9);
  const boundary = scoreAt(50);

  assert.ok(Math.abs(boundary.score - below.score) <= 1);
  assert.ok(Math.abs(boundary.scoreCap.value - below.scoreCap.value) <= 0.11);
});

test("measured soil departure is gradual rather than an immediate zero", () => {
  const result = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: soilModule({
      fitRatio: 0,
      basis: "USER_SOIL_TEST",
      observedValue: 5.7,
      optimalRange: [5.8, 6.3],
    }),
    forecast: safeForecastModule(),
  });

  assert.equal(result.components.soil.score, 83.33);
  assert.equal(result.score > 80, true);
});

test("missing data remains null, never becomes zero, and lowers evidence strength", () => {
  const result = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    climate: climateModule(0),
    soil: { state: "HOLD", result: { metrics: [] } },
    forecast: safeForecastModule(),
  });

  assert.equal(result.state, "PARTIAL");
  assert.equal(result.score, 94);
  assert.equal(result.components.soil.score, null);
  assert.equal(result.confidence.coverage, 0.7);
  assert.equal(result.confidence.evidenceStrength, 0.59);
  assert.equal(result.confidence.level, "MEDIUM");
  assert.deepEqual(result.confidence.missingComponents, ["soil"]);
});

test("evidence below the minimum is held instead of normalized into confidence", () => {
  const result = calculateGrowthScore({
    cultivationMode: "OPEN_FIELD",
    soil: soilModule({ fitRatio: 1, basis: "REGIONAL_STATISTICS" }),
  });

  assert.equal(result.confidence.evidenceStrength, 0);
  assert.equal(result.confidence.level, "INSUFFICIENT");
  assert.equal(result.score, null);
  assert.equal(result.state, "HOLD");
});

test("a partial forecast without a confirmed risk cannot create a safe score", () => {
  const result = calculateGrowthScore({
    cultivationMode: "FACILITY_HYDRO",
    forecast: {
      state: "PARTIAL",
      result: {
        riskState: "PARTIAL",
        risks: [],
        noActiveRisksConfirmed: false,
      },
    },
  });

  assert.equal(result.state, "HOLD");
  assert.equal(result.score, null);
  assert.equal(result.components.forecast.reason, "FORECAST_NOT_FULLY_EVALUATED");
});

test("facility hydro cannot claim a growth score from outdoor forecast alone", () => {
  const result = calculateGrowthScore({
    cultivationMode: "FACILITY_HYDRO",
    forecast: safeForecastModule(),
  });

  assert.equal(result.state, "HOLD");
  assert.equal(result.score, null);
  assert.equal(result.reason, "INDOOR_ENVIRONMENT_DATA_REQUIRED");
  assert.equal(result.externalRisk.score, 92);
  assert.equal(result.externalRisk.label, "외기 양호");
  assert.deepEqual(Object.keys(result.components), ["forecast"]);
  assert.deepEqual(result.confidence.missingComponents, ["indoorEnvironment"]);
});

test("all allowed facility score profiles use only their applicable axes", () => {
  for (const crop of ["CUCUMBER", "LETTUCE"]) {
    const soilFacility = calculateGrowthScore({
      request: { crop, cultivationMode: "FACILITY_SOIL" },
      soil: soilModule({ fitRatio: 1, basis: "USER_SOIL_TEST" }),
      forecast: safeForecastModule(),
    });
    const hydroFacility = calculateGrowthScore({
      request: { crop, cultivationMode: "FACILITY_HYDRO" },
      forecast: safeForecastModule(),
    });

    assert.equal(soilFacility.score, 95, `${crop}:FACILITY_SOIL`);
    assert.deepEqual(
      Object.keys(soilFacility.components),
      ["soil", "forecast"],
      crop,
    );
    assert.equal(hydroFacility.score, null, `${crop}:FACILITY_HYDRO`);
    assert.equal(hydroFacility.externalRisk.score, 92, crop);
    assert.deepEqual(Object.keys(hydroFacility.components), ["forecast"], crop);
  }
});

test("legacy warning and caution scores stay inside their public severity bands", () => {
  const warning = calculateGrowthScore({
    cultivationMode: "FACILITY_SOIL",
    soil: soilModule({ fitRatio: 1, basis: "USER_SOIL_TEST" }),
    forecast: warningForecastModule(),
  });
  const caution = calculateGrowthScore({
    cultivationMode: "FACILITY_SOIL",
    soil: soilModule({ fitRatio: 1, basis: "USER_SOIL_TEST" }),
    forecast: cautionForecastModule(),
  });

  assert.ok(warning.components.forecast.score <= 49);
  assert.ok(caution.components.forecast.score >= 50);
  assert.ok(caution.components.forecast.score <= 69);
});

function climateModule(aggregateDeviation) {
  return {
    state: "READY",
    coverage: 1,
    result: { aggregateDeviation, coverage: 1 },
  };
}

function soilModule({
  fitRatio,
  basis,
  uncertainRatio = 0,
  observedValue,
  optimalRange,
}) {
  return {
    state: "READY",
    coverage: 1,
    result: {
      measurementBasis: basis,
      coverage: 1,
      metrics: [
        {
          metric: "PH",
          fitRatio,
          uncertainRatio,
          outsideRatio: 1 - fitRatio - uncertainRatio,
          rawWeight: 3,
          ...(Number.isFinite(observedValue)
            ? { observedValue, optimalRange }
            : {}),
        },
      ],
    },
  };
}

function safeForecastModule() {
  return {
    state: "READY",
    result: {
      riskState: "READY",
      risks: [],
      noActiveRisksConfirmed: true,
      mergedDisplayDays: [
        { date: "2026-08-03", sourceType: "SHORT_GRID" },
      ],
    },
  };
}

function forecastWithCoverage(coverage) {
  const total = 10;
  const evaluated = Math.round(total * coverage);
  return {
    state: coverage === 1 ? "READY" : "PARTIAL",
    result: {
      riskState: coverage === 1 ? "READY" : "PARTIAL",
      risks: [],
      noActiveRisksConfirmed: coverage === 1,
      mergedDisplayDays: [
        { date: "2026-08-03", sourceType: "SHORT_GRID" },
      ],
      dailyOutlooks: [{ date: "2026-08-03", level: "NORMAL" }],
      ruleEvaluations: [
        { evaluatedDayCount: evaluated, missingDayCount: total - evaluated },
      ],
    },
  };
}

function warningForecastModule() {
  return {
    state: "READY",
    result: {
      riskState: "READY",
      noActiveRisksConfirmed: false,
      mergedDisplayDays: [
        { date: "2026-08-03", sourceType: "SHORT_GRID" },
      ],
      risks: [
        {
          severity: "WARNING",
          dateRange: { from: "2026-08-03", to: "2026-08-03" },
          trigger: {
            comparison: { operator: "GTE", threshold: 30 },
            readings: [{ date: "2026-08-03", value: 33 }],
          },
        },
      ],
    },
  };
}

function cautionForecastModule() {
  return {
    state: "READY",
    result: {
      riskState: "READY",
      noActiveRisksConfirmed: false,
      mergedDisplayDays: [
        { date: "2026-08-03", sourceType: "SHORT_GRID" },
      ],
      risks: [
        {
          severity: "CAUTION",
          dateRange: { from: "2026-08-03", to: "2026-08-20" },
          trigger: {
            comparison: { operator: "GTE", threshold: 20 },
            readings: [{ date: "2026-08-03", value: 50 }],
          },
        },
      ],
    },
  };
}
