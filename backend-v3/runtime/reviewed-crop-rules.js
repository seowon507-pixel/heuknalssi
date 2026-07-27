const REVIEWED_AT = "2026-07-25";
const SOURCE_VERSION = "농사로 공개 페이지 (2026-07-25 열람)";

const SOURCES = Object.freeze({
  APPLE: Object.freeze({
    sourceTitle: "농사로 농작업일정 — 사과",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30663&menuId=PS00087&sKidofcomdtySeCode=FT",
  }),
  APPLE_HEAT_GUIDE: Object.freeze({
    sourceTitle: "농촌진흥청 고온기 농작물·가축 관리요령",
    sourceUrl:
      "https://www.rda.go.kr/middlePopOpenPopNongsaroDBView.do?no=2067",
  }),
  PEAR: Object.freeze({
    sourceTitle: "농사로 농작업일정 — 배",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30661&menuId=PS00087&sKidofcomdtySeCode=210002&totalSearchYn=Y",
  }),
  PEAR_HEAT_GUIDE: Object.freeze({
    sourceTitle: "농촌진흥청 폭염·집중호우 대비 여름철 과수원 관리",
    sourceUrl:
      "https://www.rda.go.kr/board/board.do?boardId=farmprmninfo&currPage=1&dataNo=100000811066&mode=updateCnt&prgId=day_farmprmninfoEntry",
  }),
  POTATO: Object.freeze({
    sourceTitle: "농사로 농작업일정 — 감자",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30699&menuId=PS00087&sKidofcomdtySeCode=210005&totalSearchYn=Y",
  }),
  POTATO_HEAT_GUIDE: Object.freeze({
    sourceTitle: "농사로 현장기술지원 — 노지감자 생육불량 원인규명",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=268645&menuId=PS00077",
  }),
  CUCUMBER: Object.freeze({
    sourceTitle: "농사로 농작업일정 — 오이",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30636&menuId=PS00087&sKidofcomdtySeCode=210001&totalSearchYn=Y",
  }),
  CUCUMBER_FACILITY_RISK: Object.freeze({
    sourceTitle: "농사로 현장기술지원 — 오이의 지상부와 뿌리 생육 부진",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=228637&menuId=PS00077",
  }),
  CUCUMBER_OPEN_FIELD_RISK: Object.freeze({
    sourceTitle: "농사로 현장기술지원 — 노지·시설 오이 생육 부진",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=208928&menuId=PS00077",
  }),
  LETTUCE: Object.freeze({
    sourceTitle: "농사로 농작업일정 — 상추",
    sourceUrl:
      "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30624&menuId=PS00087",
  }),
  LETTUCE_FACILITY_RISK: Object.freeze({
    sourceTitle: "농사로 현장기술지원 — 상추 여름 시설재배",
    sourceUrl:
      "https://nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=262044&menuId=PS00077",
  }),
  LETTUCE_GENERAL_RISK: Object.freeze({
    sourceTitle: "농사로 이달의 농식품 — 상추",
    sourceUrl:
      "https://www.nongsaro.go.kr/mfood/kfi/foodMonth/view?cntntsNo=206633&code=&dtlCode=2&menuId=PS03599&month=05&tabCode=1",
  }),
});

function provenance(source, sourcePageOrTable, ruleVersion) {
  return {
    ...source,
    sourcePageOrTable,
    sourceVersion: SOURCE_VERSION,
    reviewedAt: REVIEWED_AT,
    ruleVersion,
  };
}

function climateRangeRule({
  crop,
  month,
  optimalRange,
  source,
  sourcePageOrTable,
}) {
  const monthToken = String(month).padStart(2, "0");
  return {
    ruleId: `${crop.toLowerCase()}.open-field.climate.mean-temperature.m${monthToken}.v1`,
    module: "CLIMATE",
    crop,
    cultivationMode: "OPEN_FIELD",
    seasonProfileId: "CUSTOM",
    evaluationPeriod: { grain: "MONTH", month },
    stage: "ANY",
    metric: "meanTemperature",
    unit: "degC",
    use: "DEVIATION",
    evidenceStatus: "CONFIRMED_RANGE",
    optimalRange,
    toleranceRange: null,
    sensitivityTier: "CRITICAL",
    critical: true,
    ...provenance(
      source,
      `${sourcePageOrTable}; 사용자가 확인한 노지 작기 월에만 동일 생육 적온을 적용`,
      `${crop.toLowerCase()}-climate-v1`,
    ),
  };
}

function monthlyClimateRules(options) {
  return Array.from({ length: 12 }, (_, index) =>
    climateRangeRule({ ...options, month: index + 1 }),
  );
}

function soilPhRule({ crop, cultivationMode, optimalRange, source }) {
  return {
    ruleId: `${crop.toLowerCase()}.${cultivationMode
      .toLowerCase()
      .replaceAll("_", "-")}.soil.ph.v1`,
    module: "SOIL",
    crop,
    cultivationMode,
    evaluationPeriod: { grain: "SEASON_AGGREGATE", aggregation: "MEAN" },
    stage: "ANY",
    metric: "PH",
    unit: "pH",
    use: "DEVIATION",
    evidenceStatus: "CONFIRMED_RANGE",
    optimalRange,
    toleranceRange: null,
    sensitivityTier: "CRITICAL",
    critical: true,
    ...provenance(
      source,
      cultivationMode === "FACILITY_SOIL"
        ? "토양 산도 범위; 시설 토경에서는 지역 공개통계를 참고값으로만 사용"
        : "토양 산도 범위",
      `${crop.toLowerCase()}-soil-v1`,
    ),
  };
}

function forecastRiskRule({
  ruleId,
  crop,
  cultivationMode,
  stage,
  metric,
  operator,
  threshold,
  severity,
  actionId,
  source,
  sourcePageOrTable,
  ruleVersion,
  guidance,
}) {
  return {
    ruleId,
    module: "FORECAST",
    use: "FORECAST_RISK",
    crop,
    cultivationMode,
    stage,
    metric,
    unit: "℃",
    severity,
    actionId,
    evidenceStatus: "RISK_ONLY",
    comparison: { operator, threshold },
    duration: { kind: "ANY_DAY" },
    guidance: {
      ...guidance,
      recheck:
        guidance.recheck ??
        "예보가 갱신되는 날과 위험 기상이 지난 다음 날에 작물·토양 상태를 다시 확인합니다.",
      sourceTitle: guidance.source.sourceTitle,
      sourceUrl: guidance.source.sourceUrl,
      reviewedAt: REVIEWED_AT,
    },
    ...provenance(source, sourcePageOrTable, ruleVersion),
  };
}

const APPLE_RULES = [
  {
    ruleId: "apple.open-field.climate.annual-mean-temperature.v1",
    module: "CLIMATE",
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    seasonProfileId: "APPLE_OPEN_FIELD_ANNUAL",
    evaluationPeriod: { grain: "SEASON_AGGREGATE", aggregation: "MEAN" },
    stage: "ANY",
    metric: "meanTemperature",
    unit: "degC",
    use: "DEVIATION",
    evidenceStatus: "CONFIRMED_RANGE",
    optimalRange: [8, 11],
    toleranceRange: [6, 14],
    sensitivityTier: "CRITICAL",
    critical: true,
    ...provenance(
      SOURCES.APPLE,
      "기상생태 — 연평균 8~11℃, 재배 가능 6~14℃",
      "apple-climate-v1",
    ),
  },
  soilPhRule({
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    optimalRange: [5.8, 6.3],
    source: SOURCES.APPLE,
  }),
  forecastRiskRule({
    ruleId: "apple.open-field.forecast.max-temperature-gte-30.v1",
    crop: "APPLE",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 30,
    severity: "CAUTION",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.APPLE,
    sourcePageOrTable:
      "기상생태 — 30℃ 이상에서 과실비대·꽃눈형성 저해 가능",
    ruleVersion: "apple-forecast-v1",
    guidance: {
      headline: "고온 전에 과원 수분과 과실 상태 확인",
      reason:
        "최고기온이 30℃ 이상이면 사과의 과실 비대와 꽃눈 형성이 저해되고 햇볕 데임 피해가 생길 수 있습니다.",
      actions: [
        "예보 날짜 전에 과원 토양이 마르지 않았는지와 과실의 햇볕 데임 징후를 확인합니다.",
        "토양이 마르면 기존 관수시설로 적정 수분을 유지합니다.",
        "미세살수장치나 간이 차광시설이 있다면 작동 상태를 확인합니다.",
      ],
      source: SOURCES.APPLE_HEAT_GUIDE,
    },
  }),
];

const PEAR_RULES = [
  {
    ruleId: "pear.open-field.climate.growth-temperature-target.v1",
    module: "CLIMATE",
    crop: "PEAR",
    cultivationMode: "OPEN_FIELD",
    seasonProfileId: "PEAR_OPEN_FIELD_ANNUAL",
    evaluationPeriod: { grain: "SEASON_AGGREGATE", aggregation: "MEAN" },
    stage: "ANY",
    metric: "meanTemperature",
    unit: "degC",
    use: "SINGLE_TARGET",
    evidenceStatus: "SINGLE_TARGET",
    target: 20,
    sensitivityTier: "CRITICAL",
    critical: true,
    ...provenance(
      SOURCES.PEAR,
      "기상생태 — 생육 적온 약 20℃; 범위가 아니므로 단일 목표로만 표시",
      "pear-climate-v1",
    ),
  },
  soilPhRule({
    crop: "PEAR",
    cultivationMode: "OPEN_FIELD",
    optimalRange: [5.5, 6.5],
    source: SOURCES.PEAR,
  }),
  forecastRiskRule({
    ruleId: "pear.open-field.forecast.flowering-min-temperature-lte-minus-1_7.v1",
    crop: "PEAR",
    cultivationMode: "OPEN_FIELD",
    stage: "FLOWERING",
    metric: "minTemperature",
    operator: "LTE",
    threshold: -1.7,
    severity: "WARNING",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.PEAR,
    sourcePageOrTable:
      "기상생태 — 개화기 동해 한계 -1.7~-2.8℃ 중 보수적 상단값 적용",
    ruleVersion: "pear-forecast-v1",
    guidance: {
      headline: "저온 예보 전에 꽃과 방상 장비 확인",
      reason:
        "배의 개화기에 최저기온이 -1.7℃ 이하로 내려가면 꽃이 저온 피해를 입을 수 있습니다.",
      actions: [
        "예보 날짜 전에 현재 꽃이 핀 정도와 저온 피해 흔적을 확인합니다.",
        "방상팬이나 살수장치가 있다면 작동 상태를 점검합니다.",
        "장비가 없거나 피해가 보이면 지역 농업기술센터에 현장 대응을 문의합니다.",
      ],
      source: SOURCES.PEAR,
    },
  }),
  forecastRiskRule({
    ruleId: "pear.open-field.forecast.max-temperature-gte-33.v1",
    crop: "PEAR",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 33,
    severity: "CAUTION",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.PEAR_HEAT_GUIDE,
    sourcePageOrTable:
      "과수 고온 피해는 일 최고기온 33℃ 이상 폭염이 반복될 때 증가; 배의 과실비대기에는 햇볕 데임·열과 확인",
    ruleVersion: "pear-forecast-v1",
    guidance: {
      headline: "폭염 전에 배 과원의 수분과 과실 상태 확인",
      reason:
        "최고기온 33℃ 이상의 폭염이 반복되면 배 과원에서 햇볕 데임과 과실 이상 위험이 커질 수 있습니다.",
      actions: [
        "현재 과실이 커지는 시기인지 확인하고 과실 표면과 잎의 고온 피해 징후를 살펴봅니다.",
        "기존 관수시설과 차광시설이 있다면 예보 전에 작동 상태를 점검합니다.",
        "비가 함께 예보되면 급격한 토양 수분 변화와 물 고임도 확인합니다.",
      ],
      recheck:
        "폭염 예보가 갱신되는 날과 폭염·강우가 지난 다음 날에 과실과 토양 상태를 다시 확인합니다.",
      source: SOURCES.PEAR_HEAT_GUIDE,
    },
  }),
];

const POTATO_RULES = [
  ...monthlyClimateRules({
    crop: "POTATO",
    optimalRange: [14, 23],
    source: SOURCES.POTATO,
    sourcePageOrTable: "기상생태 — 생육 적온 14~23℃",
  }),
  soilPhRule({
    crop: "POTATO",
    cultivationMode: "OPEN_FIELD",
    optimalRange: [5, 6],
    source: SOURCES.POTATO,
  }),
  forecastRiskRule({
    ruleId: "potato.open-field.forecast.tuber-bulking-max-temperature-gte-27.v1",
    crop: "POTATO",
    cultivationMode: "OPEN_FIELD",
    stage: "TUBER_BULKING",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 27,
    severity: "WARNING",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.POTATO,
    sourcePageOrTable:
      "기상생태 — 27~30℃에서 괴경 비대 정지; 보수적 하단값 적용",
    ruleVersion: "potato-forecast-v1",
    guidance: {
      headline: "고온 전에 감자밭 수분과 생육 상태 확인",
      reason:
        "감자알이 굵어지는 시기에 최고기온이 27℃ 이상이면 괴경 비대가 멈출 수 있습니다.",
      actions: [
        "예보 날짜 전에 줄기와 잎의 처짐, 토양 수분 상태를 확인해 기록합니다.",
        "기존 관수·차광 설비가 있다면 정상 작동하는지 확인합니다.",
        "고온 뒤 생육 정체가 보이면 지역 농업기술센터에 현장 상태를 상담합니다.",
      ],
      source: SOURCES.POTATO,
    },
  }),
  forecastRiskRule({
    ruleId: "potato.open-field.forecast.max-temperature-gte-27-monitor.v1",
    crop: "POTATO",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 27,
    severity: "CAUTION",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.POTATO_HEAT_GUIDE,
    sourcePageOrTable:
      "노지 현장기술지원 — 큰 일교차와 최고 27.5℃ 노출 시 생리적 스트레스 확인; 생육단계·토양수분을 함께 점검",
    ruleVersion: "potato-forecast-v1",
    guidance: {
      headline: "기온 상승 전에 감자의 단계와 토양수분 확인",
      reason:
        "최고기온이 27℃ 이상으로 오르면 감자는 생육단계와 토양수분 상태에 따라 고온 스트레스를 받을 수 있습니다.",
      actions: [
        "현재 감자알이 굵어지는 시기인지와 잎·줄기의 처짐을 먼저 확인합니다.",
        "토양이 지나치게 마르거나 물이 고이지 않았는지 함께 살펴봅니다.",
        "피해가 의심되면 임의로 자재를 추가하지 말고 지역 농업기술센터에 현장 상태를 문의합니다.",
      ],
      recheck:
        "고온 예보가 지난 다음 날 아침에 잎·줄기와 토양수분 상태를 다시 확인합니다.",
      source: SOURCES.POTATO_HEAT_GUIDE,
    },
  }),
];

const CUCUMBER_RULES = [
  ...monthlyClimateRules({
    crop: "CUCUMBER",
    optimalRange: [20, 25],
    source: SOURCES.CUCUMBER,
    sourcePageOrTable: "기상생태 — 생육 적온 20~25℃",
  }),
  soilPhRule({
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    optimalRange: [5.5, 6.8],
    source: SOURCES.CUCUMBER,
  }),
  soilPhRule({
    crop: "CUCUMBER",
    cultivationMode: "FACILITY_SOIL",
    optimalRange: [5.5, 6.8],
    source: SOURCES.CUCUMBER,
  }),
  forecastRiskRule({
    ruleId: "cucumber.open-field.forecast.min-temperature-lte-7.v1",
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "minTemperature",
    operator: "LTE",
    threshold: 7,
    severity: "WARNING",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.CUCUMBER_OPEN_FIELD_RISK,
    sourcePageOrTable:
      "금후 기술지도 — 오이는 7~8℃ 이하에서 생육 정지; 보수적 하단값으로 노지 외기예보 확인",
    ruleVersion: "cucumber-open-field-forecast-v1",
    guidance: {
      headline: "저온 전에 노지 오이의 생장점과 보온 준비 확인",
      reason:
        "최저기온이 7℃ 이하로 내려가면 오이 생육이 멈출 수 있습니다.",
      actions: [
        "예보 전에 어린 잎과 생장점의 상태를 확인해 사진으로 기록합니다.",
        "이미 사용 중인 보온 피복이 있다면 바람에 들뜨거나 찢어진 곳이 없는지 점검합니다.",
        "저온 뒤 생장점 이상이 보이면 지역 농업기술센터에 현장 상태를 문의합니다.",
      ],
      recheck:
        "최저기온이 지난 다음 날 해가 뜬 뒤 생장점과 잎 상태를 다시 확인합니다.",
      source: SOURCES.CUCUMBER_OPEN_FIELD_RISK,
    },
  }),
  forecastRiskRule({
    ruleId: "cucumber.open-field.forecast.max-temperature-gte-35.v1",
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 35,
    severity: "WARNING",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.CUCUMBER_OPEN_FIELD_RISK,
    sourcePageOrTable:
      "금후 기술지도 — 오이는 35℃ 이상에서 고온장해 발생; 노지 지온·과습을 함께 확인",
    ruleVersion: "cucumber-open-field-forecast-v1",
    guidance: {
      headline: "고온 전에 노지 오이의 지온과 수분 상태 확인",
      reason:
        "최고기온이 35℃ 이상이면 오이에 고온장해가 생기고 높은 지온이나 과습이 겹치면 활착이 늦어질 수 있습니다.",
      actions: [
        "예보 전에 잎 처짐과 생장점, 토양의 건조·과습 상태를 함께 확인합니다.",
        "사용 중인 관수 설비가 있다면 막힘이나 누수가 없는지 점검합니다.",
        "고온 뒤 생육 부진이 계속되면 지역 농업기술센터에 현장 상태를 문의합니다.",
      ],
      recheck:
        "고온 당일 해가 진 뒤와 다음 날 아침에 잎·생장점과 토양수분을 다시 확인합니다.",
      source: SOURCES.CUCUMBER_OPEN_FIELD_RISK,
    },
  }),
  ...["FACILITY_SOIL", "FACILITY_HYDRO"].flatMap((cultivationMode) => [
    forecastRiskRule({
      ruleId: `cucumber.${cultivationMode
        .toLowerCase()
        .replaceAll("_", "-")}.forecast.min-temperature-lte-5.v1`,
      crop: "CUCUMBER",
      cultivationMode,
      stage: "ANY",
      metric: "minTemperature",
      operator: "LTE",
      threshold: 5,
      severity: "WARNING",
      actionId: "CHECK_FACILITY_WEATHER",
      source: SOURCES.CUCUMBER_FACILITY_RISK,
      sourcePageOrTable:
        "현장기술지원 종합의견 — 시설 내부 최저 5℃ 이하 생육 정지; 외기예보는 내부 상태 확인 신호로만 사용",
      ruleVersion: "cucumber-facility-forecast-v1",
      guidance: {
        headline: "저온 전에 시설 내부 온도와 보온 장비 확인",
        reason:
          "외기 최저기온이 5℃ 이하로 예보되면 시설 내부 온도도 내려갈 수 있으므로 생육 정지 위험을 확인해야 합니다.",
        actions: [
          "예보 날짜 전에 시설 내부 최저온도 센서값을 확인합니다.",
          "보온커튼과 난방장치가 있다면 정상 작동하는지 점검합니다.",
          "외기 예보만으로 내부 피해를 확정하지 말고 잎과 생장점 상태를 함께 확인합니다.",
        ],
        source: SOURCES.CUCUMBER_FACILITY_RISK,
      },
    }),
    forecastRiskRule({
      ruleId: `cucumber.${cultivationMode
        .toLowerCase()
        .replaceAll("_", "-")}.forecast.max-temperature-gte-35.v1`,
      crop: "CUCUMBER",
      cultivationMode,
      stage: "ANY",
      metric: "maxTemperature",
      operator: "GTE",
      threshold: 35,
      severity: "WARNING",
      actionId: "CHECK_FACILITY_WEATHER",
      source: SOURCES.CUCUMBER_FACILITY_RISK,
      sourcePageOrTable:
        "현장기술지원 종합의견 — 시설 내부 최고 35℃ 이상 생육 정지; 외기예보는 내부 상태 확인 신호로만 사용",
      ruleVersion: "cucumber-facility-forecast-v1",
      guidance: {
        headline: "고온 전에 시설 내부 온도와 환기 상태 확인",
        reason:
          "외기 최고기온이 35℃ 이상으로 예보되면 시설 내부가 더 높아져 오이 생육이 멈출 수 있습니다.",
        actions: [
          "예보 날짜 전에 시설 내부 최고온도 센서값을 확인합니다.",
          "천창·측창과 환기장치가 있다면 정상 작동하는지 점검합니다.",
          "외기 예보만으로 내부 피해를 확정하지 말고 잎과 생장점 상태를 함께 확인합니다.",
        ],
        source: SOURCES.CUCUMBER_FACILITY_RISK,
      },
    }),
  ]),
];

const LETTUCE_RULES = [
  ...monthlyClimateRules({
    crop: "LETTUCE",
    optimalRange: [15, 20],
    source: SOURCES.LETTUCE,
    sourcePageOrTable: "기상생태 — 생육 적온 15~20℃",
  }),
  soilPhRule({
    crop: "LETTUCE",
    cultivationMode: "OPEN_FIELD",
    optimalRange: [6.6, 7.2],
    source: SOURCES.LETTUCE,
  }),
  soilPhRule({
    crop: "LETTUCE",
    cultivationMode: "FACILITY_SOIL",
    optimalRange: [6.6, 7.2],
    source: SOURCES.LETTUCE,
  }),
  forecastRiskRule({
    ruleId: "lettuce.open-field.forecast.max-temperature-gte-25.v1",
    crop: "LETTUCE",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    operator: "GTE",
    threshold: 25,
    severity: "CAUTION",
    actionId: "CHECK_CURRENT_FORECAST_RISK",
    source: SOURCES.LETTUCE_GENERAL_RISK,
    sourcePageOrTable:
      "생육 적온 15~20℃, 생육 초기 외 24~26℃ 이상에서 생육 억제·병해 증가",
    ruleVersion: "lettuce-open-field-forecast-v1",
    guidance: {
      headline: "고온 전에 노지 상추의 잎과 토양수분 확인",
      reason:
        "최고기온이 25℃ 이상이면 상추의 생육이 억제되고 병해가 늘어날 수 있습니다.",
      actions: [
        "예보 전에 잎의 시듦과 꽃대가 올라오는 징후를 확인합니다.",
        "토양이 지나치게 마르거나 물이 고이지 않았는지 함께 살펴봅니다.",
        "이상 징후가 이어지면 지역 농업기술센터에 현재 생육 상태를 문의합니다.",
      ],
      recheck:
        "고온 당일 해가 진 뒤와 다음 날 아침에 잎과 토양수분 상태를 다시 확인합니다.",
      source: SOURCES.LETTUCE_GENERAL_RISK,
    },
  }),
  ...["FACILITY_SOIL", "FACILITY_HYDRO"].map((cultivationMode) =>
    forecastRiskRule({
      ruleId: `lettuce.${cultivationMode
        .toLowerCase()
        .replaceAll("_", "-")}.forecast.max-temperature-gte-25.v1`,
      crop: "LETTUCE",
      cultivationMode,
      stage: "ANY",
      metric: "maxTemperature",
      operator: "GTE",
      threshold: 25,
      severity: "CAUTION",
      actionId: "CHECK_FACILITY_WEATHER",
      source: SOURCES.LETTUCE_FACILITY_RISK,
      sourcePageOrTable:
        "상추 시설재배 — 25℃ 이상 고온에서 생육 저하 우려; 외기예보는 내부 센서 확인 신호로만 사용",
      ruleVersion: "lettuce-facility-forecast-v1",
      guidance: {
        headline: "고온 전에 시설 온도와 상추 생육 상태 확인",
        reason:
          "외기 최고기온이 25℃ 이상이면 시설 내부는 더 높아질 수 있어 상추 생육과 추대 상태를 확인해야 합니다.",
        actions: [
          "예보 전에 시설 내부 최고온도 센서값과 잎·꽃대 상태를 확인합니다.",
          "기존 환기·차광 설비가 있다면 정상 작동하는지 점검합니다.",
          "외기 예보만으로 내부 피해를 확정하지 말고 센서값과 작물 상태를 함께 기록합니다.",
        ],
        recheck:
          "고온 당일 해가 진 뒤와 다음 날 아침에 시설 센서값과 작물 상태를 다시 확인합니다.",
        source: SOURCES.LETTUCE_FACILITY_RISK,
      },
    }),
  ),
  ...["FACILITY_SOIL", "FACILITY_HYDRO"].map((cultivationMode) =>
    forecastRiskRule({
      ruleId: `lettuce.${cultivationMode
        .toLowerCase()
        .replaceAll("_", "-")}.forecast.flower-differentiation-max-temperature-gte-25.v1`,
      crop: "LETTUCE",
      cultivationMode,
      stage: "FLOWER_DIFFERENTIATION",
      metric: "maxTemperature",
      operator: "GTE",
      threshold: 25,
      severity: "CAUTION",
      actionId: "CHECK_FACILITY_WEATHER",
      source: SOURCES.LETTUCE_FACILITY_RISK,
      sourcePageOrTable:
        "현장기술지원 종합의견 — 화아분화 후 25℃ 이상에서 추대 가속; 외기예보는 내부 상태 확인 신호로만 사용",
      ruleVersion: "lettuce-facility-forecast-v1",
      guidance: {
        headline: "고온 전에 시설 온도와 추대 징후 확인",
        reason:
          "꽃눈이 생기는 시기에 25℃ 이상이 이어지면 상추의 꽃대가 빨리 올라와 상품성이 떨어질 수 있습니다.",
        actions: [
          "예보 날짜 전에 시설 내부 최고온도와 꽃대가 올라오는 징후를 확인합니다.",
          "천창·측창과 냉방·차광 설비가 있다면 정상 작동하는지 점검합니다.",
          "외기 예보만으로 내부 상태를 확정하지 말고 센서값과 작물 상태를 함께 기록합니다.",
        ],
        source: SOURCES.LETTUCE_FACILITY_RISK,
      },
    }),
  ),
];

/**
 * 흙토람 토양검정 결과지의 「토양의 화학적 성질 — 적정범위」 표.
 * 논/밭/과수/시설 네 가지 토지이용 구분으로 제공되며, 작물별 값이 아니다.
 * pH는 이미 작목별 농사로 기준으로 검수된 규칙이 있으므로 여기서 다시
 * 만들지 않는다(같은 지표를 두 번 세면 가중치가 왜곡된다).
 *
 * 표 자체가 근거이고 아래 수치는 옮겨 적은 것이다. 임의로 만든 값은 없다.
 */
const SOIL_CHEMISTRY_SOURCE = Object.freeze({
  sourceTitle: "흙토람 농업환경 변동정보 — 토양화학성 적정범위",
  sourceUrl: "https://soil.rda.go.kr/soilact/composition.do",
  sourcePageOrTable: "경작 형태별 토양화학성 적정범위 표",
  sourceVersion: "국립농업과학원 흙토람 (2026-07-27 확인)",
  reviewedAt: "2026-07-27",
});

// 표의 열 순서: 유기물 · 유효인산 · 칼륨 · 칼슘 · 마그네슘 · 전기전도도
const SOIL_CHEMISTRY_RANGES = Object.freeze({
  // 밭: 20~30 / 300~550 / 0.50~0.80 / 5.0~6.0 / 1.5~2.0 / 2 이하
  UPLAND: Object.freeze({
    ORGANIC_MATTER: [20, 30],
    AVAILABLE_PHOSPHATE: [300, 550],
    EXCHANGEABLE_K: [0.5, 0.8],
    EXCHANGEABLE_CA: [5, 6],
    EXCHANGEABLE_MG: [1.5, 2],
    EC: [0, 2],
  }),
  // 과수: 밭과 같은 범위로 표기되어 있다
  ORCHARD: Object.freeze({
    ORGANIC_MATTER: [20, 30],
    AVAILABLE_PHOSPHATE: [300, 550],
    EXCHANGEABLE_K: [0.5, 0.8],
    EXCHANGEABLE_CA: [5, 6],
    EXCHANGEABLE_MG: [1.5, 2],
    EC: [0, 2],
  }),
  // 시설: 유기물 25~35, 마그네슘 1.5~2.5로 밭과 다르다
  FACILITY: Object.freeze({
    ORGANIC_MATTER: [25, 35],
    AVAILABLE_PHOSPHATE: [300, 550],
    EXCHANGEABLE_K: [0.5, 0.8],
    EXCHANGEABLE_CA: [5, 6],
    EXCHANGEABLE_MG: [1.5, 2.5],
    EC: [0, 2],
  }),
});

const SOIL_CHEMISTRY_UNITS = Object.freeze({
  ORGANIC_MATTER: "g/kg",
  AVAILABLE_PHOSPHATE: "mg/kg",
  EXCHANGEABLE_K: "cmol+/kg",
  EXCHANGEABLE_CA: "cmol+/kg",
  EXCHANGEABLE_MG: "cmol+/kg",
  EC: "dS/m",
});

const SOIL_CHEMISTRY_SLUGS = Object.freeze({
  ORGANIC_MATTER: "organic-matter",
  AVAILABLE_PHOSPHATE: "available-phosphate",
  EXCHANGEABLE_K: "exchangeable-k",
  EXCHANGEABLE_CA: "exchangeable-ca",
  EXCHANGEABLE_MG: "exchangeable-mg",
  EC: "electrical-conductivity",
});

/**
 * 산도(pH)만 작물별로 검수된 임계값이라 CRITICAL로 둔다. 아래 양분 항목은
 * 토지이용 구분 기준이라 보조 근거로만 쓰고, 값이 없어도 판단을 막지 않는다.
 */
function soilChemistryRules(crop, cultivationMode, landUse, slugPrefix) {
  return Object.entries(SOIL_CHEMISTRY_RANGES[landUse]).map(
    ([metric, optimalRange]) => ({
      ruleId: `${slugPrefix}.soil.${SOIL_CHEMISTRY_SLUGS[metric]}.v1`,
      module: "SOIL",
      crop,
      cultivationMode,
      evaluationPeriod: { grain: "SEASON_AGGREGATE", aggregation: "MEAN" },
      stage: "ANY",
      metric,
      unit: SOIL_CHEMISTRY_UNITS[metric],
      use: "DEVIATION",
      evidenceStatus: "CONFIRMED_RANGE",
      optimalRange: [...optimalRange],
      toleranceRange: null,
      sensitivityTier: "SUPPORTING",
      critical: false,
      ...SOIL_CHEMISTRY_SOURCE,
      ruleVersion: `${slugPrefix}-soil-chemistry-v1`,
    }),
  );
}

const SOIL_CHEMISTRY_RULES = Object.freeze([
  ...soilChemistryRules("APPLE", "OPEN_FIELD", "ORCHARD", "apple.open-field"),
  ...soilChemistryRules("PEAR", "OPEN_FIELD", "ORCHARD", "pear.open-field"),
  ...soilChemistryRules("POTATO", "OPEN_FIELD", "UPLAND", "potato.open-field"),
  ...soilChemistryRules("CUCUMBER", "OPEN_FIELD", "UPLAND", "cucumber.open-field"),
  ...soilChemistryRules(
    "CUCUMBER",
    "FACILITY_SOIL",
    "FACILITY",
    "cucumber.facility-soil",
  ),
  ...soilChemistryRules("LETTUCE", "OPEN_FIELD", "UPLAND", "lettuce.open-field"),
  ...soilChemistryRules(
    "LETTUCE",
    "FACILITY_SOIL",
    "FACILITY",
    "lettuce.facility-soil",
  ),
]);

export const REVIEWED_CROP_RULES = Object.freeze([
  ...APPLE_RULES,
  ...PEAR_RULES,
  ...POTATO_RULES,
  ...CUCUMBER_RULES,
  ...LETTUCE_RULES,
  ...SOIL_CHEMISTRY_RULES,
]);
