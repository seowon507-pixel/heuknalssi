import { randomUUID } from "node:crypto";

import { normalizeParcelGeometry } from "../domain/parcel.js";

const LOOKBACK_DAYS = 60;
const TREND_THRESHOLD = 0.05;

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
  return value;
}

function parcelKey(ownerSessionId, farmId) {
  return `parcel:${requireIdentifier(ownerSessionId, "ownerSessionId")}:${requireIdentifier(farmId, "farmId")}`;
}

function observationKey(ownerSessionId, farmId) {
  return `satellite:${requireIdentifier(ownerSessionId, "ownerSessionId")}:${requireIdentifier(farmId, "farmId")}`;
}

function assertStore(store) {
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof store.set !== "function"
  ) {
    throw new TypeError("satellite observation store must implement async get and set");
  }
  return store;
}

function nowIso(clock) {
  const value = new Date(clock());
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("satellite observation clock returned an invalid time");
  }
  return value.toISOString();
}

function evidenceRef(envelope, sourceKind = "SATELLITE") {
  return {
    sourceKind,
    sourceId: envelope.sourceId,
    observedAt: envelope.observedAt ?? null,
    fetchedAt: envelope.retrievedAt ?? null,
    spatialLevel: envelope.spatialLevel ?? "FIELD",
    state:
      envelope.deliveryState === "LIVE"
        ? "READY"
        : envelope.deliveryState === "CACHE"
          ? "PARTIAL"
          : "UNAVAILABLE",
    limitationCodes: [...new Set(envelope.qualityFlags ?? [])],
  };
}

function validNdviObservations(envelope) {
  if (envelope?.deliveryState !== "LIVE") return [];
  const observations = envelope.data?.observations;
  if (!Array.isArray(observations)) return [];
  return observations.filter(
    (item) =>
      Number.isFinite(item?.meanNdvi) &&
      item.meanNdvi >= -1 &&
      item.meanNdvi <= 1 &&
      Number.isFinite(item.validPixelRatio) &&
      item.validPixelRatio > 0,
  );
}

function describeTrend(observations) {
  if (observations.length < 2) return null;
  const first = observations[0];
  const latest = observations.at(-1);
  const change = latest.meanNdvi - first.meanNdvi;
  const direction =
    change <= -TREND_THRESHOLD
      ? "DECREASING"
      : change >= TREND_THRESHOLD
        ? "INCREASING"
        : "STABLE";
  return {
    direction,
    change: Math.round(change * 1000) / 1000,
    first: { observedTo: first.to, meanNdvi: first.meanNdvi },
    latest: { observedTo: latest.to, meanNdvi: latest.meanNdvi },
  };
}

function userMessage({ state, trend, catalogueReady }) {
  if (trend?.direction === "DECREASING") {
    return {
      summary: "같은 필지의 최근 식생지수가 이전 확인 구간보다 낮아졌습니다.",
      nextAction:
        "위성값만으로 원인을 정하지 말고, 오늘 현장에서 잎·과실 상태와 토양 수분을 함께 확인하세요.",
    };
  }
  if (trend?.direction === "INCREASING") {
    return {
      summary: "같은 필지의 최근 식생지수가 이전 확인 구간보다 높아졌습니다.",
      nextAction:
        "현재 관리 기록을 유지하고 다음 촬영 자료에서 같은 방향이 이어지는지 다시 확인하세요.",
    };
  }
  if (trend?.direction === "STABLE") {
    return {
      summary: "같은 필지의 최근 식생지수는 이전 확인 구간과 큰 차이가 없습니다.",
      nextAction:
        "오늘의 기상·토양 점검을 우선하고 다음 촬영 자료에서 변화를 다시 확인하세요.",
    };
  }
  if (catalogueReady) {
    return {
      summary: "최근 필지를 포함한 위성 촬영 자료는 확인했지만 식생 변화값은 아직 없습니다.",
      nextAction:
        "현장 점검을 우선하고, 위성 분석 연결 후 같은 필지의 시계열을 다시 확인하세요.",
    };
  }
  return {
    summary: "현재 조건에 맞는 위성 관측을 확인하지 못했습니다.",
    nextAction: "기상·토양 자료로 점검을 계속하고 다음 위성 촬영 뒤 다시 확인하세요.",
  };
}

function uniqueLimitations(envelopes) {
  return [
    ...new Set(
      envelopes.flatMap((envelope) => envelope?.qualityFlags ?? []),
    ),
  ];
}

export function createSatelliteObservationService({
  adapter = null,
  store,
  clock = Date.now,
  randomId = randomUUID,
} = {}) {
  const activeStore = assertStore(store);
  if (typeof clock !== "function" || typeof randomId !== "function") {
    throw new TypeError("satellite service dependencies are invalid");
  }

  return Object.freeze({
    async putParcel({ ownerSessionId, farmId, geometry }) {
      const key = parcelKey(ownerSessionId, farmId);
      const normalized = normalizeParcelGeometry(geometry);
      const existing = await activeStore.get(key);
      const timestamp = nowIso(clock);
      const record = {
        parcelId: existing?.parcelId ?? String(randomId()),
        farmId,
        geometry: normalized.geometry,
        areaSquareMeters: normalized.areaSquareMeters,
        bbox: normalized.bbox,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await activeStore.set(key, record);
      return structuredClone(record);
    },

    async getParcel({ ownerSessionId, farmId }) {
      const record = await activeStore.get(parcelKey(ownerSessionId, farmId));
      return record ? structuredClone(record) : null;
    },

    async getLatest({ ownerSessionId, farmId }) {
      const record = await activeStore.get(
        observationKey(ownerSessionId, farmId),
      );
      return record ? structuredClone(record) : null;
    },

    async refresh({ ownerSessionId, farmId, signal }) {
      const parcel = await activeStore.get(parcelKey(ownerSessionId, farmId));
      if (!parcel) throw new Error("parcel is not registered for this farm");
      if (
        !adapter ||
        typeof adapter.searchLatest !== "function" ||
        typeof adapter.getNdviSeries !== "function"
      ) {
        throw new Error("satellite adapter is not configured");
      }

      const to = nowIso(clock);
      const from = new Date(
        Date.parse(to) - LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const [catalogueResult, ndviResult] = await Promise.allSettled([
        adapter.searchLatest({ geometry: parcel.geometry, from, to, signal }),
        adapter.getNdviSeries({ geometry: parcel.geometry, from, to, signal }),
      ]);
      const catalogue =
        catalogueResult.status === "fulfilled" ? catalogueResult.value : null;
      const ndvi = ndviResult.status === "fulfilled" ? ndviResult.value : null;
      const catalogueReady =
        catalogue?.deliveryState === "LIVE" &&
        Array.isArray(catalogue.data?.items) &&
        catalogue.data.items.length > 0;
      const observations = validNdviObservations(ndvi);
      const trend = describeTrend(observations);
      const state = trend ? "READY" : catalogueReady ? "PARTIAL" : "HOLD";
      const message = userMessage({ state, trend, catalogueReady });
      const envelopes = [catalogue, ndvi].filter(Boolean);
      const record = {
        observationId: String(randomId()),
        parcelId: parcel.parcelId,
        farmId,
        provider: "COPERNICUS",
        collection: "sentinel-2-l2a",
        state,
        summary: message.summary,
        nextAction: message.nextAction,
        trend,
        catalogue: catalogue?.data ?? null,
        vegetation: ndvi?.data ?? null,
        evidenceRefs: envelopes.map((envelope) => evidenceRef(envelope)),
        limitations: uniqueLimitations(envelopes),
        createdAt: to,
      };
      await activeStore.set(observationKey(ownerSessionId, farmId), record);
      return structuredClone(record);
    },
  });
}

export const satelliteObservationDefaults = Object.freeze({
  lookbackDays: LOOKBACK_DAYS,
  trendThreshold: TREND_THRESHOLD,
});
