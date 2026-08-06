import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  createSmartfarmAdapter,
  parseSmartfarmFacilityReference,
  parseSmartfarmOutdoorReference
} from "../src/adapters/index.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async json() {
      return structuredClone(body);
    }
  };
}

const FACILITY_FIXTURE = Object.freeze([
  Object.freeze({
    statusCode: "00",
    statusMessage: "NORMAL_CODE",
    fcltyId: "PRIVATE_FACILITY_A",
    crpsnSn: 101,
    fcltyYear: "2024",
    itemCode: "090100",
    itemCodeNm: "오이",
    spciesCodeNm: "백다다기",
    scspnMltspnSeCodeNm: "연동",
    ctvtArNm: "중규모",
    fcltySidoCodeNm: "경기도",
    fcltySigunguCodeNm: "수원시",
    fcltyTyCodeNm: "비닐",
    ctvtMthdCodeNm: "토경"
  }),
  Object.freeze({
    statusCode: null,
    statusMessage: null,
    fcltyId: "PRIVATE_FACILITY_B",
    crpsnSn: 102,
    fcltyYear: "2023",
    itemCode: "090100",
    itemCodeNm: "오이",
    spciesCodeNm: "취청",
    scspnMltspnSeCodeNm: "단동",
    ctvtArNm: "소규모",
    fcltySidoCodeNm: "강원특별자치도",
    fcltySigunguCodeNm: "평창군",
    fcltyTyCodeNm: "유리",
    ctvtMthdCodeNm: "토경"
  }),
  Object.freeze({
    statusCode: null,
    statusMessage: null,
    fcltyId: "PRIVATE_FACILITY_C",
    crpsnSn: 103,
    fcltyYear: "2024",
    itemCode: "080300",
    itemCodeNm: "토마토",
    spciesCodeNm: null,
    scspnMltspnSeCodeNm: "연동",
    ctvtArNm: "대규모",
    fcltySidoCodeNm: "경기도",
    fcltySigunguCodeNm: "수원시",
    fcltyTyCodeNm: "유리",
    ctvtMthdCodeNm: "토경"
  })
]);

const OUTDOOR_FIXTURE = Object.freeze([
  Object.freeze({
    statusCode: "00",
    statusMessage: "NORMAL_CODE",
    userId: "PRIVATE_USER_A",
    facilityId: "PRIVATE_FIELD_A",
    addressName: "경기도 수원시",
    itemCode: "060100"
  }),
  Object.freeze({
    statusCode: null,
    statusMessage: null,
    userId: "PRIVATE_USER_B",
    facilityId: "PRIVATE_FIELD_B",
    addressName: "경상북도 안동시",
    itemCode: "060100"
  }),
  Object.freeze({
    statusCode: null,
    statusMessage: null,
    userId: "PRIVATE_USER_C",
    facilityId: "PRIVATE_FIELD_C",
    addressName: "강원특별자치도 평창군",
    itemCode: "050100"
  })
]);

test("facility parser builds an exact cucumber/soil cohort without exposing farm identifiers", () => {
  const result = parseSmartfarmFacilityReference(FACILITY_FIXTURE, {
    crop: "CUCUMBER",
    cultivationMode: "FACILITY_SOIL",
    regionLabel: "경기도 수원시"
  });

  assert.equal(result.datasetType, "FACILITY_ITEM_DATA");
  assert.equal(result.selectedCrop, "오이");
  assert.equal(result.farmCount, 2);
  assert.equal(result.seasonCount, 2);
  assert.equal(result.sameDistrictCount, 1);
  assert.equal(result.comparisonLevel, "SAME_DISTRICT");
  assert.deepEqual(result.datasetPeriod, { fromYear: 2023, toYear: 2024 });
  assert.equal(result.affectsDecision, false);
  assert.equal(result.affectsScore, false);
  assert.ok(result.availableDataTypes.includes("CONTROL"));
  assert.ok(result.availableDataTypes.includes("GROWTH_IMAGE"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_FACILITY"), false);
  assert.equal(serialized.includes("토마토"), false);
});

test("outdoor parser separates apple and potato cohorts by verified item code", () => {
  const apple = parseSmartfarmOutdoorReference(OUTDOOR_FIXTURE, {
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    regionLabel: "경기도 수원시"
  });
  const potato = parseSmartfarmOutdoorReference(OUTDOOR_FIXTURE, {
    crop: "POTATO",
    cultivationMode: "OPEN_FIELD",
    regionLabel: "강원특별자치도 평창군"
  });

  assert.equal(apple.farmCount, 2);
  assert.equal(apple.sameDistrictCount, 1);
  assert.ok(apple.availableDataTypes.includes("GROWTH"));
  assert.equal(potato.farmCount, 1);
  assert.equal(potato.sameDistrictCount, 1);
  assert.equal(potato.availableDataTypes.includes("GROWTH"), false);
  assert.ok(
    potato.limitations.includes(
      "POTATO_GROWTH_OPERATION_NOT_CONFIRMED"
    )
  );
  assert.equal(JSON.stringify(apple).includes("PRIVATE_USER"), false);
});

test("SmartFarm adapter calls the correct facility API and never discloses its key", async () => {
  let requestedUrl = null;
  const adapter = createSmartfarmAdapter({
    enabled: true,
    serviceKey: "fixture-smartfarm-secret",
    contractVersion: VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(FACILITY_FIXTURE);
    },
    now: () => new Date("2026-07-25T00:00:00.000Z")
  });

  const envelope = await adapter.getReference({
    crop: "CUCUMBER",
    cultivationMode: "FACILITY_SOIL",
    regionLabel: "경기도 수원시"
  });
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.spatialLevel, "REFERENCE_DATASET");
  assert.match(requestedUrl, /DataMartItemRestService/u);
  assert.match(requestedUrl, /fixture-smartfarm-secret/u);
  assert.equal(envelope.sourceUrl.includes("fixture-smartfarm-secret"), false);
  assert.equal(JSON.stringify(envelope).includes("fixture-smartfarm-secret"), false);
  assert.ok(envelope.qualityFlags.includes("NO_DECISION_WEIGHT"));
});

test("SmartFarm adapter calls outdoor data only for confirmed target contexts", async () => {
  let calls = 0;
  const adapter = createSmartfarmAdapter({
    enabled: true,
    serviceKey: "fixture-smartfarm-secret",
    contractVersion: VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(String(url), /OutdoorFarmRest/u);
      return jsonResponse(OUTDOOR_FIXTURE);
    }
  });

  const apple = await adapter.getReference({
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    regionLabel: "경기도 수원시"
  });
  const pear = await adapter.getReference({
    crop: "PEAR",
    cultivationMode: "OPEN_FIELD",
    regionLabel: "경기도 수원시"
  });
  assert.equal(apple.adapterState, "SUCCESS");
  assert.equal(pear.adapterState, "UNSUPPORTED");
  assert.ok(pear.qualityFlags.includes("SMARTFARM_CONTEXT_UNSUPPORTED"));
  assert.equal(calls, 1);
});

test("SmartFarm schema failures and provider status errors fail closed", async (t) => {
  const fixtures = [
    {
      name: "schema",
      payload: [{ unexpected: true }],
      state: "SCHEMA_CHANGED"
    },
    {
      name: "provider status",
      payload: [{ statusCode: "99", statusMessage: "private detail" }],
      state: "INTERNAL_ERROR"
    },
    {
      name: "unregistered service key",
      payload: [
        {
          statusCode: "30",
          statusMessage: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"
        }
      ],
      state: "AUTH_ERROR"
    }
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const adapter = createSmartfarmAdapter({
        enabled: true,
        serviceKey: "fixture-smartfarm-secret",
        contractVersion: VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
        fetchImpl: async () => jsonResponse(fixture.payload)
      });
      const result = await adapter.getReference({
        crop: "APPLE",
        cultivationMode: "OPEN_FIELD",
        regionLabel: "경기도 수원시"
      });
      assert.equal(result.adapterState, fixture.state);
      assert.equal(result.deliveryState, "UNAVAILABLE");
      assert.equal(result.data, null);
      assert.equal(JSON.stringify(result).includes("private detail"), false);
    });
  }
});
