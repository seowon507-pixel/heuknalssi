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
  { now = () => new Date() } = {},
) {
  const candidateMapping = verifiedMappings[location.adminAreaCode] ?? null;
  const mapping = isActiveVerifiedMapping(candidateMapping, normalizeDate(now()))
    ? candidateMapping
    : null;
  const isAddressResolved = location.resolutionMode === 'ADDRESS_RESOLVED';
  const grid = isAddressResolved ? toKmaGrid(location.latitude, location.longitude) : null;
  const midForecastRegionIds =
    mapping?.midForecast?.verified === true &&
    validProviderKey(mapping.midForecast.temperatureRegId) &&
    validProviderKey(mapping.midForecast.landRegId)
      ? Object.freeze({
          temperatureRegId: mapping.midForecast.temperatureRegId,
          landRegId: mapping.midForecast.landRegId,
        })
      : null;

  return Object.freeze({
    legalDongCode10:
      typeof location.legalDongCode === 'string' && /^\d{10}$/.test(location.legalDongCode)
        ? location.legalDongCode
        : null,
    verifiedSoilAreaCode: mapping?.soil?.verified === true ? mapping.soil.code : null,
    shortForecastGrid: grid,
    midForecastRegionIds,
    normalStationId: mapping?.normalStation?.verified === true ? mapping.normalStation.id : null,
    observationStationId:
      isAddressResolved && mapping?.observationStation?.verified === true
        ? mapping.observationStation.id
        : null,
    observationDistanceKm:
      isAddressResolved &&
      mapping?.observationStation?.verified === true &&
      Number.isFinite(mapping.observationStation.distanceKm)
        ? mapping.observationStation.distanceKm
        : null,
  });
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
    !validProviderKey(mapping.soil.code)
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
    if (
      !Number.isFinite(mapping.observationStation.distanceKm) ||
      mapping.observationStation.distanceKm < 0
    ) {
      errors.push('observationStation.distanceKm is invalid');
    }
    if (
      mapping.observationStation.operationalVerified !== true ||
      mapping.observationStation.periodDataVerified !== true
    ) {
      errors.push(
        'observationStation operation and requested-period data must be verified',
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
