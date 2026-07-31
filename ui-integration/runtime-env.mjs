import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
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

  if (runtimeMode === "safe") {
    env.TRUSTED_BACKEND_RUNTIME_MODULE = "";
    env.ENABLE_LIVE_KAKAO = "false";
    env.ENABLE_LIVE_KMA_SHORT = "false";
    env.ENABLE_LIVE_KMA_MID = "false";
    env.ENABLE_LIVE_KMA_ASOS = "false";
    env.ENABLE_LIVE_KMA_CLIMATE_NORMAL = "false";
    env.ENABLE_LIVE_KMA_LOCATION_CATALOG = "false";
    env.ENABLE_LIVE_SOIL = "false";
    env.ENABLE_LIVE_SOIL_FIELD = "false";
    env.ENABLE_LIVE_SOIL_EXAM = "false";
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

  // API 허브 키가 있으면 실제 평년값 API를 우선 사용하고, 미승인·장애 시
  // 저장소의 동일 기준기간 공식 검수본으로 전환한다.
  defaultFlag(env, "ENABLE_LIVE_KMA_CLIMATE_NORMAL", true);
  defaultContract(
    env,
    "KMA_CLIMATE_NORMAL_CONTRACT_VERSION",
    VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  );
  const kmaApiHubConfigured = hasValue(env.KMA_API_HUB_AUTH_KEY);
  defaultFlag(
    env,
    "ENABLE_LIVE_KMA_LOCATION_CATALOG",
    kmaApiHubConfigured,
  );
  if (kmaApiHubConfigured) {
    defaultContract(
      env,
      "KMA_LOCATION_CATALOG_CONTRACT_VERSION",
      VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
    );
  }

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
  defaultFlag(env, "ENABLE_LIVE_SOIL_EXAM", publicDataConfigured);
  if (publicDataConfigured) {
    defaultContract(
      env,
      "SOIL_FIELD_CONTRACT_VERSION",
      VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
    );
    defaultContract(
      env,
      "SOIL_EXAM_CONTRACT_VERSION",
      VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
    );
  }

  // 현재 제품 범위에서 SmartFarm은 제외한다. 키가 남아 있어도 호출하지 않는다.
  env.ENABLE_SMARTFARM = "false";
  return env;
}
