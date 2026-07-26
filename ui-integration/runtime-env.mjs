import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
} from "../backend-v3/src/adapters/index.js";

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function defaultFlag(env, name, enabled) {
  if (env[name] === undefined) {
    env[name] = enabled ? "true" : "false";
  }
}

function defaultContract(env, name, value) {
  if (!hasValue(env[name])) env[name] = value;
}

export function buildBackendEnvironment({
  baseEnv = {},
  runtimeMode,
  backendPort,
  frontendOrigin,
  sampleRuntimePath,
  reviewedRuntimePath,
}) {
  const env = {
    ...baseEnv,
    NODE_ENV: "development",
    PORT: String(backendPort),
    ALLOWED_ORIGINS: frontendOrigin,
    SESSION_SECRET:
      baseEnv.SESSION_SECRET ??
      "local-ui-integration-session-secret-at-least-32-characters",
  };

  if (runtimeMode === "sample") {
    env.TRUSTED_BACKEND_RUNTIME_MODULE = sampleRuntimePath;
    env.ENABLE_LIVE_KAKAO = "false";
    env.ENABLE_LIVE_KMA_SHORT = "false";
    env.ENABLE_LIVE_KMA_MID = "false";
    env.ENABLE_LIVE_KMA_ASOS = "false";
    env.ENABLE_LIVE_KMA_CLIMATE_NORMAL = "false";
    env.ENABLE_LIVE_SOIL = "false";
    env.ENABLE_LIVE_SOIL_FIELD = "false";
    env.ENABLE_SMARTFARM = "false";
    return env;
  }

  if (runtimeMode === "safe") {
    env.TRUSTED_BACKEND_RUNTIME_MODULE = "";
    env.ENABLE_LIVE_KAKAO = "false";
    env.ENABLE_LIVE_KMA_SHORT = "false";
    env.ENABLE_LIVE_KMA_MID = "false";
    env.ENABLE_LIVE_KMA_ASOS = "false";
    env.ENABLE_LIVE_KMA_CLIMATE_NORMAL = "false";
    env.ENABLE_LIVE_SOIL = "false";
    env.ENABLE_LIVE_SOIL_FIELD = "false";
    env.ENABLE_SMARTFARM = "false";
    return env;
  }

  if (runtimeMode !== "external") {
    throw new TypeError(`unsupported runtime mode: ${runtimeMode}`);
  }
  if (!hasValue(reviewedRuntimePath)) {
    throw new TypeError("external mode requires reviewedRuntimePath");
  }
  env.TRUSTED_BACKEND_RUNTIME_MODULE = reviewedRuntimePath;

  const publicDataConfigured = hasValue(env.DATA_GO_KR_SERVICE_KEY);
  defaultFlag(env, "ENABLE_LIVE_KMA_SHORT", publicDataConfigured);
  defaultFlag(env, "ENABLE_LIVE_KMA_MID", publicDataConfigured);
  defaultFlag(env, "ENABLE_LIVE_KMA_ASOS", publicDataConfigured);
  if (publicDataConfigured) {
    defaultContract(
      env,
      "KMA_SHORT_CONTRACT_VERSION",
      VERIFIED_KMA_SHORT_CONTRACT_VERSION,
    );
    defaultContract(
      env,
      "KMA_MID_CONTRACT_VERSION",
      VERIFIED_KMA_MID_CONTRACT_VERSION,
    );
    defaultContract(
      env,
      "KMA_ASOS_CONTRACT_VERSION",
      VERIFIED_KMA_ASOS_CONTRACT_VERSION,
    );
  }

  // 평년값은 저장소에 포함된 1991-2020 정적 데이터셋에서 읽으므로
  // 외부 키가 필요 없다. external 모드에서는 항상 켠다.
  defaultFlag(env, "ENABLE_LIVE_KMA_CLIMATE_NORMAL", true);
  defaultContract(
    env,
    "KMA_CLIMATE_NORMAL_CONTRACT_VERSION",
    VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  );

  const kakaoConfigured = hasValue(env.KAKAO_REST_API_KEY);
  defaultFlag(env, "ENABLE_LIVE_KAKAO", kakaoConfigured);
  if (kakaoConfigured) {
    defaultContract(
      env,
      "KAKAO_CONTRACT_VERSION",
      VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
    );
  }

  // The reviewed runtime freezes data.go.kr dataset 15144685's official
  // pH interval/area contract. The same public-data credential is used.
  defaultFlag(env, "ENABLE_LIVE_SOIL", publicDataConfigured);
  defaultFlag(env, "ENABLE_LIVE_SOIL_FIELD", publicDataConfigured);
  if (publicDataConfigured) {
    defaultContract(
      env,
      "SOIL_FIELD_CONTRACT_VERSION",
      VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
    );
  }

  const smartfarmConfigured = hasValue(env.SMARTFARM_SERVICE_KEY);
  defaultFlag(env, "ENABLE_SMARTFARM", smartfarmConfigured);
  if (smartfarmConfigured) {
    defaultContract(
      env,
      "SMARTFARM_CONTRACT_VERSION",
      VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
    );
  }
  return env;
}
