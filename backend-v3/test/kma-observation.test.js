import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter,
  parseKmaAsosDaily,
  parseKmaClimateNormals,
  selectKmaClimateNormals,
  validateDataEnvelope,
} from "../src/adapters/index.js";

const DATES = [
  "2026-07-19",
  "2026-07-20",
  "2026-07-21",
  "2026-07-22",
  "2026-07-23",
  "2026-07-24",
  "2026-07-25",
];

function asosPayload(dates = DATES) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        totalCount: dates.length,
        items: {
          item: dates.map((tm, index) => ({
            tm,
            stnId: "136",
            stnNm: "안동",
            avgTa: String(24 + index / 10),
            minTa: String(19 + index / 10),
            maxTa: String(30 + index / 10),
            sumRn: index === 2 ? "4.5" : "",
          })),
        },
      },
    },
  };
}

function climateDataset() {
  return {
    normalPeriod: "1991-2020",
    stations: {
      136: {
        stationId: "136",
        stationName: "안동",
        metrics: {
          meanTemperature: Array.from(
            { length: 12 },
            (_, index) => -4 + index * 2,
          ),
          precipitation: Array.from({ length: 12 }, () => 50),
        },
      },
    },
  };
}

function climateApiText() {
  return [
    "# ST,STN,MM,DD,TA,TA_MAX,TA_MIN,RN,HM,SS,=",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `2021,136,${index + 1},0,${-4 + index * 2},1,-9,20,65,180,=`,
    ),
    "#7777END",
  ].join("\n");
}

test("ASOS parser keeps seven completed days and marks blank dry-day precipitation", () => {
  const parsed = parseKmaAsosDaily(asosPayload(), {
    stationId: "136",
    expectedDates: DATES,
  });

  assert.equal(parsed.stationName, "안동");
  assert.equal(parsed.readings.length, 7);
  assert.equal(parsed.readings[0].precipitationAmount, 0);
  assert.equal(parsed.readings[2].precipitationAmount, 4.5);
  assert.deepEqual(parsed.missingDates, []);
  assert.ok(
    parsed.qualityFlags.includes("ASOS_DRY_DAY_BLANK_INTERPRETED_AS_ZERO"),
  );
});

test("climate-normal selector requires one official monthly mean for every month", () => {
  const parsed = selectKmaClimateNormals(climateDataset(), {
    stationId: "136",
  });

  assert.equal(parsed.normalPeriod, "1991-2020");
  assert.equal(parsed.observations.length, 12);
  assert.deepEqual(parsed.observations[0], {
    metric: "meanTemperature",
    month: 1,
    value: -4,
    unit: "degC",
  });
  assert.equal(parsed.monthlyNormals[11].normalPeriod, "1991-2020");
});

test("climate-normal API parser freezes the 1991-2020 monthly response contract", () => {
  const parsed = parseKmaClimateNormals(climateApiText(), {
    stationId: "136",
  });

  assert.equal(parsed.normalPeriod, "1991-2020");
  assert.equal(parsed.observations.length, 12);
  assert.equal(parsed.observations[0].value, -4);
  assert.equal(parsed.observations[11].value, 18);
});

test("live ASOS adapter sends the exact completed-day window and returns a valid envelope", async () => {
  let requestedUrl;
  const adapter = createKmaAsosObservationAdapter({
    enabled: true,
    apiKey: "public-data-key",
    contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify(asosPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const envelope = await adapter.getRecent({
    stationId: "136",
    completedDays: 7,
  });

  assert.equal(requestedUrl.searchParams.get("startDt"), "20260719");
  assert.equal(requestedUrl.searchParams.get("endDt"), "20260725");
  assert.equal(requestedUrl.searchParams.get("stnIds"), "136");
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.data.readings.length, 7);
  assert.equal(validateDataEnvelope(envelope).valid, true);
});

test("어제 자료가 아직 발표되지 않았으면 미완결로 정직하게 표시한다", async () => {
  // 오늘이 7/27이면 도메인이 기대하는 창은 7/20~7/26이다.
  // 기상청이 7/26을 아직 올리지 않아 6일만 온 상황.
  const published = DATES.slice(1);
  const adapter = createKmaAsosObservationAdapter({
    enabled: true,
    apiKey: "public-data-key",
    contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
    now: () => new Date("2026-07-27T00:30:00+09:00"),
    fetchImpl: async () =>
      new Response(JSON.stringify(asosPayload(published)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const envelope = await adapter.getRecent({ stationId: "136", completedDays: 7 });

  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.data.readings.length, 6);
  assert.ok(
    envelope.qualityFlags.includes("ASOS_COMPLETED_WINDOW_INCOMPLETE"),
    "발표되지 않은 날을 채우지 않고 미완결임을 드러내야 한다",
  );
});

test("climate-normal adapter uses the KMA API Hub response when available", async () => {
  let requestedUrl;
  const adapter = createKmaClimateNormalAdapter({
    enabled: true,
    apiKey: "api-hub-key",
    dataset: climateDataset(),
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(climateApiText(), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });

  const envelope = await adapter.getNormals({ stationId: "136" });

  assert.equal(requestedUrl.pathname.endsWith("/sfc_norm1.php"), true);
  assert.equal(requestedUrl.searchParams.get("norm"), "M");
  assert.equal(requestedUrl.searchParams.get("tmst"), "2021");
  assert.equal(requestedUrl.searchParams.get("stn"), "136");
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.data.observations.length, 12);
  assert.equal(envelope.data.normalPeriod, "1991-2020");
  assert.ok(envelope.qualityFlags.includes("KMA_API_HUB_LIVE"));
  assert.equal(validateDataEnvelope(envelope).valid, true);
});

test("climate-normal adapter falls back only to the bundled official dataset", async () => {
  const adapter = createKmaClimateNormalAdapter({
    enabled: true,
    dataset: climateDataset(),
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
    fetchImpl: async () =>
      new Response("utilization approval required", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
  });

  const envelope = await adapter.getNormals({ stationId: "136" });

  assert.equal(envelope.adapterState, "SUCCESS");
  assert.ok(
    envelope.qualityFlags.includes("BUNDLED_OFFICIAL_CLIMATE_NORMALS"),
  );
  assert.ok(
    envelope.qualityFlags.includes("KMA_API_HUB_INTERNAL_ERROR_FALLBACK"),
  );
  assert.equal(validateDataEnvelope(envelope).valid, true);
});

test("climate-normal bundled fallback reports missing stations as NO_DATA", async () => {
  const adapter = createKmaClimateNormalAdapter({
    enabled: true,
    dataset: climateDataset(),
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
  });

  const envelope = await adapter.getNormals({ stationId: "999" });

  assert.equal(envelope.adapterState, "NO_DATA");
  assert.equal(validateDataEnvelope(envelope).valid, true);
});

test("bundled climate-normal dataset covers the real stations the app resolves", async () => {
  const adapter = createKmaClimateNormalAdapter({
    enabled: true,
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
  });

  const envelope = await adapter.getNormals({ stationId: "108" });

  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.data.observations.length, 12);
  // 서울(108) 7월 평균기온 — 기상청 배포 엑셀과 대조한 값
  assert.equal(envelope.data.observations[6].value, 25.3);
});
