import assert from "node:assert/strict";
import test from "node:test";

import { buildBackendEnvironment } from "./runtime-env.mjs";

const common = Object.freeze({
  backendPort: 3100,
  frontendOrigin: "http://localhost:3000",
  sampleRuntimePath: "/private/tmp/heuknalssi-sample-runtime.mjs",
  reviewedRuntimePath: "/private/tmp/heuknalssi-reviewed-runtime.mjs",
});

test("external mode activates only credential-backed frozen live adapters", () => {
  const env = buildBackendEnvironment({
    ...common,
    runtimeMode: "external",
    baseEnv: {
      DATA_GO_KR_SERVICE_KEY: "public-data-secret",
      KMA_API_HUB_AUTH_KEY: "api-hub-secret",
      KAKAO_REST_API_KEY: "kakao-secret",
      SMARTFARM_SERVICE_KEY: "smartfarm-secret",
    },
  });

  assert.equal(env.ENABLE_LIVE_KMA_SHORT, "true");
  assert.equal(
    env.TRUSTED_BACKEND_RUNTIME_MODULE,
    "/private/tmp/heuknalssi-reviewed-runtime.mjs",
  );
  assert.equal(env.ENABLE_LIVE_KMA_MID, "true");
  assert.equal(env.ENABLE_LIVE_KMA_ASOS, "true");
  assert.equal(env.ENABLE_LIVE_KMA_CLIMATE_NORMAL, "true");
  assert.equal(env.KMA_SHORT_CONTRACT_VERSION, "fixture-kma-short-v1");
  assert.equal(env.KMA_MID_CONTRACT_VERSION, "fixture-kma-mid-dual-v1");
  assert.equal(
    env.KMA_ASOS_CONTRACT_VERSION,
    "data-go-asos-daily-v1-2025-09-17",
  );
  assert.equal(
    env.KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
    "kma-climate-normal-monthly-1991-2020-local-v1",
  );
  assert.equal(env.ENABLE_LIVE_KAKAO, "true");
  assert.equal(env.KAKAO_CONTRACT_VERSION, "fixture-kakao-address-v1");
  assert.equal(env.ENABLE_LIVE_SOIL, "true");
  assert.equal(env.ENABLE_SMARTFARM, "true");
  assert.equal(env.SMARTFARM_CONTRACT_VERSION, "smartfarm-reference-v1");
});

test("external mode preserves explicit operator disables", () => {
  const env = buildBackendEnvironment({
    ...common,
    runtimeMode: "external",
    baseEnv: {
      DATA_GO_KR_SERVICE_KEY: "public-data-secret",
      ENABLE_LIVE_KMA_SHORT: "false",
      ENABLE_LIVE_KMA_MID: "false",
      ENABLE_LIVE_KMA_ASOS: "false",
      ENABLE_LIVE_KMA_CLIMATE_NORMAL: "false",
      ENABLE_LIVE_SOIL: "false",
    },
  });

  assert.equal(env.ENABLE_LIVE_KMA_SHORT, "false");
  assert.equal(env.ENABLE_LIVE_KMA_MID, "false");
  assert.equal(env.ENABLE_LIVE_KMA_ASOS, "false");
  assert.equal(env.ENABLE_LIVE_KMA_CLIMATE_NORMAL, "false");
  assert.equal(env.ENABLE_LIVE_KAKAO, "false");
  assert.equal(env.ENABLE_LIVE_SOIL, "false");
  assert.equal(env.ENABLE_SMARTFARM, "false");
});

test("safe and sample modes never activate live providers from ambient keys", () => {
  for (const runtimeMode of ["safe", "sample"]) {
    const env = buildBackendEnvironment({
      ...common,
      runtimeMode,
      baseEnv: {
        DATA_GO_KR_SERVICE_KEY: "public-data-secret",
        KMA_API_HUB_AUTH_KEY: "api-hub-secret",
        KAKAO_REST_API_KEY: "kakao-secret",
        SMARTFARM_SERVICE_KEY: "smartfarm-secret",
      },
    });

    assert.equal(env.ENABLE_LIVE_KMA_SHORT, "false");
    assert.equal(env.ENABLE_LIVE_KMA_MID, "false");
    assert.equal(env.ENABLE_LIVE_KMA_ASOS, "false");
    assert.equal(env.ENABLE_LIVE_KMA_CLIMATE_NORMAL, "false");
    assert.equal(env.ENABLE_LIVE_KAKAO, "false");
    assert.equal(env.ENABLE_LIVE_SOIL, "false");
    assert.equal(env.ENABLE_SMARTFARM, "false");
  }
});
