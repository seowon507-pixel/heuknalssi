import { domainAssert } from "./errors.js";

/**
 * 대시보드 원형 장면의 상태를 만든다. 명세 28번의 4·5·10절 계약이다.
 *
 * 이 파일이 지키는 선:
 *
 * - **식물의 모양은 생육단계만 반영한다.** 날씨는 주변 레이어와 움직임에만
 *   들어간다. 고온 예보로 잎을 시들게 하거나, 표정을 붙이거나, 병반을
 *   그리지 않는다. 그런 표현은 사용자가 직접 고른 관찰이 있을 때만
 *   `observedPlantState` 로 들어온다.
 * - **프론트가 온도·비를 다시 판정하지 않는다.** 장면은 백엔드가 이미
 *   검증한 예보 위험과 예보값에서만 나온다. 위험의 metric 을 장면으로
 *   못 옮기면 조용히 추측하지 않고 `unmappedMetrics` 로 드러낸다.
 * - **한 장면에 주요 원인 1개, 보조 환경 1개까지.** 전부 재생하지 않는다.
 * - 자료가 없으면 맑음으로 위장하지 않고 `NEUTRAL` 배경을 쓴다.
 */

export const ENVIRONMENT_SCENE_RULE_VERSION = "environment-scene-v2";

/** 명세 4.2 의 내부 상태. 화면 문구는 서버가 함께 내려준다. */
export const EnvironmentState = Object.freeze([
  "TYPHOON",
  "SNOW_COLD",
  "HEAVY_RAIN",
  "DROUGHT",
  "HIGH_HEAT",
  "WIND",
  "RAIN",
  "CLOUDY",
  "CLEAR",
]);

/** 명세 4.3. 시각 장면 선택용 순서이며 농업 점수의 가중치가 아니다. */
const SCENE_PRIORITY = Object.freeze([
  "TYPHOON",
  "SNOW_COLD",
  "HEAVY_RAIN",
  "DROUGHT",
  "HIGH_HEAT",
  "WIND",
  "RAIN",
  "CLOUDY",
  "CLEAR",
]);

const SCENE_DEFINITIONS = Object.freeze({
  TYPHOON: scene({
    labelKo: "위험 · 태풍",
    background: "STORM",
    ground: "WET",
    effects: ["RAIN_HEAVY", "WIND_STRONG", "WARNING_RING"],
    plantMotion: "LEAN_ONE_WAY",
    motionSeconds: 2,
    particles: 40,
  }),
  SNOW_COLD: scene({
    labelKo: "주의 · 저온",
    background: "COLD",
    ground: "NORMAL",
    effects: ["SNOW", "FROST_EDGE"],
    plantMotion: "BREATHE",
    motionSeconds: 6,
    particles: 30,
  }),
  HEAVY_RAIN: scene({
    labelKo: "주의 · 강수",
    background: "CLOUDY",
    ground: "WET",
    effects: ["RAIN_HEAVY", "PUDDLE"],
    plantMotion: "SWAY",
    motionSeconds: 3,
    particles: 36,
  }),
  DROUGHT: scene({
    labelKo: "주의 · 건조",
    background: "CLEAR",
    ground: "DRY",
    effects: ["DRY_TEXTURE"],
    plantMotion: "BREATHE",
    motionSeconds: 8,
    particles: 0,
  }),
  HIGH_HEAT: scene({
    labelKo: "주의 · 고온",
    background: "CLEAR",
    ground: "NORMAL",
    effects: ["HEAT_SHIMMER", "WARM_LIGHT"],
    plantMotion: "BREATHE",
    motionSeconds: 5,
    particles: 8,
  }),
  WIND: scene({
    labelKo: "주의 · 바람",
    background: "CLOUDY",
    ground: "NORMAL",
    effects: ["WIND_LINES"],
    plantMotion: "LEAN_ONE_WAY",
    motionSeconds: 3,
    particles: 12,
  }),
  RAIN: scene({
    labelKo: "비",
    background: "CLOUDY",
    ground: "WET",
    effects: ["RAIN_LIGHT", "DROPLET"],
    plantMotion: "SWAY",
    motionSeconds: 4,
    particles: 20,
  }),
  CLOUDY: scene({
    labelKo: "흐림",
    background: "CLOUDY",
    ground: "NORMAL",
    effects: [],
    plantMotion: "BREATHE",
    motionSeconds: 7,
    particles: 0,
  }),
  CLEAR: scene({
    labelKo: "맑음",
    background: "CLEAR",
    ground: "NORMAL",
    effects: ["SOFT_LIGHT"],
    plantMotion: "BREATHE",
    motionSeconds: 7,
    particles: 4,
  }),
  NEUTRAL: scene({
    labelKo: "환경 정보 없음",
    background: "NEUTRAL",
    ground: "NORMAL",
    effects: [],
    plantMotion: "STILL",
    motionSeconds: 0,
    particles: 0,
  }),
});

function scene(definition) {
  return Object.freeze({ ...definition, effects: Object.freeze([...definition.effects]) });
}

/**
 * 검증된 예보 위험의 metric 을 장면 후보로 옮기는 표. 규칙 저장소가 쓰는
 * metric 이름이 늘어나면 여기에 추가한다. 표에 없으면 추측하지 않는다.
 */
export const DEFAULT_METRIC_SCENE_MAP = Object.freeze({
  // 규칙 저장소가 실제로 허용하는 예보 metric 다섯 개. `src/rules/registry.js`
  // 의 `FORECAST_METRICS` 와 같은 이름을 쓴다. 이 다섯 개가 실제 위험에서
  // 들어오는 값이고, 아래 대문자 키들은 다른 명명을 쓰는 규칙본을 위한 별칭이다.
  minTemperature: "SNOW_COLD",
  maxTemperature: "HIGH_HEAT",
  meanTemperature: "HIGH_HEAT",
  precipitationAmount: "HEAVY_RAIN",
  precipitationProbability: "RAIN",
  windSpeed: "WIND",
  PRECIPITATION: "HEAVY_RAIN",
  PRECIPITATION_AMOUNT: "HEAVY_RAIN",
  PRECIPITATION_PROBABILITY: "RAIN",
  RAINFALL: "HEAVY_RAIN",
  SNOWFALL: "SNOW_COLD",
  MIN_TEMPERATURE: "SNOW_COLD",
  MINIMUM_TEMPERATURE: "SNOW_COLD",
  MAX_TEMPERATURE: "HIGH_HEAT",
  MAXIMUM_TEMPERATURE: "HIGH_HEAT",
  MEAN_TEMPERATURE: "HIGH_HEAT",
  WIND_SPEED: "WIND",
  MAX_WIND_SPEED: "WIND",
  GUST_SPEED: "WIND",
  HUMIDITY: "RAIN",
  CONSECUTIVE_DRY_DAYS: "DROUGHT",
  DRY_DAYS: "DROUGHT",
  SOIL_MOISTURE: "DROUGHT",
});

/** 명세 3절의 공통 5단계. 그림 파일명은 작물+단계로만 만든다. */
export const GROWTH_STAGE_LABELS = Object.freeze([
  Object.freeze({ stage: 1, labelKo: "시작을 준비하는 중" }),
  Object.freeze({ stage: 2, labelKo: "새롭게 돋아나는 중" }),
  Object.freeze({ stage: 3, labelKo: "잎과 줄기가 자라는 중" }),
  Object.freeze({ stage: 4, labelKo: "수확을 만들어가는 중" }),
  Object.freeze({ stage: 5, labelKo: "수확을 준비하는 중" }),
]);

export const StageSource = Object.freeze([
  "USER_CONFIRMED",
  "USER_SELECTED_WITH_PHOTO",
  "ESTIMATED_FROM_SCHEDULE",
  "UNKNOWN",
]);

const SUPPORTED_CROPS = Object.freeze(["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"]);

/**
 * @param {object} input
 * @param {string} input.cropId
 * @param {object} input.stage            { stage: 1..5|null, source: StageSource }
 * @param {Array}  [input.forecastRisks]  evaluateForecastRisks 의 위험 목록
 * @param {object} [input.todayForecast]  검증된 오늘 예보값 (선택)
 * @param {string} [input.riskState]      백엔드 위험 상태. 문구는 이것을 쓴다
 * @param {object} [input.primaryCause]   백엔드가 고른 주요 원인
 * @param {object} [input.primaryAction]  백엔드가 고른 주요 행동
 * @param {object} [input.observedPlantState] 사용자가 고른 관찰 (있을 때만 식물 표현에 반영)
 * @param {object} [input.rendering]      { reducedMotion, lowPower, dataSaver }
 * @param {object} [input.metricSceneMap] 매핑 표 교체용
 */
export function buildEnvironmentScene(input = {}) {
  const {
    cropId,
    stage = { stage: null, source: "UNKNOWN" },
    forecastRisks = [],
    todayForecast = null,
    riskState = null,
    primaryCause = null,
    primaryAction = null,
    observedPlantState = null,
    rendering = {},
    metricSceneMap = DEFAULT_METRIC_SCENE_MAP,
  } = input;

  const crop = String(cropId ?? "").trim().toUpperCase();
  domainAssert(
    SUPPORTED_CROPS.includes(crop),
    "SCENE_CROP_INVALID",
    "cropId must be one of the five supported crops",
    { cropId },
  );
  domainAssert(Array.isArray(forecastRisks), "SCENE_RISKS_INVALID", "forecastRisks must be an array", {});

  const resolvedStage = resolveStage(stage);
  const candidates = [];
  const unmappedMetrics = [];

  for (const risk of forecastRisks) {
    const metric = risk?.trigger?.metric;
    if (typeof metric !== "string") continue;
    const mapped = metricSceneMap[metric];
    if (mapped === undefined) {
      unmappedMetrics.push(metric);
      continue;
    }
    candidates.push({
      state: downgradeIfMild(mapped, risk.severity),
      severity: risk.severity ?? "CAUTION",
      riskId: risk.riskId ?? null,
      metric,
    });
  }

  // 태풍은 단일 규칙이 아니라 강풍과 강한 비가 함께 경고일 때만 쓴다.
  if (hasWarning(candidates, "WIND") && hasWarning(candidates, "HEAVY_RAIN")) {
    candidates.unshift({ state: "TYPHOON", severity: "WARNING", riskId: null, metric: "WIND+RAIN" });
  }

  const baseline = baselineFromForecast(todayForecast);
  if (baseline !== null) {
    candidates.push({ state: baseline, severity: "INFO", riskId: null, metric: "BASELINE" });
  }

  const known = candidates.length > 0;
  const ordered = [...candidates].sort(
    (left, right) => SCENE_PRIORITY.indexOf(left.state) - SCENE_PRIORITY.indexOf(right.state),
  );
  const primary = ordered[0] ?? null;
  const secondary = ordered.find((row) => row.state !== primary?.state) ?? null;

  const selectedState = primary?.state ?? "NEUTRAL";
  const definition = SCENE_DEFINITIONS[selectedState];
  const quality = resolveQuality(rendering);

  return Object.freeze({
    ruleVersion: ENVIRONMENT_SCENE_RULE_VERSION,
    cropId: crop,
    // 그림은 작물과 단계만으로 결정된다. 날씨가 끼어들 자리가 없다.
    plantAsset: resolvedStage.stage === null
      ? null
      : `plant-${crop.toLowerCase()}-stage-${resolvedStage.stage}`,
    stage: resolvedStage,
    environment: Object.freeze({
      state: selectedState,
      known,
      labelKo: definition.labelKo,
      background: definition.background,
      ground: definition.ground,
      effects: quality === "STATIC" ? Object.freeze([]) : definition.effects,
      secondaryState: secondary?.state ?? null,
      // 예보에서 나온 장면은 화면에 예상임을 표시해야 한다.
      projected: primary?.metric === "BASELINE" || primary?.severity !== undefined,
      sourceRiskId: primary?.riskId ?? null,
    }),
    motion: Object.freeze({
      plant: quality === "STATIC" ? "STILL" : definition.plantMotion,
      seconds: quality === "STATIC" ? 0 : definition.motionSeconds,
      particles: particleBudget(definition.particles, quality),
      quality,
    }),
    /**
     * 문구는 전부 백엔드 판정을 그대로 쓴다. 장면이 자체 판정을 내리지
     * 않으므로 큰 상태 문구와 원형 장면이 어긋날 수 없다.
     */
    labels: Object.freeze({
      statusKo: riskState ?? null,
      causeKo: primaryCause?.summaryKo ?? primaryCause?.titleKo ?? null,
      actionKo: primaryAction?.titleKo ?? null,
    }),
    /**
     * 잎 처짐·변색은 여기에만 들어온다. 사용자가 고른 관찰이 없으면 비어
     * 있고, 그때 식물은 건강하게도 아프게도 그리지 않는다.
     */
    observedPlantState: observedPlantState === null
      ? null
      : Object.freeze({ ...observedPlantState }),
    /** 매핑되지 않은 metric. 조용히 넘기지 않고 드러내서 표를 채우게 한다. */
    unmappedMetrics: Object.freeze([...new Set(unmappedMetrics)]),
  });
}

/** 명세 3절의 단계 결정 우선순위. */
export function resolveStage(stage = {}) {
  const value = Number.isFinite(stage.stage) ? Math.trunc(stage.stage) : null;
  const source = StageSource.includes(stage.source) ? stage.source : "UNKNOWN";
  if (value === null || value < 1 || value > 5) {
    return Object.freeze({
      stage: null,
      source: "UNKNOWN",
      labelKo: null,
      estimated: false,
      needsSetup: true,
    });
  }
  return Object.freeze({
    stage: value,
    source,
    labelKo: GROWTH_STAGE_LABELS[value - 1].labelKo,
    // 날짜로 계산한 단계에는 반드시 예상 표시를 붙인다.
    estimated: source === "ESTIMATED_FROM_SCHEDULE",
    needsSetup: source === "UNKNOWN",
  });
}

/** 비는 항상 주의가 아니다. 경고가 아니면 한 단계 낮춘다. */
function downgradeIfMild(state, severity) {
  if (state === "HEAVY_RAIN" && severity !== "WARNING") return "RAIN";
  if (state === "SNOW_COLD" && severity !== "WARNING") return "SNOW_COLD";
  return state;
}

function hasWarning(candidates, state) {
  return candidates.some((row) => row.state === state && row.severity === "WARNING");
}

/**
 * 위험이 없을 때의 바탕 장면. 검증된 예보값만 읽고, 값이 없으면 null 을
 * 돌려 장면을 NEUTRAL 로 남긴다.
 */
function baselineFromForecast(day) {
  if (day === null || typeof day !== "object") return null;
  const rain = firstFinite(day.PRECIPITATION, day.precipitationAmount, day.precipitation);
  if (Number.isFinite(rain) && rain > 0) return "RAIN";
  const sky = typeof day.sky === "string" ? day.sky.toUpperCase() : null;
  if (sky === "CLOUDY" || sky === "OVERCAST") return "CLOUDY";
  if (sky === "CLEAR" || sky === "SUNNY") return "CLEAR";
  const cloud = firstFinite(day.cloudCover, day.CLOUD_COVER);
  if (Number.isFinite(cloud)) return cloud >= 60 ? "CLOUDY" : "CLEAR";
  if (Number.isFinite(rain)) return "CLEAR";
  return null;
}

function resolveQuality(rendering) {
  if (rendering?.reducedMotion === true) return "STATIC";
  if (rendering?.dataSaver === true || rendering?.lowPower === true) return "LITE";
  return "FULL";
}

function particleBudget(base, quality) {
  if (quality === "STATIC") return 0;
  if (quality === "LITE") return Math.floor(base / 2);
  return base;
}

function firstFinite(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export { SCENE_DEFINITIONS, SCENE_PRIORITY, SUPPORTED_CROPS };
