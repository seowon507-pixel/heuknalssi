import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter,
  parseKmaAsosDaily,
  parseKmaClimateNormals,
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

function asosPayload() {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        totalCount: 7,
        items: {
          item: DATES.map((tm, index) => ({
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

function climateText() {
  return [
    "# ST,STN,MM,DD,TA,TA_MAX,TA_MIN,HM,SS,CA_TOT,=",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `2021,136,${index + 1},0,${-4 + index * 2},1,-9,65,180,5,=`,
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

test("climate-normal parser requires one official monthly mean for every month", () => {
  const parsed = parseKmaClimateNormals(climateText(), {
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

test("live climate-normal adapter requests the 1991-2020 monthly contract", async () => {
  let requestedUrl;
  const adapter = createKmaClimateNormalAdapter({
    enabled: true,
    apiKey: "api-hub-key",
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    now: () => new Date("2026-07-26T03:00:00.000Z"),
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(climateText(), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });

  const envelope = await adapter.getNormals({ stationId: "136" });

  assert.equal(requestedUrl.hostname, "apihub.kma.go.kr");
  assert.equal(requestedUrl.searchParams.get("norm"), "M");
  assert.equal(requestedUrl.searchParams.get("tmst"), "2021");
  assert.equal(requestedUrl.searchParams.get("stn"), "136");
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.data.observations.length, 12);
  assert.equal(validateDataEnvelope(envelope).valid, true);
});
