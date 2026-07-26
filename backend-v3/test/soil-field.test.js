import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaChangedError,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  createSoilFieldAdapter,
  parseKakaoCandidates,
  parseSoilFieldCharacteristics,
} from "../src/adapters/index.js";

const PNU = "4611010100101830025";

function fieldXml({
  pnu = PNU,
  drainage = "02",
  effectiveDepth = "03",
  texture = "04",
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <response>
      <Result_Code>200</Result_Code>
      <items>
        <item>
          <PNU_Code>${pnu}</PNU_Code>
          <Soildra_Code>${drainage}</Soildra_Code>
          <Vldsoildep_Code>${effectiveDepth}</Vldsoildep_Code>
          <Surtture_Code>${texture}</Surtture_Code>
        </item>
      </items>
    </response>`;
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/xml" }),
    async text() {
      return body;
    },
  };
}

test("Kakao exact parcel address derives a private 19-digit field lookup key", () => {
  const [candidate] = parseKakaoCandidates({
    documents: [
      {
        address_name: "전남 목포시 샘플로 1",
        address_type: "ROAD_ADDR",
        x: "126.4",
        y: "34.8",
        address: {
          b_code: "4611010100",
          mountain_yn: "N",
          main_address_no: "183",
          sub_address_no: "25",
        },
      },
    ],
  });
  assert.equal(candidate.fieldParcelLookupKey, PNU);
});

test("Kakao treats an omitted sub-address and mountain flag as provider defaults", () => {
  const [candidate] = parseKakaoCandidates({
    documents: [
      {
        address_name: "서울특별시 중구 세종대로 110",
        address_type: "ROAD_ADDR",
        x: "126.978",
        y: "37.566",
        address: {
          b_code: "1114010300",
          mountain_yn: "",
          main_address_no: "31",
          sub_address_no: "",
        },
      },
    ],
  });
  assert.equal(
    candidate.fieldParcelLookupKey,
    "1114010300100310000",
  );
});

test("soil field parser returns only audited physical properties and discards PNU", () => {
  const result = parseSoilFieldCharacteristics(fieldXml(), {
    expectedPnu: PNU,
  });
  assert.deepEqual(result, {
    parcelMatched: true,
    mapScale: "1:5000",
    drainageCode: "02",
    effectiveDepthCode: "03",
    topsoilTextureCode: "04",
    codeLabelsVerified: false,
  });
  assert.equal(JSON.stringify(result).includes(PNU), false);
});

test("soil field parser rejects a response for another parcel", () => {
  assert.throws(
    () =>
      parseSoilFieldCharacteristics(
        fieldXml({ pnu: "4611010100101830026" }),
        { expectedPnu: PNU },
      ),
    SchemaChangedError,
  );
});

test("soil field adapter performs no fetch while disabled", async () => {
  let calls = 0;
  const adapter = createSoilFieldAdapter({
    enabled: false,
    apiKey: "secret",
    contractVersion: VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
    fetchImpl: async () => {
      calls += 1;
      return textResponse(fieldXml());
    },
  });
  const envelope = await adapter.getFieldProfile({ pnuCode: PNU });
  assert.equal(calls, 0);
  assert.equal(envelope.adapterState, "UNSUPPORTED");
});

test("soil field adapter never exposes credential or parcel identifier", async () => {
  const adapter = createSoilFieldAdapter({
    enabled: true,
    apiKey: "fixture-secret",
    contractVersion: VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
    fetchImpl: async () => textResponse(fieldXml()),
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });
  const envelope = await adapter.getFieldProfile(
    { pnuCode: PNU },
    { deadlineAt: Date.now() + 1000 },
  );
  const serialized = JSON.stringify(envelope);
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(serialized.includes("fixture-secret"), false);
  assert.equal(serialized.includes(PNU), false);
});
