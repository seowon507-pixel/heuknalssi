function isFiniteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const P0_MAPPING_MODULES = Object.freeze([
  'soil',
  'midForecast',
  'normalStation',
  'observationStation',
]);

function isSupportedKoreanCoordinate(latitude, longitude) {
  return latitude >= 32 && latitude <= 39.5 && longitude >= 123 && longitude <= 132;
}

function distanceKmBetween(
  latitude,
  longitude,
  stationLatitude,
  stationLongitude,
) {
  if (
    ![latitude, longitude, stationLatitude, stationLongitude].every(
      isFiniteCoordinate,
    )
  ) {
    return null;
  }
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(stationLatitude - latitude);
  const longitudeDelta = toRadians(stationLongitude - longitude);
  const left = Math.sin(latitudeDelta / 2) ** 2;
  const right =
    Math.cos(toRadians(latitude)) *
    Math.cos(toRadians(stationLatitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  const centralAngle =
    2 * Math.atan2(Math.sqrt(left + right), Math.sqrt(1 - left - right));
  return Math.round(6371.0088 * centralAngle * 10) / 10;
}

export function toKmaGrid(latitude, longitude) {
  if (
    !isFiniteCoordinate(latitude) ||
    !isFiniteCoordinate(longitude) ||
    !isSupportedKoreanCoordinate(latitude, longitude)
  ) {
    return null;
  }

  const RE = 6371.00877;
  const GRID = 5;
  const SLAT1 = 30;
  const SLAT2 = 60;
  const OLON = 126;
  const OLAT = 38;
  const XO = 43;
  const YO = 136;
  const DEGRAD = Math.PI / 180;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + latitude * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = longitude * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

export function resolveLocationKeys(
  location,
  verifiedMappings = {},
  { now = () => new Date(), officialCatalog = null } = {},
) {
  const mapping = findActiveVerifiedMapping(
    location,
    verifiedMappings,
    normalizeDate(now()),
  );
  const isAddressResolved = location.resolutionMode === 'ADDRESS_RESOLVED';
  const administrativeRepresentative =
    location.resolutionMode === 'ADMIN_AREA_BROAD' &&
    location.administrativeRepresentative?.purpose ===
      'REGIONAL_FORECAST_ONLY'
      ? location.administrativeRepresentative
      : null;
  const grid = isAddressResolved
    ? toKmaGrid(location.latitude, location.longitude)
    : administrativeRepresentative
      ? toKmaGrid(
          administrativeRepresentative.latitude,
          administrativeRepresentative.longitude,
        )
      : null;
  const catalogMapping = mapping
    ? null
    : resolveOfficialCatalogMapping(location, officialCatalog);
  const midForecastRegionIds =
    mapping?.midForecast?.verified === true &&
    validProviderKey(mapping.midForecast.temperatureRegId) &&
    validProviderKey(mapping.midForecast.landRegId)
      ? Object.freeze({
          temperatureRegId: mapping.midForecast.temperatureRegId,
          landRegId: mapping.midForecast.landRegId,
        })
      : catalogMapping?.midForecastRegionIds ?? null;
  const legalDongCode10 =
    typeof location.legalDongCode === 'string' &&
    /^\d{10}$/.test(location.legalDongCode)
      ? location.legalDongCode
      : null;
  const observationStation =
    isAddressResolved && mapping?.observationStation?.verified === true
      ? mapping.observationStation
      : isAddressResolved
        ? catalogMapping?.observationStation ?? null
        : null;
  const observationDistanceKm = observationStation
    ? Number.isFinite(observationStation.latitude) &&
      Number.isFinite(observationStation.longitude)
      ? distanceKmBetween(
          location.latitude,
          location.longitude,
          observationStation.latitude,
          observationStation.longitude,
        )
      : Number.isFinite(observationStation.distanceKm)
        ? observationStation.distanceKm
        : null
    : null;

  return Object.freeze({
    legalDongCode10,
    verifiedSoilAreaCode:
      mapping?.soil?.verified === true ? mapping.soil.code : legalDongCode10,
    shortForecastGrid: grid,
    shortForecastScope: isAddressResolved
      ? 'ADDRESS_GRID'
      : grid
        ? 'ADMIN_AREA_REPRESENTATIVE'
        : null,
    midForecastRegionIds,
    normalStationId:
      mapping?.normalStation?.verified === true
        ? mapping.normalStation.id
        : catalogMapping?.normalStationId ?? null,
    observationStationId:
      observationStation
        ? observationStation.id
        : null,
    observationDistanceKm,
  });
}

function routingCoordinates(location) {
  if (
    location?.resolutionMode === 'ADDRESS_RESOLVED' &&
    isFiniteCoordinate(location.latitude) &&
    isFiniteCoordinate(location.longitude)
  ) {
    return {
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }
  const representative = location?.administrativeRepresentative;
  if (
    location?.resolutionMode === 'ADMIN_AREA_BROAD' &&
    representative?.purpose === 'REGIONAL_FORECAST_ONLY' &&
    isFiniteCoordinate(representative.latitude) &&
    isFiniteCoordinate(representative.longitude)
  ) {
    return {
      latitude: representative.latitude,
      longitude: representative.longitude,
    };
  }
  return null;
}

function nearestByDistance(entries, coordinates, { maxDistanceKm = 200 } = {}) {
  let nearest = null;
  for (const entry of entries) {
    const distanceKm = distanceKmBetween(
      coordinates.latitude,
      coordinates.longitude,
      entry.latitude,
      entry.longitude,
    );
    if (
      distanceKm === null ||
      distanceKm > maxDistanceKm ||
      (nearest && distanceKm >= nearest.distanceKm)
    ) {
      continue;
    }
    nearest = { entry, distanceKm };
  }
  return nearest;
}

function landRegionFor(zone, zonesById) {
  let current = zone;
  const visited = new Set();
  let landRegion = null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (
      current.type === 'A' &&
      current.id !== '11000000' &&
      /^11[0-9A-Z]{6}$/u.test(current.id)
    ) {
      landRegion = current;
    }
    current = current.parentId ? zonesById.get(current.parentId) : null;
  }
  return landRegion;
}

/**
 * Resolves nationwide routing from KMA's official current station and
 * forecast-zone catalogs. The catalog never replaces a reviewed static
 * mapping, and broad administrative inputs still cannot claim a parcel-level
 * ASOS observation.
 */
export function resolveOfficialCatalogMapping(location, catalog) {
  const coordinates = routingCoordinates(location);
  if (
    !coordinates ||
    !catalog ||
    !Array.isArray(catalog.stations) ||
    !Array.isArray(catalog.zones)
  ) {
    return null;
  }
  const stations = catalog.stations.filter(
    (station) =>
      station &&
      /^\d{2,4}$/u.test(String(station.id ?? '')) &&
      isFiniteCoordinate(station.latitude) &&
      isFiniteCoordinate(station.longitude),
  );
  const temperatureZones = catalog.zones.filter(
    (zone) =>
      zone?.type === 'C' &&
      /^11[0-9A-Z]{6}$/u.test(String(zone.id ?? '')) &&
      isFiniteCoordinate(zone.latitude) &&
      isFiniteCoordinate(zone.longitude),
  );
  const zonesById = new Map(
    catalog.zones
      .filter((zone) => zone && typeof zone.id === 'string')
      .map((zone) => [zone.id, zone]),
  );
  const station = nearestByDistance(stations, coordinates);
  const temperature = nearestByDistance(temperatureZones, coordinates);
  const land = temperature
    ? landRegionFor(temperature.entry, zonesById)
    : null;
  if (!station && (!temperature || !land)) return null;

  return Object.freeze({
    normalStationId: station?.entry.id ?? null,
    observationStation: station
      ? Object.freeze({
          id: station.entry.id,
          latitude: station.entry.latitude,
          longitude: station.entry.longitude,
        })
      : null,
    midForecastRegionIds:
      temperature && land
        ? Object.freeze({
            temperatureRegId: temperature.entry.id,
            landRegId: land.id,
          })
        : null,
  });
}

function findActiveVerifiedMapping(location, verifiedMappings, at) {
  for (const areaCode of mappingAreaCodeCandidates(location)) {
    const mapping = verifiedMappings[areaCode];
    if (isActiveVerifiedMapping(mapping, at)) return mapping;
  }
  return null;
}

function mappingAreaCodeCandidates(location) {
  const rawCodes = [
    location?.adminAreaCode,
    location?.legalDongCode,
  ].filter((value) => typeof value === 'string' && /^\d{5,10}$/u.test(value));
  const candidates = [];
  for (const code of rawCodes) {
    candidates.push(code);
    if (code.length === 10) {
      candidates.push(`${code.slice(0, 5)}00000`, code.slice(0, 5));
    }
  }
  return [...new Set(candidates)];
}

function validProviderKey(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{2,32}$/u.test(value)
  );
}

export function validateVerifiedLocationMappings(
  mappings,
  { now = () => new Date() } = {},
) {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    return {
      valid: false,
      verifiedCount: 0,
      p0ReadyCount: 0,
      p0IncompleteAreaCodes: [],
      errors: ['verifiedLocationMappings must be an object'],
    };
  }
  const at = normalizeDate(now());
  const errors = [];
  let verifiedCount = 0;
  let p0ReadyCount = 0;
  const p0IncompleteAreaCodes = [];
  for (const [areaCode, mapping] of Object.entries(mappings)) {
    if (!/^\d{5,10}$/u.test(areaCode)) {
      errors.push(`${areaCode}: invalid administrative area code`);
      continue;
    }
    const entryErrors = mappingErrors(mapping, at);
    if (entryErrors.length > 0) {
      errors.push(...entryErrors.map((error) => `${areaCode}: ${error}`));
      continue;
    }
    verifiedCount += 1;
    if (hasCompleteP0Mapping(mapping)) {
      p0ReadyCount += 1;
    } else {
      p0IncompleteAreaCodes.push(areaCode);
    }
  }
  return {
    valid: errors.length === 0,
    verifiedCount,
    p0ReadyCount,
    p0IncompleteAreaCodes: p0IncompleteAreaCodes.sort(),
    errors,
  };
}

function isActiveVerifiedMapping(mapping, at) {
  return mappingErrors(mapping, normalizeDate(at)).length === 0;
}

function mappingErrors(mapping, at) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return ['mapping must be an object'];
  }
  const errors = [];
  const provenance = mapping.provenance;
  if (!provenance || typeof provenance !== 'object') {
    errors.push('provenance is required');
  } else {
    for (const field of ['sourceTitle', 'version', 'reviewedAt', 'validFrom', 'validTo']) {
      if (typeof provenance[field] !== 'string' || provenance[field].trim() === '') {
        errors.push(`provenance.${field} is required`);
      }
    }
    if (!isHttpsUrl(provenance.sourceUrl)) {
      errors.push('provenance.sourceUrl must be an absolute HTTPS URL');
    }
    const reviewedAt = isoDate(provenance.reviewedAt);
    const validFrom = isoDate(provenance.validFrom);
    const validTo = isoDate(provenance.validTo);
    if (!reviewedAt) errors.push('provenance.reviewedAt must be an ISO date');
    if (!validFrom) errors.push('provenance.validFrom must be an ISO date');
    if (!validTo) errors.push('provenance.validTo must be an ISO date');
    if (validFrom && validTo && validFrom > validTo) {
      errors.push('provenance validity range is inverted');
    }
    const atDate = at.toISOString().slice(0, 10);
    if (validFrom && validTo && (atDate < validFrom || atDate > validTo)) {
      errors.push('mapping is outside its verified validity range');
    }
  }

  if (!hasVerifiedModule(mapping)) {
    errors.push('at least one verified module mapping is required');
  }
  if (
    mapping.soil?.verified === true &&
    !/^\d{10}$/.test(mapping.soil.code)
  ) {
    errors.push('soil.code is invalid');
  }
  if (
    mapping.midForecast?.verified === true &&
    (!validProviderKey(mapping.midForecast.temperatureRegId) ||
      !validProviderKey(mapping.midForecast.landRegId))
  ) {
    errors.push('midForecast requires verified temperatureRegId and landRegId');
  }
  if (
    mapping.normalStation?.verified === true &&
    !validProviderKey(mapping.normalStation.id)
  ) {
    errors.push('normalStation.id is invalid');
  }
  if (mapping.observationStation?.verified === true) {
    if (!validProviderKey(mapping.observationStation.id)) {
      errors.push('observationStation.id is invalid');
    }
    const hasVerifiedCoordinates =
      isSupportedKoreanCoordinate(
        mapping.observationStation.latitude,
        mapping.observationStation.longitude,
      ) && mapping.observationStation.stationMetadataVerified === true;
    const hasLegacyVerifiedDistance =
      Number.isFinite(mapping.observationStation.distanceKm) &&
      mapping.observationStation.distanceKm >= 0 &&
      mapping.observationStation.operationalVerified === true &&
      mapping.observationStation.periodDataVerified === true;
    if (!hasVerifiedCoordinates && !hasLegacyVerifiedDistance) {
      errors.push(
        'observationStation requires verified coordinates or a verified legacy distance',
      );
    }
  }
  return errors;
}

function hasVerifiedModule(mapping) {
  return P0_MAPPING_MODULES.some(
    (key) => mapping[key]?.verified === true,
  );
}

function hasCompleteP0Mapping(mapping) {
  return P0_MAPPING_MODULES.every(
    (key) => mapping[key]?.verified === true,
  );
}

function isoDate(value) {
  const match =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
      : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('mapping validation clock returned an invalid date');
  }
  return date;
}
