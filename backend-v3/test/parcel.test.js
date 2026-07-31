import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeParcelGeometry,
  parcelBoundingBox,
} from "../src/domain/parcel.js";

const VALID_PARCEL = {
  type: "Polygon",
  coordinates: [[
    [126.72, 37.45],
    [126.721, 37.45],
    [126.721, 37.451],
    [126.72, 37.451],
    [126.72, 37.45],
  ]],
};

test("normalizes a Korean parcel and reports bounded area", () => {
  const result = normalizeParcelGeometry(VALID_PARCEL);
  assert.equal(result.geometry.type, "Polygon");
  assert.deepEqual(result.bbox, [126.72, 37.45, 126.721, 37.451]);
  assert.ok(result.areaSquareMeters > 8_000);
  assert.ok(result.areaSquareMeters < 12_000);
  assert.equal(Object.isFrozen(result.geometry), true);
});

test("supports MultiPolygon while preserving one combined parcel area", () => {
  const second = structuredClone(VALID_PARCEL.coordinates);
  for (const position of second[0]) position[0] += 0.002;
  const result = normalizeParcelGeometry({
    type: "MultiPolygon",
    coordinates: [VALID_PARCEL.coordinates, second],
  });
  assert.equal(result.geometry.type, "MultiPolygon");
  assert.ok(result.areaSquareMeters > 16_000);
});

test("rejects open, self-intersecting, overseas, and oversized parcels", () => {
  assert.throws(
    () => normalizeParcelGeometry({
      type: "Polygon",
      coordinates: [[
        [126.7, 37.4], [126.8, 37.4], [126.8, 37.5], [126.7, 37.5],
      ]],
    }),
    /closed/u,
  );
  assert.throws(
    () => normalizeParcelGeometry({
      type: "Polygon",
      coordinates: [[
        [126.7, 37.4], [126.8, 37.5], [126.7, 37.5],
        [126.8, 37.4], [126.7, 37.4],
      ]],
    }),
    /self-intersect/u,
  );
  assert.throws(
    () => normalizeParcelGeometry({
      type: "Polygon",
      coordinates: [[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10.1], [10, 10]]],
    }),
    /Korea/u,
  );
  assert.throws(
    () => normalizeParcelGeometry({
      type: "Polygon",
      coordinates: [[[124, 33], [132, 33], [132, 39], [124, 39], [124, 33]]],
    }),
    /maximum/u,
  );
});

test("parcelBoundingBox does not mutate caller coordinates", () => {
  const input = structuredClone(VALID_PARCEL);
  assert.deepEqual(parcelBoundingBox(input), [126.72, 37.45, 126.721, 37.451]);
  assert.deepEqual(input, VALID_PARCEL);
});
