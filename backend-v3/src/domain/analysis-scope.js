const SCOPE_ORDER = Object.freeze([
  "FIELD_MEASUREMENT",
  "FIELD_SOIL_MAP",
  "ADDRESS_POINT",
  "ADMIN_AREA_REFERENCE",
]);

const SCOPE_LABELS = Object.freeze({
  FIELD_MEASUREMENT: "필지 실측",
  FIELD_SOIL_MAP: "필지 토양도",
  ADDRESS_POINT: "주소 지점",
  ADMIN_AREA_REFERENCE: "행정구역 참고",
});

const ITEM_STATES = new Set([
  "AVAILABLE",
  "MISSING",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
]);

const PARCEL_STATES = new Set([
  "UNREGISTERED",
  "ADMIN_AREA_ONLY",
  "POLYGON_REGISTERED",
]);

const SATELLITE_STATES = new Set([
  "NOT_REQUESTED",
  "AVAILABLE",
  "PARTIAL",
  "MISSING",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
]);

const PUBLIC_SOURCE_FIELDS = Object.freeze([
  "sourceId",
  "sourceName",
  "sourceUrl",
  "retrievedAt",
  "observedAt",
  "issuedAt",
  "validFrom",
  "validTo",
  "spatialLevel",
  "spatialLabel",
  "distanceKm",
  "deliveryState",
  "adapterState",
  "freshness",
  "qualityFlags",
]);

const MISSING_REASON_MESSAGES = Object.freeze({
  FIELD_PARCEL_LOOKUP_UNAVAILABLE:
    "필지 단위 토양자료를 조회할 수 있는 상세 지번 정보가 없습니다.",
  NO_FIELD_SOIL_EXAM_HISTORY:
    "이 필지에서 최근 토양검정 이력을 찾지 못했습니다.",
  FIELD_SOIL_EXAM_UNAVAILABLE:
    "필지 토양검정 자료를 현재 불러오지 못했습니다.",
  NO_FIELD_SOIL_MAP_DATA:
    "이 필지에 대응하는 토양도 특성 자료를 찾지 못했습니다.",
  FIELD_SOIL_MAP_UNAVAILABLE:
    "필지 토양도 특성 자료를 현재 불러오지 못했습니다.",
  DETAILED_ADDRESS_REQUIRED_FOR_OBSERVATION:
    "상세 주소가 없어 최근 관측지점 자료는 분석에 포함하지 않았습니다.",
  OBSERVATION_STATION_MAPPING_UNAVAILABLE:
    "주소에 대응하는 검증된 관측지점을 찾지 못했습니다.",
  NO_RECENT_OBSERVATION_DATA:
    "선택한 관측지점의 최근 관측자료가 없습니다.",
  RECENT_OBSERVATION_UNAVAILABLE:
    "최근 관측자료를 현재 불러오지 못했습니다.",
  CLIMATE_NORMAL_STATION_UNAVAILABLE:
    "검증된 기후평년 지점을 찾지 못했습니다.",
  NO_CLIMATE_NORMAL_DATA:
    "선택한 지점의 기후평년 자료가 없습니다.",
  CLIMATE_NORMAL_UNAVAILABLE:
    "기후평년 자료를 현재 불러오지 못했습니다.",
  FORECAST_GRID_UNAVAILABLE:
    "주소에 대응하는 단기예보 격자를 만들지 못했습니다.",
  ADMIN_AREA_FORECAST_REFERENCE_UNAVAILABLE:
    "이 행정구역에서 사용할 수 있는 대표 예보 격자를 찾지 못했습니다.",
  NO_SHORT_FORECAST_DATA:
    "선택한 격자의 단기예보 자료가 없습니다.",
  SHORT_FORECAST_UNAVAILABLE:
    "단기예보 자료를 현재 불러오지 못했습니다.",
  REGIONAL_SOIL_REFERENCE_UNAVAILABLE:
    "행정구역에 대응하는 토양 참고 범위를 찾지 못했습니다.",
  NO_REGIONAL_SOIL_DATA:
    "선택한 행정구역의 토양 통계자료가 없습니다.",
  REGIONAL_SOIL_UNAVAILABLE:
    "행정구역 토양 통계자료를 현재 불러오지 못했습니다.",
  MID_FORECAST_REGION_UNAVAILABLE:
    "행정구역에 대응하는 중기예보 구역을 찾지 못했습니다.",
  NO_MID_FORECAST_DATA:
    "선택한 구역의 중기예보 자료가 없습니다.",
  MID_FORECAST_UNAVAILABLE:
    "중기예보 자료를 현재 불러오지 못했습니다.",
  FIELD_BOUNDARY_REQUIRED_FOR_SATELLITE:
    "필지 위성 관찰에는 사용자가 확인한 필지 경계가 필요합니다.",
  SATELLITE_NOT_ENABLED:
    "현재 분석에서는 필지 위성 관찰을 사용할 수 없습니다.",
  SATELLITE_OBSERVATION_UNAVAILABLE:
    "필지 위성 관찰 자료를 현재 불러오지 못했습니다.",
});

const LIMITATION_MESSAGES = Object.freeze({
  SOIL_MAP_NOT_CHEMISTRY_MEASUREMENT:
    "필지 토양도는 배수·토성·유효토심 참고자료이며 pH·EC 실측값이 아닙니다.",
  REGIONAL_SOIL_NOT_FIELD_MEASUREMENT:
    "행정구역 토양 통계는 실제 필지의 토양 측정값이 아닙니다.",
  OBSERVATION_STATION_NOT_FIELD_MICROCLIMATE:
    "관측지점 자료는 실제 필지의 미기후 측정값이 아닙니다.",
  CLIMATE_NORMAL_NOT_RECENT_WEATHER:
    "기후평년은 장기 기준이며 최근 필지 날씨가 아닙니다.",
  FORECAST_NOT_FIELD_OBSERVATION:
    "예보는 격자·구역 전망이며 실제 필지 관측값이 아닙니다.",
  SATELLITE_REMOTE_OBSERVATION_NOT_DIAGNOSIS:
    "위성 자료는 필지 원격 관찰이며 현장 실측이나 원인 진단을 대신하지 않습니다.",
  SOURCE_STALE:
    "최신 자료가 아닌 캐시 자료이므로 현재 상태 해석에 제한이 있습니다.",
  SOURCE_SAMPLE:
    "샘플 자료는 실제 농업 판단에 사용할 수 없습니다.",
});

function requireEnum(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new TypeError(`${field} is not supported`);
  }
  return value;
}

function safeCode(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,95}$/u.test(value)
  ) {
    throw new TypeError(`${field} must be a stable uppercase code`);
  }
  return value;
}

function uniqueCodes(values, field) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => safeCode(value, field)))];
}

function optionalDistance(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("analysis scope distanceKm must be non-negative or null");
  }
  return value;
}

function publicSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const projected = {};
  for (const field of PUBLIC_SOURCE_FIELDS) {
    if (field === "qualityFlags") {
      projected.qualityFlags = Object.freeze(
        [...new Set((source.qualityFlags ?? []).filter(
          (flag) => typeof flag === "string" && flag.length <= 96,
        ))],
      );
      continue;
    }
    if (field === "distanceKm") {
      projected.distanceKm = optionalDistance(source.distanceKm);
      continue;
    }
    projected[field] = source[field] ?? null;
  }
  return Object.freeze(projected);
}

function normalizeItem(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError(`analysis scope items[${index}] must be an object`);
  }
  const itemId = safeCode(item.itemId, `analysis scope items[${index}].itemId`);
  const scope = requireEnum(
    item.scope,
    new Set(SCOPE_ORDER),
    `analysis scope items[${index}].scope`,
  );
  const state = requireEnum(
    item.state,
    ITEM_STATES,
    `analysis scope items[${index}].state`,
  );
  const missingReasonCode = safeCode(
    item.missingReasonCode,
    `analysis scope items[${index}].missingReasonCode`,
    { nullable: true },
  );
  if (["MISSING", "UNAVAILABLE"].includes(state) && missingReasonCode === null) {
    throw new TypeError(`${itemId} requires a missingReasonCode`);
  }
  if (!["MISSING", "UNAVAILABLE"].includes(state) && missingReasonCode !== null) {
    throw new TypeError(`${itemId} cannot have a missingReasonCode in ${state}`);
  }
  if (typeof item.label !== "string" || item.label.trim() === "") {
    throw new TypeError(`${itemId} requires a user-facing label`);
  }
  const source = publicSource(item.source);
  const distanceKm = optionalDistance(
    Object.hasOwn(item, "distanceKm")
      ? item.distanceKm
      : source?.distanceKm,
  );
  const sourceWithConsistentDistance = source
    ? Object.freeze({ ...source, distanceKm })
    : null;
  return Object.freeze({
    itemId,
    label: item.label.trim(),
    scope,
    scopeLabel: SCOPE_LABELS[scope],
    state,
    missingReasonCode,
    distanceKm,
    source: sourceWithConsistentDistance,
    limitationCodes: Object.freeze(
      uniqueCodes(
        item.limitationCodes,
        `analysis scope items[${index}].limitationCodes`,
      ),
    ),
  });
}

function groupState(items) {
  if (items.some(({ state }) => state === "AVAILABLE")) {
    return items.every(({ state }) => state === "AVAILABLE")
      ? "AVAILABLE"
      : "PARTIAL";
  }
  if (items.some(({ state }) => state === "UNAVAILABLE")) return "UNAVAILABLE";
  if (items.some(({ state }) => state === "MISSING")) return "MISSING";
  return "NOT_APPLICABLE";
}

function aggregateCodes(items, field, messages) {
  const affected = new Map();
  for (const item of items) {
    const codes = field === "missingReasonCode"
      ? item[field] === null
        ? []
        : [item[field]]
      : item[field];
    for (const code of codes) {
      const ids = affected.get(code) ?? [];
      ids.push(item.itemId);
      affected.set(code, ids);
    }
  }
  return Object.freeze(
    [...affected].map(([code, itemIds]) => Object.freeze({
      code,
      message: messages[code] ?? "이 자료의 범위 또는 상태를 추가로 확인해야 합니다.",
      itemIds: Object.freeze(itemIds),
    })),
  );
}

function normalizeParcelObservation(value, parcelState) {
  const input = value && typeof value === "object" ? value : {};
  const satelliteState = requireEnum(
    input.satelliteState ?? "NOT_REQUESTED",
    SATELLITE_STATES,
    "analysis scope parcelObservation.satelliteState",
  );
  const missingReasonCode = safeCode(
    input.missingReasonCode,
    "analysis scope parcelObservation.missingReasonCode",
    { nullable: true },
  );
  if (["MISSING", "UNAVAILABLE"].includes(satelliteState) && missingReasonCode === null) {
    throw new TypeError("satellite projection requires a missingReasonCode");
  }
  if (!["MISSING", "UNAVAILABLE"].includes(satelliteState) && missingReasonCode !== null) {
    throw new TypeError(`satellite projection cannot have a missingReasonCode in ${satelliteState}`);
  }
  return Object.freeze({
    parcelState,
    satelliteState,
    missingReasonCode,
    limitationCodes: Object.freeze(
      uniqueCodes(
        input.limitationCodes,
        "analysis scope parcelObservation.limitationCodes",
      ),
    ),
  });
}

/**
 * Builds the public, deterministic description of what each dataset can
 * actually represent. Provider payloads are projected through an allowlist so
 * internal parcel keys, exact coordinates, and raw rows cannot leak here.
 */
export function projectAnalysisScope({
  locationPrecision,
  parcelState,
  items,
  parcelObservation = null,
}) {
  requireEnum(
    locationPrecision,
    new Set(["ADDRESS_RESOLVED", "ADMIN_AREA_BROAD"]),
    "analysis scope locationPrecision",
  );
  requireEnum(parcelState, PARCEL_STATES, "analysis scope parcelState");
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError("analysis scope items must be a non-empty array");
  }
  const normalizedItems = items.map(normalizeItem);
  if (new Set(normalizedItems.map(({ itemId }) => itemId)).size !== normalizedItems.length) {
    throw new TypeError("analysis scope item ids must be unique");
  }
  const availableScopes = SCOPE_ORDER.filter((scope) =>
    normalizedItems.some(
      (item) => item.scope === scope && item.state === "AVAILABLE",
    ),
  );
  const groups = SCOPE_ORDER.flatMap((scope) => {
    const groupedItems = normalizedItems.filter((item) => item.scope === scope);
    if (groupedItems.length === 0) return [];
    return [Object.freeze({
      scope,
      label: SCOPE_LABELS[scope],
      state: groupState(groupedItems),
      items: Object.freeze(groupedItems),
    })];
  });
  const parcel = normalizeParcelObservation(parcelObservation, parcelState);
  const hasFieldScope = availableScopes.some((scope) =>
    ["FIELD_MEASUREMENT", "FIELD_SOIL_MAP"].includes(scope),
  );
  const aggregateItems = parcel.missingReasonCode === null
    ? normalizedItems
    : [
        ...normalizedItems,
        {
          itemId: "SATELLITE_OBSERVATION",
          missingReasonCode: parcel.missingReasonCode,
          limitationCodes: parcel.limitationCodes,
        },
      ];
  const limitationItems = parcel.limitationCodes.length === 0
    ? normalizedItems
    : [
        ...normalizedItems,
        {
          itemId: "SATELLITE_OBSERVATION",
          missingReasonCode: null,
          limitationCodes: parcel.limitationCodes,
        },
      ];

  return Object.freeze({
    version: "analysis-scope-v1",
    locationPrecision,
    parcel,
    summary: Object.freeze({
      highestPrecision: availableScopes[0] ?? null,
      availableScopes: Object.freeze(availableScopes),
      regionalReferenceOnly:
        availableScopes.length > 0 &&
        availableScopes.every((scope) => scope === "ADMIN_AREA_REFERENCE"),
      commonNotice:
        locationPrecision === "ADMIN_AREA_BROAD"
          ? Object.freeze({
              code: "ADMIN_AREA_REFERENCE_ONLY",
              title: "행정구역 참고 분석",
              message:
                hasFieldScope
                  ? "상세 주소 없이 수집한 기상·지역 자료는 행정구역 참고 범위이며, 등록한 필지 자료와 구분합니다."
                  : "상세 주소 없이 확인 가능한 지역 자료만 사용했으며, 필지 상태로 해석하지 않습니다.",
            })
          : null,
    }),
    groups: Object.freeze(groups),
    missingReasons: aggregateCodes(
      aggregateItems,
      "missingReasonCode",
      MISSING_REASON_MESSAGES,
    ),
    limitations: aggregateCodes(
      limitationItems,
      "limitationCodes",
      LIMITATION_MESSAGES,
    ),
  });
}

export const analysisScopeContract = Object.freeze({
  scopes: SCOPE_ORDER,
  labels: SCOPE_LABELS,
  itemStates: Object.freeze([...ITEM_STATES]),
  parcelStates: Object.freeze([...PARCEL_STATES]),
  satelliteStates: Object.freeze([...SATELLITE_STATES]),
});
