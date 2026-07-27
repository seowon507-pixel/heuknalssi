import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
  createKmaLocationCatalogAdapter,
  parseKmaForecastZoneCatalog,
  parseKmaSurfaceStationCatalog,
} from "../src/adapters/index.js";
import {
  resolveLocationKeys,
  resolveOfficialCatalogMapping,
} from "../src/application/index.js";

function stationText() {
  const lines = Array.from({ length: 50 }, (_, index) => {
    const id = String(100 + index);
    const longitude = (126.9 + index * 0.001).toFixed(8);
    const latitude = (37.5 + index * 0.001).toFixed(8);
    return `${id.padStart(5)}  ${longitude}   ${latitude} 35100 10.00 11.00 1.50 10.00 1.00 108 서울                 Seoul                11B10101 1111010100 ---- 서울특별시 종로구`;
  });
  return ["#START7777", "# frozen fixture", ...lines, "#7777END"].join("\n");
}

function forecastZonePayload() {
  const item = [
    {
      regId: "11000000",
      regSp: "A",
      regUp: "",
      lat: 0,
      lon: 0,
    },
    {
      regId: "11B00000",
      regSp: "A",
      regUp: "11000000",
      lat: 0,
      lon: 0,
    },
    {
      regId: "11B10100",
      regSp: "B",
      regUp: "11B00000",
      lat: 0,
      lon: 0,
    },
    ...Array.from({ length: 250 }, (_, index) => ({
      regId: `11Z${String(index + 1).padStart(5, "0")}`,
      regSp: "C",
      regUp: "11B10100",
      lat: 37.5 + index * 0.0001,
      lon: 126.9 + index * 0.0001,
    })),
  ];
  item[3] = {
    regId: "11B10101",
    regSp: "C",
    regUp: "11B10100",
    lat: 37.56609444,
    lon: 126.9774167,
  };
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        totalCount: item.length,
        items: { item },
      },
    },
  };
}

test("official KMA station and forecast-zone catalogs preserve routing identifiers", () => {
  const stations = parseKmaSurfaceStationCatalog(stationText());
  const zones = parseKmaForecastZoneCatalog(forecastZonePayload());

  assert.equal(stations.length, 50);
  assert.deepEqual(stations[0], {
    id: "100",
    longitude: 126.9,
    latitude: 37.5,
    forecastRegionId: "11B10101",
    legalDongCode: "1111010100",
  });
  assert.ok(zones.some(({ id, type }) => id === "11B00000" && type === "A"));
  assert.ok(zones.some(({ id, type }) => id === "11B10101" && type === "C"));
});

test("nationwide catalog selects the nearest ASOS station and land ancestor", () => {
  const catalog = {
    stations: [
      {
        id: "108",
        latitude: 37.57142,
        longitude: 126.9658,
      },
      {
        id: "112",
        latitude: 37.47772,
        longitude: 126.6249,
      },
    ],
    zones: [
      { id: "11000000", type: "A", parentId: null },
      { id: "11B00000", type: "A", parentId: "11000000" },
      { id: "11B10100", type: "B", parentId: "11B00000" },
      {
        id: "11B10101",
        type: "C",
        parentId: "11B10100",
        latitude: 37.56609444,
        longitude: 126.9774167,
      },
    ],
  };
  const location = {
    resolutionMode: "ADDRESS_RESOLVED",
    latitude: 37.5663,
    longitude: 126.9779,
    legalDongCode: "1114010100",
  };

  assert.deepEqual(resolveOfficialCatalogMapping(location, catalog), {
    normalStationId: "108",
    observationStation: {
      id: "108",
      latitude: 37.57142,
      longitude: 126.9658,
    },
    midForecastRegionIds: {
      temperatureRegId: "11B10101",
      landRegId: "11B00000",
    },
  });

  const keys = resolveLocationKeys(location, {}, { officialCatalog: catalog });
  assert.equal(keys.observationStationId, "108");
  assert.equal(keys.normalStationId, "108");
  assert.deepEqual(keys.midForecastRegionIds, {
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
  });
  assert.ok(keys.observationDistanceKm > 0);
});

test("broad district input receives regional climate and mid forecast but not ASOS", () => {
  const catalog = {
    stations: [
      {
        id: "108",
        latitude: 37.57142,
        longitude: 126.9658,
      },
    ],
    zones: [
      { id: "11000000", type: "A", parentId: null },
      { id: "11B00000", type: "A", parentId: "11000000" },
      { id: "11B10100", type: "B", parentId: "11B00000" },
      {
        id: "11B10101",
        type: "C",
        parentId: "11B10100",
        latitude: 37.56609444,
        longitude: 126.9774167,
      },
    ],
  };
  const keys = resolveLocationKeys(
    {
      resolutionMode: "ADMIN_AREA_BROAD",
      administrativeRepresentative: {
        purpose: "REGIONAL_FORECAST_ONLY",
        latitude: 37.5663,
        longitude: 126.9779,
      },
      legalDongCode: "1114000000",
    },
    {},
    { officialCatalog: catalog },
  );

  assert.equal(keys.normalStationId, "108");
  assert.equal(keys.observationStationId, null);
  assert.equal(keys.observationDistanceKm, null);
  assert.deepEqual(keys.midForecastRegionIds, {
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
  });
});

test("location catalog adapter caches both official provider lists", async () => {
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount += 1;
    if (String(url).includes("stn_inf.php")) {
      return new Response(stationText(), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response(JSON.stringify(forecastZonePayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const adapter = createKmaLocationCatalogAdapter({
    enabled: true,
    apiKey: "secret",
    contractVersion: VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
    fetchImpl,
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  });

  const first = await adapter.getCatalog();
  const second = await adapter.getCatalog();

  assert.equal(first.adapterState, "SUCCESS");
  assert.equal(second.adapterState, "SUCCESS");
  assert.equal(first.data.stations.length, 50);
  assert.ok(first.data.zones.length >= 250);
  assert.equal(fetchCount, 2);
});
