import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SchemaChangedError,
  VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
  createSoilExamAdapter,
  parseSoilExam,
  validateDataEnvelope,
} from "../src/adapters/index.js";

const PNU = "4611010100101830025";

function examXml({ pnu = PNU, ph = "6.2", ec = "1.1" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <response>
      <Result_Code>200</Result_Code>
      <items>
        <item>
          <PNU_Cd>${pnu}</PNU_Cd>
          <Exam_Day>20260720</Exam_Day>
          <Exam_Type>밭</Exam_Type>
          <ACID>${ph}</ACID>
          <ELCD>${ec}</ELCD>
          <OM>28</OM>
          <VLDPHA>430</VLDPHA>
          <POSIFERT_K>0.42</POSIFERT_K>
          <POSIFERT_CA>5.1</POSIFERT_CA>
          <POSIFERT_MG>1.6</POSIFERT_MG>
        </item>
      </items>
    </response>`;
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

test("soil exam parser returns measured points without parcel identifiers", () => {
  const result = parseSoilExam(examXml(), { expectedPnu: PNU });

  assert.equal(result.dataRole, "PROVIDER_SOIL_TEST");
  assert.equal(result.sampledOn, "2026-07-20");
  assert.equal(result.metrics.length, 7);
  assert.deepEqual(result.metrics[0], {
    metric: "PH",
    unit: "pH",
    boundarySemanticsVerified: true,
    totalValidArea: 1,
    areaUnit: "MEASURED_POINT",
    intervals: [
      {
        lower: 6.2,
        upper: 6.2,
        lowerInclusive: true,
        upperInclusive: true,
        area: 1,
        areaUnit: "MEASURED_POINT",
      },
    ],
  });
  assert.equal(JSON.stringify(result).includes(PNU), false);
});

test("soil exam parser preserves missing chemistry instead of substituting zero", () => {
  const result = parseSoilExam(examXml({ ec: "" }), {
    expectedPnu: PNU,
  });

  assert.equal(
    result.metrics.some((metric) => metric.metric === "EC"),
    false,
  );
});

test("soil exam parser rejects a response for a different parcel", () => {
  assert.throws(
    () =>
      parseSoilExam(
        examXml({ pnu: "4611010100101830026" }),
        { expectedPnu: PNU },
      ),
    SchemaChangedError,
  );
});

test("soil exam adapter returns a valid envelope and exposes no key or PNU", async () => {
  const adapter = createSoilExamAdapter({
    enabled: true,
    apiKey: "fixture-secret",
    contractVersion: VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
    fetchImpl: async () => textResponse(examXml()),
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });

  const envelope = await adapter.getLatestExam(
    { pnuCode: PNU },
    { deadlineAt: Date.now() + 1000 },
  );
  const serialized = JSON.stringify(envelope);
  assert.equal(envelope.adapterState, "SUCCESS");
  assert.equal(envelope.observedAt, "2026-07-19T15:00:00.000Z");
  assert.equal(validateDataEnvelope(envelope).valid, true);
  assert.equal(serialized.includes("fixture-secret"), false);
  assert.equal(serialized.includes(PNU), false);
});

test("soil exam adapter performs no fetch while disabled", async () => {
  let calls = 0;
  const adapter = createSoilExamAdapter({
    enabled: false,
    apiKey: "fixture-secret",
    contractVersion: VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
    fetchImpl: async () => {
      calls += 1;
      return textResponse(examXml());
    },
  });

  const envelope = await adapter.getLatestExam({ pnuCode: PNU });
  assert.equal(calls, 0);
  assert.equal(envelope.adapterState, "UNSUPPORTED");
});
