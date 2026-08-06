import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAnalysisScene,
  projectRequestStage,
  selectTodayForecastDay,
} from "../src/application/analysis-scene.js";
import { DEFAULT_METRIC_SCENE_MAP } from "../src/domain/index.js";

const TODAY = "2026-08-04";
const NOW = "2026-08-04T09:15:00.000Z";

function request(overrides = {}) {
  return { crop: "CUCUMBER", growthStage: "UNSPECIFIED", ...overrides };
}

function forecast({ risks = [], days = [] } = {}) {
  return { state: "READY", result: { risks, days, riskState: "READY" } };
}

function risk(metric, severity = "WARNING") {
  return {
    riskId: `${metric}-rule:1`,
    severity,
    trigger: { metric, unit: "mm", readings: [{ date: TODAY, value: 40 }] },
  };
}

/**
 * 이 파일이 지키려는 것은 "장면이 백엔드 판정을 그대로 옮기는가"와
 * "장면이 실패해도 분석이 사는가" 두 가지다.
 */

test("규칙 저장소가 실제로 쓰는 예보 metric 다섯 개가 모두 장면으로 매핑된다", () => {
  // src/rules/registry.js 의 FORECAST_METRICS 와 같은 목록이어야 한다.
  // 하나라도 빠지면 실제 위험이 unmappedMetrics 로 조용히 새어나간다.
  for (const metric of [
    "minTemperature",
    "maxTemperature",
    "precipitationProbability",
    "precipitationAmount",
    "windSpeed",
  ]) {
    assert.ok(
      DEFAULT_METRIC_SCENE_MAP[metric] !== undefined,
      `${metric} 이 장면 매핑 표에 없습니다`,
    );
  }
});

test("실제 규칙 metric 으로 온 위험은 unmappedMetrics 없이 장면이 된다", () => {
  const scene = projectAnalysisScene({
    request: request(),
    forecast: forecast({ risks: [risk("precipitationAmount")] }),
    riskState: "WARNING",
    todayIso: NOW,
  });
  assert.equal(scene.environment.state, "HEAVY_RAIN");
  assert.deepEqual(scene.unmappedMetrics, []);
});

test("강풍과 강한 비가 함께 경고일 때만 태풍으로 올라간다", () => {
  const both = projectAnalysisScene({
    request: request(),
    forecast: forecast({
      risks: [risk("windSpeed"), risk("precipitationAmount")],
    }),
    riskState: "WARNING",
    todayIso: NOW,
  });
  assert.equal(both.environment.state, "TYPHOON");

  const windOnly = projectAnalysisScene({
    request: request(),
    forecast: forecast({ risks: [risk("windSpeed")] }),
    riskState: "WARNING",
    todayIso: NOW,
  });
  assert.equal(windOnly.environment.state, "WIND");
});

test("경고가 아닌 강수는 주의로 올리지 않는다", () => {
  const scene = projectAnalysisScene({
    request: request(),
    forecast: forecast({ risks: [risk("precipitationAmount", "INFO")] }),
    riskState: "READY",
    todayIso: NOW,
  });
  assert.equal(scene.environment.state, "RAIN");
});

test("예보가 비어 있으면 맑음으로 위장하지 않고 중립 장면을 쓴다", () => {
  const scene = projectAnalysisScene({
    request: request(),
    forecast: forecast(),
    riskState: "HOLD",
    todayIso: NOW,
  });
  assert.equal(scene.environment.state, "NEUTRAL");
  assert.equal(scene.environment.known, false);
  assert.deepEqual(scene.environment.effects, []);
});

test("오늘 날짜 예보만 바탕 장면으로 쓰고 다른 날짜로 대체하지 않는다", () => {
  const tomorrow = {
    date: "2026-08-05",
    sourceType: "SHORT_GRID",
    precipitationAmount: 12,
  };
  assert.equal(selectTodayForecastDay(forecast({ days: [tomorrow] }), NOW), null);

  const today = { ...tomorrow, date: TODAY };
  assert.equal(
    selectTodayForecastDay(forecast({ days: [today] }), NOW),
    today,
  );
});

test("위험이 없고 오늘 강수가 0이면 바탕 장면은 맑음이다", () => {
  const scene = projectAnalysisScene({
    request: request(),
    forecast: forecast({
      days: [{ date: TODAY, sourceType: "SHORT_GRID", precipitationAmount: 0 }],
    }),
    riskState: "READY",
    todayIso: NOW,
  });
  assert.equal(scene.environment.state, "CLEAR");
});

test("문구는 백엔드 판정을 그대로 옮긴다", () => {
  const scene = projectAnalysisScene({
    request: request(),
    forecast: forecast({ risks: [risk("maxTemperature")] }),
    riskState: "WARNING",
    decision: { message: "고온 예보가 있어 오후 관수 시점을 확인하세요." },
    primaryAction: { actionId: "CHECK_IRRIGATION", title: "관수 상태 확인" },
    todayIso: NOW,
  });
  assert.equal(scene.labels.statusKo, "WARNING");
  assert.equal(
    scene.labels.causeKo,
    "고온 예보가 있어 오후 관수 시점을 확인하세요.",
  );
  assert.equal(scene.labels.actionKo, "관수 상태 확인");
});

test("검수된 생육단계만 단계 번호가 되고 나머지는 단계 설정으로 남는다", () => {
  assert.deepEqual(projectRequestStage("FLOWERING"), {
    stage: 4,
    source: "USER_CONFIRMED",
  });
  assert.deepEqual(projectRequestStage("UNSPECIFIED"), {
    stage: null,
    source: "UNKNOWN",
  });
  assert.deepEqual(projectRequestStage(undefined), {
    stage: null,
    source: "UNKNOWN",
  });

  const scene = projectAnalysisScene({
    request: request({ growthStage: "UNSPECIFIED" }),
    forecast: forecast(),
    riskState: "HOLD",
    todayIso: NOW,
  });
  assert.equal(scene.plantAsset, null);
  assert.equal(scene.stage.needsSetup, true);
});

test("식물 그림은 날씨가 아니라 단계만 따른다", () => {
  const scenes = ["precipitationAmount", "maxTemperature", "windSpeed"].map(
    (metric) =>
      projectAnalysisScene({
        request: request({ crop: "POTATO", growthStage: "TUBER_BULKING" }),
        forecast: forecast({ risks: [risk(metric)] }),
        riskState: "WARNING",
        todayIso: NOW,
      }),
  );
  const assets = new Set(scenes.map((scene) => scene.plantAsset));
  assert.deepEqual([...assets], ["plant-potato-stage-4"]);
});

test("장면 생성이 실패해도 분석을 멈추지 않고 UNAVAILABLE 로 남는다", () => {
  const scene = projectAnalysisScene({
    // 지원하지 않는 작물이면 도메인이 예외를 던진다.
    request: request({ crop: "MANGO" }),
    forecast: forecast(),
    riskState: "HOLD",
    todayIso: NOW,
  });
  assert.equal(scene.state, "UNAVAILABLE");
  assert.equal(scene.reason, "SCENE_CROP_INVALID");
});
