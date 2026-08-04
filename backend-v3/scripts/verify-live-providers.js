import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SOIL_V2_CONTRACT,
  createKakaoAdapter,
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter,
  createKmaMidForecastAdapter,
  createKmaShortForecastAdapter,
  createSoilExamAdapter,
  createSoilFieldAdapter,
  createSoilV2Adapter,
} from "../src/adapters/index.js";

const publicDataKey = process.env.DATA_GO_KR_SERVICE_KEY;
const kmaApiHubKey = process.env.KMA_API_HUB_AUTH_KEY;
const kakaoKey = process.env.KAKAO_REST_API_KEY;
const SAMPLE_PNU = "4611010100101830025";
const issues = providerIssueTimes(new Date());
// 운영 분석과 같은 공급자 제한을 사용해 7초와 10초 사이의 정상 응답을
// 진단 실패로 잘못 분류하지 않는다.
const common = { timeoutMs: 10_000 };

const probes = await Promise.all([
  probeKakao(),
  probeKmaClimateNormal(),
  probeKmaAsos(),
  probeKmaAsosSeasonRange(),
  probeSoil(),
  probeSoilExam(),
  probeSoilField(),
  probeKmaShort(),
  probeKmaMid(),
]);

console.log(JSON.stringify({ probes }, null, 2));

if (
  probes.some(
    ({ configured, state }) =>
      configured &&
      ["AUTH_ERROR", "SCHEMA_CHANGED", "INTERNAL_ERROR", "TIMEOUT"].includes(
        state,
      ),
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

async function probeKmaClimateNormal() {
  const adapter = createKmaClimateNormalAdapter({
    ...common,
    enabled: true,
    apiKey: kmaApiHubKey,
    contractVersion: VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  });
  const result = await adapter.getNormals({ stationId: "136" });
  return summary(
    "kmaClimateNormal",
    hasValue(kmaApiHubKey),
    result.adapterState,
    result.data?.observations?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeSoilExam() {
  if (!hasValue(publicDataKey)) {
    return summary("soilExamV2", false, "NOT_CONFIGURED");
  }
  const adapter = createSoilExamAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
  });
  const result = await adapter.getLatestExam({ pnuCode: SAMPLE_PNU });
  return summary(
    "soilExamV2",
    true,
    result.adapterState,
    result.data?.metrics?.length ?? 0,
    result.qualityFlags,
  );
}

async function probeSoilField() {
  if (!hasValue(publicDataKey)) {
    return summary("soilFieldV3", false, "NOT_CONFIGURED");
  }
  const adapter = createSoilFieldAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  });
  const result = await adapter.getFieldProfile({ pnuCode: SAMPLE_PNU });
  return summary(
    "soilFieldV3",
    true,
    result.adapterState,
    result.data?.parcelMatched === true ? 1 : 0,
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

async function probeKmaAsosSeasonRange() {
  if (!hasValue(publicDataKey)) {
    return summary("kmaAsosSeasonRange", false, "NOT_CONFIGURED");
  }
  const adapter = createKmaAsosObservationAdapter({
    ...common,
    enabled: true,
    apiKey: publicDataKey,
    contractVersion: VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  });
  const yesterday = seoulDateOffset(-1);
  const result = await adapter.getDailyRange({
    stationId: "136",
    from: seoulDateOffset(-30),
    to: yesterday,
  });
  return summary(
    "kmaAsosSeasonRange",
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

function seoulDateOffset(offsetDays) {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toISOString().slice(0, 10);
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
