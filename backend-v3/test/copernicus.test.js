import assert from "node:assert/strict";
import test from "node:test";

import {
  createCopernicusSatelliteAdapter,
  parseCopernicusNdviStatistics,
  parseCopernicusStacItems,
} from "../src/adapters/copernicus.js";

const GEOMETRY = {
  type: "Polygon",
  coordinates: [[
    [126.72, 37.45], [126.721, 37.45], [126.721, 37.451],
    [126.72, 37.451], [126.72, 37.45],
  ]],
};

test("parses only bounded Sentinel-2 STAC observation metadata", () => {
  const items = parseCopernicusStacItems({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      id: "S2B_20260730",
      collection: "sentinel-2-l2a",
      properties: {
        datetime: "2026-07-30T02:10:00Z",
        "eo:cloud_cover": 12.4,
      },
      assets: {
        thumbnail: { href: "https://example.invalid/thumb.jpg" },
      },
    }],
  });
  assert.deepEqual(items, [{
    itemId: "S2B_20260730",
    collection: "sentinel-2-l2a",
    acquiredAt: "2026-07-30T02:10:00.000Z",
    cloudCoverPercent: 12.4,
    resolutionMeters: 10,
    previewUrl: null,
  }]);
});

test("rejects malformed or out-of-range STAC fields", () => {
  assert.throws(
    () => parseCopernicusStacItems({ type: "FeatureCollection", features: [{ id: "x" }] }),
    /STAC item/u,
  );
  assert.throws(
    () => parseCopernicusStacItems({
      type: "FeatureCollection",
      features: [{
        id: "x",
        collection: "sentinel-2-l2a",
        properties: { datetime: "2026-07-30T02:10:00Z", "eo:cloud_cover": 120 },
      }],
    }),
    /cloud cover/u,
  );
});

test("parses NDVI time series and preserves no-data intervals as null", () => {
  const result = parseCopernicusNdviStatistics({
    status: "OK",
    data: [
      {
        interval: { from: "2026-07-20T00:00:00Z", to: "2026-07-25T00:00:00Z" },
        outputs: { ndvi: { bands: { B0: { stats: {
          mean: 0.61, stDev: 0.08, sampleCount: 100, noDataCount: 15,
        } } } } },
      },
      {
        interval: { from: "2026-07-25T00:00:00Z", to: "2026-07-30T00:00:00Z" },
        outputs: { ndvi: { bands: { B0: { stats: {
          mean: 0, stDev: 0, sampleCount: 20, noDataCount: 20,
        } } } } },
      },
    ],
  });
  assert.equal(result[0].meanNdvi, 0.61);
  assert.equal(result[0].validPixelRatio, 0.85);
  assert.equal(result[1].meanNdvi, null);
  assert.equal(result[1].validPixelRatio, 0);
});

test("queries public STAC without OAuth and discloses parcel limits", async () => {
  let request;
  const adapter = createCopernicusSatelliteAdapter({
    enabled: true,
    contractVersion: "copernicus-s2-l2a-v1",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        type: "FeatureCollection",
        features: [{
          id: "S2A_L2A",
          collection: "sentinel-2-l2a",
          properties: { datetime: "2026-07-29T02:00:00Z", "eo:cloud_cover": 8 },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    now: () => new Date("2026-07-31T00:00:00Z"),
  });
  const envelope = await adapter.searchLatest({
    geometry: GEOMETRY,
    from: "2026-07-01T00:00:00Z",
    to: "2026-07-31T00:00:00Z",
    maxCloudCover: 30,
  });
  assert.equal(request.url, "https://stac.dataspace.copernicus.eu/v1/search");
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(envelope.deliveryState, "LIVE");
  assert.equal(envelope.spatialLevel, "FIELD");
  assert.equal(envelope.data.items.length, 1);
  assert.ok(envelope.qualityFlags.includes("SATELLITE_NOT_FIELD_MEASUREMENT"));
});

test("returns an unavailable NDVI envelope when OAuth is not configured", async () => {
  const adapter = createCopernicusSatelliteAdapter({ enabled: true });
  const result = await adapter.getNdviSeries({
    geometry: GEOMETRY,
    from: "2026-07-01T00:00:00Z",
    to: "2026-07-31T00:00:00Z",
  });
  assert.equal(result.deliveryState, "UNAVAILABLE");
  assert.equal(result.adapterState, "UNSUPPORTED");
  assert.ok(result.qualityFlags.includes("SATELLITE_OAUTH_NOT_CONFIGURED"));
});
