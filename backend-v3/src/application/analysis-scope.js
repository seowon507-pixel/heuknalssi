import { projectAnalysisScope } from "../domain/analysis-scope.js";

function hasUsableData(envelope) {
  return (
    envelope?.adapterState === "SUCCESS" &&
    envelope.deliveryState !== "UNAVAILABLE" &&
    envelope.data !== null &&
    envelope.data !== undefined
  );
}

function envelopeOutcome(envelope, { noData, unavailable }) {
  if (hasUsableData(envelope)) {
    return { state: "AVAILABLE", missingReasonCode: null };
  }
  if (envelope?.adapterState === "NO_DATA") {
    return { state: "MISSING", missingReasonCode: noData };
  }
  return { state: "UNAVAILABLE", missingReasonCode: unavailable };
}

function sourceLimitations(envelope, base = []) {
  const limitations = [...base];
  if (envelope?.freshness === "STALE") limitations.push("SOURCE_STALE");
  if (
    envelope?.freshness === "SAMPLE" ||
    envelope?.deliveryState === "SAMPLE"
  ) {
    limitations.push("SOURCE_SAMPLE");
  }
  return [...new Set(limitations)];
}

function item({
  itemId,
  label,
  scope,
  envelope,
  outcome,
  distanceKm = null,
  limitationCodes = [],
}) {
  return {
    itemId,
    label,
    scope,
    state: outcome.state,
    missingReasonCode: outcome.missingReasonCode,
    distanceKm,
    source: envelope ?? null,
    limitationCodes: sourceLimitations(envelope, limitationCodes),
  };
}

function unavailableForMissingPrerequisite(code) {
  return { state: "MISSING", missingReasonCode: code };
}

function notApplicable() {
  return { state: "NOT_APPLICABLE", missingReasonCode: null };
}

function userSoilTestSource(request) {
  if (!request?.soilTest) return null;
  return {
    sourceId: "user-soil-test",
    sourceName: "사용자 등록 토양검정 결과",
    sourceUrl: "https://soil.rda.go.kr/",
    retrievedAt: null,
    observedAt: `${request.soilTest.sampledOn}T00:00:00.000Z`,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FIELD",
    spatialLabel: "사용자가 등록한 검정 필지",
    distanceKm: null,
    deliveryState: "LIVE",
    adapterState: "SUCCESS",
    freshness: "CURRENT",
    qualityFlags: ["SOIL_VALUE_FROM_USER_SUBMITTED_EXAM"],
  };
}

function fieldSoilExamItem({
  request,
  fieldParcelLookupAvailable,
  envelopes,
  soilMeasurementEnvelope,
}) {
  const hydroponic = request?.cultivationMode === "FACILITY_HYDRO";
  const userMeasurement = request?.soilTest ?? null;
  const source = userMeasurement
    ? soilMeasurementEnvelope ?? envelopes.soilTest ?? userSoilTestSource(request)
    : envelopes.soilExam;
  let outcome;
  if (hydroponic) {
    outcome = notApplicable();
  } else if (userMeasurement) {
    outcome = { state: "AVAILABLE", missingReasonCode: null };
  } else if (!fieldParcelLookupAvailable) {
    outcome = unavailableForMissingPrerequisite(
      "FIELD_PARCEL_LOOKUP_UNAVAILABLE",
    );
  } else {
    outcome = envelopeOutcome(envelopes.soilExam, {
      noData: "NO_FIELD_SOIL_EXAM_HISTORY",
      unavailable: "FIELD_SOIL_EXAM_UNAVAILABLE",
    });
  }
  return item({
    itemId: "FIELD_SOIL_EXAM",
    label: "최근 필지 토양검정",
    scope: "FIELD_MEASUREMENT",
    envelope: source,
    outcome,
  });
}

function fieldSoilMapItem({
  request,
  fieldParcelLookupAvailable,
  envelopes,
}) {
  let outcome;
  if (request?.cultivationMode === "FACILITY_HYDRO") {
    outcome = notApplicable();
  } else if (!fieldParcelLookupAvailable) {
    outcome = unavailableForMissingPrerequisite(
      "FIELD_PARCEL_LOOKUP_UNAVAILABLE",
    );
  } else {
    outcome = envelopeOutcome(envelopes.fieldSoil, {
      noData: "NO_FIELD_SOIL_MAP_DATA",
      unavailable: "FIELD_SOIL_MAP_UNAVAILABLE",
    });
  }
  return item({
    itemId: "FIELD_SOIL_MAP",
    label: "1:5,000 필지 토양도",
    scope: "FIELD_SOIL_MAP",
    envelope: envelopes.fieldSoil,
    outcome,
    limitationCodes: ["SOIL_MAP_NOT_CHEMISTRY_MEASUREMENT"],
  });
}

function climateItem({ broad, locationKeys, envelopes }) {
  const outcome = locationKeys.normalStationId
    ? envelopeOutcome(envelopes.climate, {
        noData: "NO_CLIMATE_NORMAL_DATA",
        unavailable: "CLIMATE_NORMAL_UNAVAILABLE",
      })
    : unavailableForMissingPrerequisite(
        "CLIMATE_NORMAL_STATION_UNAVAILABLE",
      );
  return item({
    itemId: "CLIMATE_NORMAL",
    label: "기후평년",
    scope: broad ? "ADMIN_AREA_REFERENCE" : "ADDRESS_POINT",
    envelope: envelopes.climate,
    outcome,
    limitationCodes: ["CLIMATE_NORMAL_NOT_RECENT_WEATHER"],
  });
}

function observationItem({ broad, locationKeys, envelopes }) {
  let outcome;
  if (broad) {
    outcome = unavailableForMissingPrerequisite(
      "DETAILED_ADDRESS_REQUIRED_FOR_OBSERVATION",
    );
  } else if (!locationKeys.observationStationId) {
    outcome = unavailableForMissingPrerequisite(
      "OBSERVATION_STATION_MAPPING_UNAVAILABLE",
    );
  } else {
    outcome = envelopeOutcome(envelopes.observations, {
      noData: "NO_RECENT_OBSERVATION_DATA",
      unavailable: "RECENT_OBSERVATION_UNAVAILABLE",
    });
  }
  return item({
    itemId: "RECENT_OBSERVATION",
    label: "최근 7일 관측",
    scope: "ADDRESS_POINT",
    envelope: envelopes.observations,
    outcome,
    distanceKm: broad
      ? null
      : envelopes.observations?.distanceKm ??
        locationKeys.observationDistanceKm ??
        null,
    limitationCodes: ["OBSERVATION_STATION_NOT_FIELD_MICROCLIMATE"],
  });
}

function shortForecastItem({ broad, locationKeys, envelopes }) {
  const administrativeReference =
    broad || locationKeys.shortForecastScope === "ADMIN_AREA_REPRESENTATIVE";
  const missingGridReason = administrativeReference
    ? "ADMIN_AREA_FORECAST_REFERENCE_UNAVAILABLE"
    : "FORECAST_GRID_UNAVAILABLE";
  const outcome = locationKeys.shortForecastGrid
    ? envelopeOutcome(envelopes.shortForecast, {
        noData: "NO_SHORT_FORECAST_DATA",
        unavailable: "SHORT_FORECAST_UNAVAILABLE",
      })
    : unavailableForMissingPrerequisite(missingGridReason);
  return item({
    itemId: "SHORT_FORECAST",
    label: "단기예보",
    scope: administrativeReference
      ? "ADMIN_AREA_REFERENCE"
      : "ADDRESS_POINT",
    envelope: envelopes.shortForecast,
    outcome,
    limitationCodes: ["FORECAST_NOT_FIELD_OBSERVATION"],
  });
}

function regionalSoilItem({ locationKeys, envelopes }) {
  const outcome = locationKeys.verifiedSoilAreaCode
    ? envelopeOutcome(envelopes.soil, {
        noData: "NO_REGIONAL_SOIL_DATA",
        unavailable: "REGIONAL_SOIL_UNAVAILABLE",
      })
    : unavailableForMissingPrerequisite(
        "REGIONAL_SOIL_REFERENCE_UNAVAILABLE",
      );
  return item({
    itemId: "REGIONAL_SOIL_STATISTICS",
    label: "행정구역 토양 통계",
    scope: "ADMIN_AREA_REFERENCE",
    envelope: envelopes.soil,
    outcome,
    limitationCodes: ["REGIONAL_SOIL_NOT_FIELD_MEASUREMENT"],
  });
}

function midForecastItem({ locationKeys, envelopes }) {
  const outcome = locationKeys.midForecastRegionIds
    ? envelopeOutcome(envelopes.midForecast, {
        noData: "NO_MID_FORECAST_DATA",
        unavailable: "MID_FORECAST_UNAVAILABLE",
      })
    : unavailableForMissingPrerequisite("MID_FORECAST_REGION_UNAVAILABLE");
  return item({
    itemId: "MID_FORECAST",
    label: "중기예보",
    scope: "ADMIN_AREA_REFERENCE",
    envelope: envelopes.midForecast,
    outcome,
    limitationCodes: ["FORECAST_NOT_FIELD_OBSERVATION"],
  });
}

function satelliteProjection({ request, satellite }) {
  const requested = request?.options?.includeSatelliteObservation === true;
  if (request?.cultivationMode !== "OPEN_FIELD") {
    return {
      satelliteState: "NOT_APPLICABLE",
      missingReasonCode: null,
      limitationCodes: [],
    };
  }
  if (!requested) {
    return {
      satelliteState: "NOT_REQUESTED",
      missingReasonCode: null,
      limitationCodes: [],
    };
  }
  if (!request?.parcel) {
    return {
      satelliteState: "MISSING",
      missingReasonCode: "FIELD_BOUNDARY_REQUIRED_FOR_SATELLITE",
      limitationCodes: [],
    };
  }
  if (satellite?.state === "READY") {
    return {
      satelliteState: "AVAILABLE",
      missingReasonCode: null,
      limitationCodes: ["SATELLITE_REMOTE_OBSERVATION_NOT_DIAGNOSIS"],
    };
  }
  if (satellite?.state === "PARTIAL") {
    return {
      satelliteState: "PARTIAL",
      missingReasonCode: null,
      limitationCodes: ["SATELLITE_REMOTE_OBSERVATION_NOT_DIAGNOSIS"],
    };
  }
  const notEnabled =
    satellite?.state === "UNSUPPORTED" ||
    satellite?.blockingReasons?.some((reason) =>
      ["SATELLITE_P2_NOT_ENABLED", "SATELLITE_NOT_ENABLED"].includes(reason),
    );
  return {
    satelliteState: "UNAVAILABLE",
    missingReasonCode: notEnabled
      ? "SATELLITE_NOT_ENABLED"
      : "SATELLITE_OBSERVATION_UNAVAILABLE",
    limitationCodes: ["SATELLITE_REMOTE_OBSERVATION_NOT_DIAGNOSIS"],
  };
}

/**
 * Translates private orchestration facts and provider envelopes into the
 * public scope contract. The internal field lookup key and parcel geometry are
 * used only as booleans and never passed to the domain projection.
 */
export function buildAnalysisScopeProjection({
  request,
  resolvedLocation,
  locationKeys = {},
  envelopes = {},
  soilMeasurementEnvelope = null,
  satellite = null,
}) {
  if (!request || !resolvedLocation) {
    throw new TypeError("analysis scope requires request and resolvedLocation");
  }
  const broad = resolvedLocation.resolutionMode === "ADMIN_AREA_BROAD";
  const locationPrecision = broad ? "ADMIN_AREA_BROAD" : "ADDRESS_RESOLVED";
  const parcelState = request.parcel
    ? "POLYGON_REGISTERED"
    : broad
      ? "ADMIN_AREA_ONLY"
      : "UNREGISTERED";
  const fieldParcelLookupAvailable =
    typeof resolvedLocation.fieldParcelLookupKey === "string" &&
    /^\d{19}$/u.test(resolvedLocation.fieldParcelLookupKey);

  return projectAnalysisScope({
    locationPrecision,
    parcelState,
    items: [
      fieldSoilExamItem({
        request,
        fieldParcelLookupAvailable,
        envelopes,
        soilMeasurementEnvelope,
      }),
      fieldSoilMapItem({ request, fieldParcelLookupAvailable, envelopes }),
      climateItem({ broad, locationKeys, envelopes }),
      observationItem({ broad, locationKeys, envelopes }),
      shortForecastItem({ broad, locationKeys, envelopes }),
      regionalSoilItem({ locationKeys, envelopes }),
      midForecastItem({ locationKeys, envelopes }),
    ],
    parcelObservation: satelliteProjection({ request, satellite }),
  });
}
