const KOREA_BOUNDS = Object.freeze({
  minLongitude: 123,
  maxLongitude: 133,
  minLatitude: 32,
  maxLatitude: 39.5,
});
const MAX_AREA_SQUARE_METERS = 50_000_000;
const MAX_POSITIONS = 500;
const EARTH_RADIUS_METERS = 6_371_008.8;

function isFinitePosition(position) {
  return (
    Array.isArray(position) &&
    position.length === 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1])
  );
}

function samePosition(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function orientation(a, b, c) {
  const value =
    (b[1] - a[1]) * (c[0] - b[0]) -
    (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    b[0] <= Math.max(a[0], c[0]) &&
    b[0] >= Math.min(a[0], c[0]) &&
    b[1] <= Math.max(a[1], c[1]) &&
    b[1] >= Math.min(a[1], c[1])
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  );
}

function assertSimpleRing(ring) {
  const segmentCount = ring.length - 1;
  for (let first = 0; first < segmentCount; first += 1) {
    for (let second = first + 1; second < segmentCount; second += 1) {
      const adjacent =
        second === first + 1 ||
        (first === 0 && second === segmentCount - 1);
      if (adjacent) continue;
      if (
        segmentsIntersect(
          ring[first],
          ring[first + 1],
          ring[second],
          ring[second + 1],
        )
      ) {
        throw new TypeError("parcel ring must not self-intersect");
      }
    }
  }
}

function normalizeRing(ring, state) {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new TypeError("parcel ring must contain at least four positions");
  }
  if (!isFinitePosition(ring[0]) || !isFinitePosition(ring.at(-1))) {
    throw new TypeError("parcel positions must contain finite longitude and latitude");
  }
  if (!samePosition(ring[0], ring.at(-1))) {
    throw new TypeError("parcel ring must be closed");
  }
  const normalized = ring.map((position) => {
    if (!isFinitePosition(position)) {
      throw new TypeError("parcel positions must contain finite longitude and latitude");
    }
    const [longitude, latitude] = position;
    if (
      longitude < KOREA_BOUNDS.minLongitude ||
      longitude > KOREA_BOUNDS.maxLongitude ||
      latitude < KOREA_BOUNDS.minLatitude ||
      latitude > KOREA_BOUNDS.maxLatitude
    ) {
      throw new TypeError("parcel positions must be within the supported Korea bounds");
    }
    state.positionCount += 1;
    if (state.positionCount > MAX_POSITIONS) {
      throw new TypeError("parcel geometry contains too many positions");
    }
    state.minLongitude = Math.min(state.minLongitude, longitude);
    state.maxLongitude = Math.max(state.maxLongitude, longitude);
    state.minLatitude = Math.min(state.minLatitude, latitude);
    state.maxLatitude = Math.max(state.maxLatitude, latitude);
    return Object.freeze([longitude, latitude]);
  });
  assertSimpleRing(normalized);
  return Object.freeze(normalized);
}

function normalizePolygon(coordinates, state) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw new TypeError("parcel polygon must contain at least one ring");
  }
  return Object.freeze(coordinates.map((ring) => normalizeRing(ring, state)));
}

function ringAreaSquareMeters(ring) {
  const meanLatitudeRadians =
    (ring.reduce((sum, position) => sum + position[1], 0) / ring.length) *
    (Math.PI / 180);
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    const currentX =
      EARTH_RADIUS_METERS * current[0] * (Math.PI / 180) *
      Math.cos(meanLatitudeRadians);
    const currentY = EARTH_RADIUS_METERS * current[1] * (Math.PI / 180);
    const nextX =
      EARTH_RADIUS_METERS * next[0] * (Math.PI / 180) *
      Math.cos(meanLatitudeRadians);
    const nextY = EARTH_RADIUS_METERS * next[1] * (Math.PI / 180);
    twiceArea += currentX * nextY - nextX * currentY;
  }
  return Math.abs(twiceArea) / 2;
}

function polygonAreaSquareMeters(polygon) {
  const outer = ringAreaSquareMeters(polygon[0]);
  const holes = polygon
    .slice(1)
    .reduce((sum, ring) => sum + ringAreaSquareMeters(ring), 0);
  const area = outer - holes;
  if (!(area > 0)) {
    throw new TypeError("parcel holes must not cover the outer ring");
  }
  return area;
}

function newGeometryState() {
  return {
    minLongitude: Infinity,
    maxLongitude: -Infinity,
    minLatitude: Infinity,
    maxLatitude: -Infinity,
    positionCount: 0,
  };
}

export function normalizeParcelGeometry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("parcel geometry must be a GeoJSON object");
  }
  const state = newGeometryState();
  let coordinates;
  let areaSquareMeters;
  if (value.type === "Polygon") {
    coordinates = normalizePolygon(value.coordinates, state);
    areaSquareMeters = polygonAreaSquareMeters(coordinates);
  } else if (value.type === "MultiPolygon") {
    if (!Array.isArray(value.coordinates) || value.coordinates.length === 0) {
      throw new TypeError("parcel MultiPolygon must contain polygons");
    }
    coordinates = Object.freeze(
      value.coordinates.map((polygon) => normalizePolygon(polygon, state)),
    );
    areaSquareMeters = coordinates.reduce(
      (sum, polygon) => sum + polygonAreaSquareMeters(polygon),
      0,
    );
  } else {
    throw new TypeError("parcel geometry must be Polygon or MultiPolygon");
  }
  if (areaSquareMeters > MAX_AREA_SQUARE_METERS) {
    throw new TypeError("parcel area exceeds the supported maximum");
  }
  const geometry = Object.freeze({ type: value.type, coordinates });
  return Object.freeze({
    geometry,
    areaSquareMeters: Math.round(areaSquareMeters),
    bbox: Object.freeze([
      state.minLongitude,
      state.minLatitude,
      state.maxLongitude,
      state.maxLatitude,
    ]),
  });
}

export function parcelBoundingBox(value) {
  return [...normalizeParcelGeometry(value).bbox];
}

export const parcelLimits = Object.freeze({
  koreaBounds: KOREA_BOUNDS,
  maxAreaSquareMeters: MAX_AREA_SQUARE_METERS,
  maxPositions: MAX_POSITIONS,
});
