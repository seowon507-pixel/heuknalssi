import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  VERIFIED_SOIL_V2_CONTRACT,
  createKakaoAdapter,
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter,
  createKmaMidForecastAdapter,
  createKmaShortForecastAdapter,
  createSmartfarmAdapter,
  createSoilV2Adapter,
} from "../src/adapters/index.js";

const publicDataKey = process.env.DATA_GO_KR_SERVICE_KEY;
const kakaoKey = process.env.KAKAO_REST_API_KEY;
const smartfarmKey = process.env.SMARTFARM_SERVICE_KEY;
const issues = providerIssueTimes(new Date());
const common = { timeoutMs: 7_000 };

const probes = await Promise.all([
  probeKakao(),
  probeKmaClimateNormal(),
  probeKmaAsos(),
  probeSoil(),
  probeKmaShort(),
  probeKmaMid(),
  probeSmartfarm(),
]);

console.log(JSON.stringify({ probes }, null, 2));

if (
  probes.some(
    ({ configured, state }) => configured && state !== "SUCCESS",
  )
) {
  process.exitCode = 1;
}

async function probeKakao() {
  if (!hasValue(kakaoKey)) {
    return summary("kakao", false, "NOT_CONFIGURED");
  }
  const adapter = createKakaoAdapter({
    ...common,
    enabled: true,
    apiKey: kakaoKey,
    contractVersion: VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  });
  const result = await adapter.searchLocations(
    "서울특별시 중구 세종대로 110",
  );
  return summary(
    "kakao",
    true,
    result.adapterState,
    result.data?.candidates?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeKmaShort() {
  if (!hasValue(publicDataKey)) {
    return summary("kmaShort", false, "NOT_CONFIGURED");
  }
  const adapter = createKmaShortForecastAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  });
  const result = await adapter.getForecast({
    nx: 60,
    ny: 127,
    ...issues.short,
  });
  return summary(
    "kmaShort",
    true,
    result.adapterState,
    result.data?.days?.length ?? 0,
    result.qualityFlags,
  );
}

// 평년값은 저장소에 포함된 정적 데이터셋에서 읽으므로 키 없이 항상 검증한다.
async function probeKmaClimateNormal() {
  const adapter = createKmaClimateNormalAdapter({
    ...common,
    enabled: true,
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  });
  const result = await adapter.getNormals({ stationId: "136" });
  return summary(
    "kmaClimateNormal",
    true,
    result.adapterState,
    result.data?.observations?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeKmaAsos() {
  if (!hasValue(publicDataKey)) {
    return summary("kmaAsos", false, "NOT_CONFIGURED");
  }
  const adapter = createKmaAsosObservationAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  });
  const result = await adapter.getRecent({
    stationId: "136",
    completedDays: 7,
  });
  return summary(
    "kmaAsos",
    true,
    result.adapterState,
    result.data?.readings?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeSoil() {
  if (!hasValue(publicDataKey)) {
    return summary("soilV2", false, "NOT_CONFIGURED");
  }
  const adapter = createSoilV2Adapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contract: VERIFIED_SOIL_V2_CONTRACT,
  });
  const result = await adapter.getDistribution({
    verifiedSoilAreaCode: "4717000000",
    landUse: "FRUIT",
  });
  return summary(
    "soilV2",
    true,
    result.adapterState,
    result.data?.metrics?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeKmaMid() {
  if (!hasValue(publicDataKey)) {
    return summary("kmaMid", false, "NOT_CONFIGURED");
  }
  const adapter = createKmaMidForecastAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_KMA_MID_CONTRACT_VERSION,
  });
  const result = await adapter.getForecast({
    temperatureRegId: "11B10101",
    landRegId: "11B00000",
    ...issues.mid,
  });
  return summary(
    "kmaMid",
    true,
    result.adapterState,
    result.data?.days?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeSmartfarm() {
  if (!hasValue(smartfarmKey)) {
    return summary("smartfarm", false, "NOT_CONFIGURED");
  }
  const adapter = createSmartfarmAdapter({
    ...common,
    enabled: true,
    serviceKey: smartfarmKey,
    contractVersion: VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  });
  const result = await adapter.getReference({
    crop: "CUCUMBER",
    cultivationMode: "FACILITY_SOIL",
    regionLabel: "경기도 수원시",
  });
  return summary(
    "smartfarm",
    true,
    result.adapterState,
    result.data?.farmCount ?? 0,
    result.qualityFlags,
  );
}

function summary(provider, configured, state, itemCount = 0, flags = []) {
  return {
    provider,
    configured,
    state,
    itemCount,
    flags: Array.isArray(flags) ? flags : [],
  };
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function providerIssueTimes(now) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1_000);
  const shortReleaseHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const availableShortHours = shortReleaseHours.filter(
    (hour) =>
      hour < kst.getUTCHours() ||
      (hour === kst.getUTCHours() && kst.getUTCMinutes() >= 10),
  );
  let shortDate = kst;
  let shortHour = availableShortHours.at(-1);
  if (shortHour === undefined) {
    shortDate = new Date(kst.getTime() - 24 * 60 * 60 * 1_000);
    shortHour = 23;
  }

  let midDate = kst;
  let midHour;
  if (
    kst.getUTCHours() > 18 ||
    (kst.getUTCHours() === 18 && kst.getUTCMinutes() >= 30)
  ) {
    midHour = 18;
  } else if (
    kst.getUTCHours() > 6 ||
    (kst.getUTCHours() === 6 && kst.getUTCMinutes() >= 30)
  ) {
    midHour = 6;
  } else {
    midDate = new Date(kst.getTime() - 24 * 60 * 60 * 1_000);
    midHour = 18;
  }

  return {
    short: {
      baseDate: compactDate(shortDate),
      baseTime: `${pad(shortHour)}00`,
    },
    mid: {
      tmFc: `${compactDate(midDate)}${pad(midHour)}00`,
    },
  };
}

function compactDate(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
