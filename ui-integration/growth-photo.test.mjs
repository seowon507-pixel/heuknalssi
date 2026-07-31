import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhotoSnapshot,
  excessGreen,
  measureGreenCover,
  summarizeSeason,
} from "./growth-photo.mjs";

const NOW = Date.parse("2026-07-31T00:00:00.000Z");

/** width×height 픽셀을 만든다. colors는 [r,g,b,a] 배열의 목록. */
function imageData(colors, width = colors.length, height = 1) {
  const data = new Uint8ClampedArray(width * height * 4);
  colors.forEach((color, index) => {
    data.set(color, index * 4);
  });
  return { data, width, height };
}

test("ExG는 밝기를 나눠 없애 그늘과 햇빛을 같게 본다", () => {
  const bright = excessGreen({ red: 100, green: 200, blue: 100 });
  const shaded = excessGreen({ red: 50, green: 100, blue: 50 });
  assert.equal(bright, shaded);
  assert.ok(bright > 0);
});

test("초록이 아닌 색은 0 이하가 된다", () => {
  assert.ok(excessGreen({ red: 200, green: 100, blue: 100 }) < 0);
  assert.ok(excessGreen({ red: 120, green: 120, blue: 120 }) <= 0);
  assert.equal(excessGreen({ red: 0, green: 0, blue: 0 }), 0);
});

test("초록 픽셀 비율을 센다", () => {
  const green = [40, 200, 40, 255];
  const soil = [150, 110, 80, 255];
  const result = measureGreenCover(imageData([green, green, soil, soil]));
  assert.equal(result.ratio, 0.5);
  assert.equal(result.sampledPixels, 4);
});

test("투명 픽셀은 분모에서 뺀다", () => {
  const green = [40, 200, 40, 255];
  const clear = [0, 0, 0, 0];
  const result = measureGreenCover(imageData([green, clear, clear, clear]));
  assert.equal(result.sampledPixels, 1);
  assert.equal(result.ratio, 1);
});

test("셀 픽셀이 없으면 0으로 꾸미지 않고 null을 준다", () => {
  const result = measureGreenCover(imageData([[0, 0, 0, 0]]));
  assert.equal(result.ratio, null);
  assert.equal(result.sampledPixels, 0);
});

test("스냅샷은 자료에서 온 값과 사진에서 센 값을 나눠 적는다", () => {
  const snapshot = buildPhotoSnapshot({
    analysis: {
      inputSummary: { crop: "LETTUCE", regionLabel: "서울 강동구" },
      suitability: { scored: true, score: 37, grade: "부적합" },
      forecast: { result: { risks: [{}, {}] } },
    },
    greenCover: { ratio: 0.42, threshold: 0.05, sampledPixels: 1000 },
    now: NOW,
    completedToday: 2,
  });

  assert.equal(snapshot.takenOn, "2026-07-31");
  assert.equal(snapshot.suitabilityScore, 37);
  assert.equal(snapshot.riskCount, 2);
  assert.equal(snapshot.completedTaskCount, 2);
  assert.equal(snapshot.greenCover, 0.42);
  // 산식과 한계를 값과 함께 싣는다.
  assert.match(snapshot.greenCoverMethod.index, /2G − R − B/u);
  assert.match(snapshot.greenCoverMethod.note, /생육량이나 수확량이 아닙니다/u);
});

test("점수를 못 낸 분석은 사진 기록에서도 null로 남는다", () => {
  const snapshot = buildPhotoSnapshot({
    analysis: { suitability: { scored: false, score: null } },
    now: NOW,
  });
  assert.equal(snapshot.suitabilityScore, null);
  assert.equal(snapshot.greenCover, null);
  assert.equal(snapshot.greenCoverMethod, null);
});

test("기록이 없으면 시즌 정리를 비워 둔다", () => {
  const season = summarizeSeason([]);
  assert.equal(season.state, "EMPTY");
  assert.equal(season.photoCount, 0);
  assert.equal(season.suitability, null);
});

test("한 장뿐이면 비교하지 않고 그 사실을 남긴다", () => {
  const season = summarizeSeason([
    { takenOn: "2026-07-01", suitabilityScore: 70, greenCover: 0.3 },
  ]);
  assert.equal(season.state, "SINGLE_RECORD");
  assert.equal(season.suitability.delta, null);
  assert.equal(season.greenCover.delta, null);
});

test("시즌 정리는 변화량을 그대로 보여 주고 원인은 쓰지 않는다", () => {
  const season = summarizeSeason(
    [
      { takenOn: "2026-05-01", suitabilityScore: 80, greenCover: 0.2, riskCount: 1 },
      { takenOn: "2026-06-01", suitabilityScore: 65, greenCover: 0.5, riskCount: 3 },
      { takenOn: "2026-07-01", suitabilityScore: 55, greenCover: 0.62, riskCount: 2 },
    ],
    { completions: [{}, {}, {}, {}] },
  );

  assert.equal(season.state, "READY");
  assert.equal(season.photoCount, 3);
  assert.equal(season.dayCount, 3);
  assert.equal(season.firstOn, "2026-05-01");
  assert.equal(season.lastOn, "2026-07-01");
  assert.equal(season.completedTaskCount, 4);
  assert.equal(season.totalRiskEvents, 6);
  assert.equal(season.suitability.delta, -25);
  assert.equal(season.suitability.min, 55);
  assert.equal(season.suitability.max, 80);
  assert.equal(season.greenCover.delta, 0.42);

  // 판단 문구를 만들지 않는다. 숫자와 표본 수만 돌려준다.
  assert.equal("verdict" in season, false);
  assert.equal("diagnosis" in season, false);
  assert.equal(JSON.stringify(season).includes("악화"), false);
});

test("점수가 없는 사진은 변화 계산에서 빼되 장수는 센다", () => {
  const season = summarizeSeason([
    { takenOn: "2026-05-01", suitabilityScore: 80, greenCover: null },
    { takenOn: "2026-06-01", suitabilityScore: null, greenCover: 0.4 },
    { takenOn: "2026-07-01", suitabilityScore: 60, greenCover: 0.5 },
  ]);
  assert.equal(season.photoCount, 3);
  assert.equal(season.suitability.sampleCount, 2);
  assert.equal(season.suitability.delta, -20);
  assert.equal(season.greenCover.sampleCount, 2);
});
