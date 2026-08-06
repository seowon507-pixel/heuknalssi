import assert from "node:assert/strict";
import test from "node:test";

import { createSatelliteObservationService } from "../src/application/satellite-observation.js";

const GEOMETRY = {
  type: "Polygon",
  coordinates: [[
    [126.72, 37.45], [126.721, 37.45], [126.721, 37.451],
    [126.72, 37.451], [126.72, 37.45],
  ]],
};

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

test("stores a confirmed parcel under session and farm scope", async () => {
  const service = createSatelliteObservationService({
    store: memoryStore(),
    randomId: () => "parcel-1",
    clock: () => Date.parse("2026-07-31T00:00:00Z"),
  });
  const parcel = await service.putParcel({
    ownerSessionId: "session-1",
    farmId: "farm-1",
    geometry: GEOMETRY,
  });
  assert.equal(parcel.parcelId, "parcel-1");
  assert.ok(parcel.areaSquareMeters > 8_000);
  assert.deepEqual(
    await service.getParcel({ ownerSessionId: "session-1", farmId: "farm-1" }),
    parcel,
  );
  assert.equal(
    await service.getParcel({ ownerSessionId: "other", farmId: "farm-1" }),
    null,
  );
});

test("reports a declining NDVI observation as a field-check prompt, not diagnosis", async () => {
  const store = memoryStore();
  const adapter = {
    async searchLatest() {
      return {
        deliveryState: "LIVE",
        adapterState: "SUCCESS",
        observedAt: "2026-07-29T02:00:00Z",
        sourceId: "copernicus-sentinel-2-l2a",
        sourceName: "Copernicus Sentinel-2 L2A",
        sourceUrl: "https://dataspace.copernicus.eu/",
        spatialLevel: "FIELD",
        qualityFlags: ["SATELLITE_NOT_FIELD_MEASUREMENT"],
        data: { items: [{ acquiredAt: "2026-07-29T02:00:00Z", cloudCoverPercent: 8 }] },
      };
    },
    async getNdviSeries() {
      return {
        deliveryState: "LIVE",
        adapterState: "SUCCESS",
        observedAt: "2026-07-30T00:00:00Z",
        sourceId: "copernicus-sentinel-2-l2a",
        sourceName: "Copernicus Sentinel-2 L2A",
        sourceUrl: "https://dataspace.copernicus.eu/",
        spatialLevel: "FIELD",
        qualityFlags: ["CLOUD_AND_NO_DATA_PIXELS_EXCLUDED"],
        data: {
          observations: [
            { from: "2026-07-01T00:00:00Z", to: "2026-07-06T00:00:00Z", meanNdvi: 0.72, validPixelRatio: 0.9 },
            { from: "2026-07-26T00:00:00Z", to: "2026-07-31T00:00:00Z", meanNdvi: 0.55, validPixelRatio: 0.85 },
          ],
        },
      };
    },
  };
  const service = createSatelliteObservationService({
    store,
    adapter,
    randomId: () => "observation-1",
    clock: () => Date.parse("2026-07-31T00:00:00Z"),
  });
  await service.putParcel({ ownerSessionId: "s", farmId: "f", geometry: GEOMETRY });
  const result = await service.refresh({ ownerSessionId: "s", farmId: "f" });
  assert.equal(result.state, "READY");
  assert.equal(result.trend.direction, "DECREASING");
  assert.match(result.summary, /낮아졌/u);
  assert.match(result.nextAction, /현장/u);
  assert.doesNotMatch(result.summary, /병|진단|확정/u);
  assert.ok(result.limitations.includes("SATELLITE_NOT_FIELD_MEASUREMENT"));
});

test("sorts NDVI observations by time and keeps the higher-quality duplicate period", async () => {
  const store = memoryStore();
  const service = createSatelliteObservationService({
    store,
    adapter: {
      async searchLatest() {
        return {
          deliveryState: "LIVE", adapterState: "SUCCESS",
          observedAt: "2026-07-30T00:00:00Z", qualityFlags: [],
          sourceId: "catalog", sourceName: "catalog", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD", data: { items: [{ acquiredAt: "2026-07-30T00:00:00Z" }] },
        };
      },
      async getNdviSeries() {
        return {
          deliveryState: "LIVE", adapterState: "SUCCESS",
          observedAt: "2026-07-30T00:00:00Z", qualityFlags: [],
          sourceId: "stats", sourceName: "stats", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD",
          data: {
            observations: [
              { from: "2026-07-26T00:00:00Z", to: "2026-07-31T00:00:00Z", meanNdvi: 0.55, validPixelRatio: 0.85 },
              { from: "2026-07-01T00:00:00Z", to: "2026-07-06T00:00:00Z", meanNdvi: 0.2, validPixelRatio: 0.55 },
              { from: "2026-07-01T00:00:00Z", to: "2026-07-06T00:00:00Z", meanNdvi: 0.72, validPixelRatio: 0.92 },
            ],
          },
        };
      },
    },
    randomId: () => "id",
    clock: () => Date.parse("2026-07-31T00:00:00Z"),
  });
  await service.putParcel({ ownerSessionId: "s", farmId: "f", geometry: GEOMETRY });
  const result = await service.refresh({ ownerSessionId: "s", farmId: "f" });

  assert.equal(result.state, "READY");
  assert.equal(result.trend.direction, "DECREASING");
  assert.deepEqual(
    result.vegetation.observations.map(({ to, meanNdvi, validPixelRatio }) => ({ to, meanNdvi, validPixelRatio })),
    [
      { to: "2026-07-06T00:00:00Z", meanNdvi: 0.72, validPixelRatio: 0.92 },
      { to: "2026-07-31T00:00:00Z", meanNdvi: 0.55, validPixelRatio: 0.85 },
    ],
  );
});

test("does not infer a trend from 0.01 percent valid pixels", async () => {
  const store = memoryStore();
  const service = createSatelliteObservationService({
    store,
    adapter: {
      async searchLatest() {
        return {
          deliveryState: "LIVE", adapterState: "SUCCESS",
          observedAt: "2026-07-30T00:00:00Z", qualityFlags: [],
          sourceId: "catalog", sourceName: "catalog", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD", data: { items: [{ acquiredAt: "2026-07-30T00:00:00Z" }] },
        };
      },
      async getNdviSeries() {
        return {
          deliveryState: "LIVE", adapterState: "SUCCESS",
          observedAt: "2026-07-30T00:00:00Z", qualityFlags: [],
          sourceId: "stats", sourceName: "stats", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD",
          data: {
            observations: [
              { from: "2026-07-01T00:00:00Z", to: "2026-07-06T00:00:00Z", meanNdvi: 0.72, validPixelRatio: 0.0001 },
              { from: "2026-07-26T00:00:00Z", to: "2026-07-31T00:00:00Z", meanNdvi: 0.55, validPixelRatio: 0.9 },
            ],
          },
        };
      },
    },
    randomId: () => "id",
    clock: () => Date.parse("2026-07-31T00:00:00Z"),
  });
  await service.putParcel({ ownerSessionId: "s", farmId: "f", geometry: GEOMETRY });
  const result = await service.refresh({ ownerSessionId: "s", farmId: "f" });

  assert.equal(result.state, "PARTIAL");
  assert.equal(result.trend, null);
  assert.equal(result.vegetation.observations.length, 1);
  assert.ok(result.limitations.includes("SATELLITE_LOW_VALID_PIXEL_COVERAGE"));
  assert.ok(result.limitations.includes("SATELLITE_INSUFFICIENT_TREND_OBSERVATIONS"));
});

test("keeps catalogue-only results PARTIAL when NDVI OAuth is unavailable", async () => {
  const store = memoryStore();
  const service = createSatelliteObservationService({
    store,
    adapter: {
      async searchLatest() {
        return {
          deliveryState: "LIVE", adapterState: "SUCCESS",
          observedAt: "2026-07-29T02:00:00Z", qualityFlags: [],
          sourceId: "catalog", sourceName: "catalog", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD", data: { items: [{ acquiredAt: "2026-07-29T02:00:00Z" }] },
        };
      },
      async getNdviSeries() {
        return {
          deliveryState: "UNAVAILABLE", adapterState: "UNSUPPORTED",
          observedAt: null, qualityFlags: ["SATELLITE_OAUTH_NOT_CONFIGURED"],
          sourceId: "stats", sourceName: "stats", sourceUrl: "https://dataspace.copernicus.eu/",
          spatialLevel: "FIELD", data: null,
        };
      },
    },
    randomId: () => "id",
    clock: () => Date.parse("2026-07-31T00:00:00Z"),
  });
  await service.putParcel({ ownerSessionId: "s", farmId: "f", geometry: GEOMETRY });
  const result = await service.refresh({ ownerSessionId: "s", farmId: "f" });
  assert.equal(result.state, "PARTIAL");
  assert.equal(result.trend, null);
  assert.match(result.summary, /촬영 자료/u);
});

test("requires an existing owned parcel before satellite refresh", async () => {
  const service = createSatelliteObservationService({ store: memoryStore() });
  await assert.rejects(
    () => service.refresh({ ownerSessionId: "s", farmId: "f" }),
    /parcel is not registered/u,
  );
});
