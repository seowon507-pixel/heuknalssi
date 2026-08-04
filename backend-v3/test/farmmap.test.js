import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_FARMMAP_CONTRACT_VERSION,
  createFarmmapAdapter,
  parseFarmmapFeatureCollection,
} from "../src/adapters/farmmap.js";

const FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: "provider-internal-id",
    properties: {
      FARM_ID: "FM-100",
      FLD_TYPENAME: "과수",
      ADDRESS: "인천광역시 남동구 샘플동",
      UNSTABLE_PRIVATE_COLUMN: "must-not-leak",
    },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [126.7200, 37.4500],
        [126.7210, 37.4500],
        [126.7210, 37.4510],
        [126.7200, 37.4510],
        [126.7200, 37.4500],
      ]],
    },
  }],
};

test("FarmMap parser returns only bounded product fields and a normalized boundary", () => {
  const [candidate] = parseFarmmapFeatureCollection(FEATURE_COLLECTION);
  assert.equal(candidate.farmmapId, "FM-100");
  assert.equal(candidate.category, "과수");
  assert.equal(candidate.representativeAddress, "인천광역시 남동구 샘플동");
  assert.equal(candidate.geometry.type, "Polygon");
  assert.ok(candidate.areaSquareMeters > 0);
  assert.equal(JSON.stringify(candidate).includes("must-not-leak"), false);
});

test("FarmMap parser rejects unsupported or out-of-bounds geometry", () => {
  assert.throws(
    () => parseFarmmapFeatureCollection({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [126.72, 37.45] },
      }],
    }),
    /Polygon or MultiPolygon/u,
  );
  assert.throws(
    () => parseFarmmapFeatureCollection({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [0, 0], [1, 0], [1, 1], [0, 1], [0, 0],
          ]],
        },
      }],
    }),
    /supported Korea bounds/u,
  );
});

test("FarmMap WFS search uses the registered server-side key and never returns it", async () => {
  let requestedUrl = null;
  const adapter = createFarmmapAdapter({
    enabled: true,
    apiKey: "fixture-farmmap-secret",
    domain: "http://localhost:3000",
    contractVersion: VERIFIED_FARMMAP_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      requestedUrl = new URL(String(url));
      return new Response(JSON.stringify(FEATURE_COLLECTION), {
        status: 200,
        headers: { "Content-Type": "application/geo+json" },
      });
    },
  });
  const result = await adapter.searchParcels({
    latitude: 37.45,
    longitude: 126.72,
    radiusMeters: 250,
  });
  assert.equal(adapter.state, "CONFIGURED_UNVERIFIED");
  assert.equal(requestedUrl.hostname, "agis.epis.or.kr");
  assert.equal(requestedUrl.searchParams.get("request"), "GetFeature");
  assert.equal(requestedUrl.searchParams.get("typeName"), "farm_map_api");
  assert.equal(requestedUrl.searchParams.get("srsName"), "EPSG:4326");
  assert.equal(requestedUrl.searchParams.get("apiKey"), "fixture-farmmap-secret");
  assert.equal(result.state, "READY");
  assert.equal(result.candidates.length, 1);
  assert.equal(JSON.stringify(result).includes("fixture-farmmap-secret"), false);
  assert.equal(result.sourceUrl.includes("?"), false);
});

test("FarmMap adapter stays unavailable for a missing or unknown contract", async () => {
  let calls = 0;
  const adapter = createFarmmapAdapter({
    enabled: true,
    apiKey: "fixture-farmmap-secret",
    domain: "http://localhost:3000",
    contractVersion: "unknown-contract",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  const result = await adapter.searchParcels({
    latitude: 37.45,
    longitude: 126.72,
  });
  assert.equal(adapter.state, "HOLD");
  assert.equal(calls, 0);
  assert.equal(result.state, "UNAVAILABLE");
});
