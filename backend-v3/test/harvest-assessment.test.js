import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleAiSelector } from "../src/adapters/google-ai.js";
import { createHarvestAssessmentService } from "../src/application/harvest-assessment.js";

const IMAGE_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]).toString("base64");

test("Google AI harvest assessment sends a bounded inline image and validates the result", async () => {
  let requestBody;
  const assessor = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          state: "NOT_READY",
          quality: "USABLE",
          confidence: 0.88,
          suggestedDelayDays: 5,
          recheckInDays: 3,
          visibleReasons: ["과실 길이가 아직 짧게 보입니다."],
        }) }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await assessor.assessHarvestPhoto({
    cropId: "CUCUMBER",
    mimeType: "image/jpeg",
    dataBase64: IMAGE_BASE64,
  });

  assert.equal(result.state, "NOT_READY");
  assert.equal(result.suggestedDelayDays, 5);
  assert.equal(requestBody.contents[0].parts[0].inlineData.data, IMAGE_BASE64);
  assert.equal(JSON.stringify(result).includes(IMAGE_BASE64), false);
});

test("unusable photo responses cannot delay a harvest schedule", async () => {
  const assessor = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        state: "NOT_READY",
        quality: "UNUSABLE",
        confidence: 0.9,
        suggestedDelayDays: 12,
        recheckInDays: 2,
        visibleReasons: ["수확할 부분이 흐립니다."],
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const result = await assessor.assessHarvestPhoto({
    cropId: "CUCUMBER",
    mimeType: "image/jpeg",
    dataBase64: IMAGE_BASE64,
  });

  assert.equal(result.state, "UNCERTAIN");
  assert.equal(result.suggestedDelayDays, 0);
});

test("harvest assessment rejects image bytes that do not match the declared MIME type", async () => {
  const assessor = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("provider must not be called");
    },
  });

  await assert.rejects(
    assessor.assessHarvestPhoto({
      cropId: "CUCUMBER",
      mimeType: "image/png",
      dataBase64: IMAGE_BASE64,
    }),
    (error) => error?.code === "HARVEST_PHOTO_INVALID",
  );
});

test("application service preserves exact farm, crop, and season scope", async () => {
  const service = createHarvestAssessmentService({
    assessor: {
      async assessHarvestPhoto() {
        return {
          state: "READY",
          quality: "USABLE",
          confidence: 0.8,
          suggestedDelayDays: 0,
          recheckInDays: 2,
          visibleReasons: ["수확할 과실이 선명하게 보입니다."],
        };
      },
    },
    clock: () => Date.parse("2026-08-04T00:00:00.000Z"),
  });

  const result = await service.assessPhoto({
    ownerSessionId: "session-1",
    farmId: "farm-1",
    cropId: "CUCUMBER",
    seasonId: "season-1",
    mimeType: "image/jpeg",
    dataBase64: IMAGE_BASE64,
  });

  assert.equal(result.farmId, "farm-1");
  assert.equal(result.cropId, "CUCUMBER");
  assert.equal(result.seasonId, "season-1");
  assert.equal(result.assessedAt, "2026-08-04T00:00:00.000Z");
});
