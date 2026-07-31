import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const client = await readFile(
  new URL("./backend-client.mjs", import.meta.url),
  "utf8",
);
const accuracy = JSON.parse(
  await readFile(new URL("./forecast-accuracy.json", import.meta.url), "utf8"),
);

test("배지는 정적 산출물을 읽고 화면에서 다시 계산하지 않는다", () => {
  assert.match(client, /forecast-accuracy\.json/);
  assert.match(client, /function forecastAccuracyBadgeText/);
  assert.match(client, /function renderForecastAccuracyBadge/);
  // 화면에서 MAE·RMSE를 직접 계산하지 않는다.
  assert.doesNotMatch(client, /meanAbsoluteError\s*=\s*\(/);
  assert.doesNotMatch(client, /rootMeanSquaredError\s*=\s*\(/);
});

test("표본이 최소 기준 미만이면 확정된 정확도처럼 쓰지 않는다", () => {
  assert.match(client, /정확도 검증 중/);
  assert.match(client, /data\.state === "READY"/);
  // 표본 수를 항상 함께 보여 준다.
  assert.match(client, /\$\{pairs\}쌍/);
});

test("정확도 산출물이 계약대로 생겼다", () => {
  assert.ok(["COLLECTING", "PARTIAL", "READY"].includes(accuracy.state));
  assert.equal(typeof accuracy.minimumReportableSamples, "number");
  assert.equal(typeof accuracy.coverage.pairCount, "number");
  assert.equal(typeof accuracy.coverage.stationCount, "number");
  assert.ok(accuracy.source.forecast.includes("기상청"));
  assert.ok(accuracy.source.observation.includes("ASOS"));
  assert.match(accuracy.source.note, /보간하지 않는다/);
  assert.ok(Array.isArray(accuracy.leadTimes));
});

test("리드타임을 섞지 않고 나눠서 싣는다", () => {
  const leads = accuracy.leadTimes.map(({ leadDays }) => leadDays);
  assert.deepEqual(leads, [...new Set(leads)].sort((a, b) => a - b));
  for (const lead of accuracy.leadTimes) {
    assert.equal(typeof lead.pairCount, "number");
    assert.ok(lead.pairCount > 0);
    for (const metric of ["minTemperature", "maxTemperature"]) {
      const stat = lead.temperature[metric];
      assert.equal(typeof stat.sampleCount, "number");
      // 표본이 없으면 0으로 꾸미지 않고 null 이어야 한다.
      if (stat.sampleCount === 0) {
        assert.equal(stat.meanAbsoluteError, null);
        assert.equal(stat.rootMeanSquaredError, null);
        assert.equal(stat.bias, null);
      } else {
        assert.ok(stat.meanAbsoluteError >= 0);
        assert.ok(stat.rootMeanSquaredError >= stat.meanAbsoluteError);
      }
    }
  }
});

test("쌍이 있으면 표본 수가 실제 계산에 쓰인 수와 어긋나지 않는다", () => {
  const leadPairs = accuracy.leadTimes.reduce(
    (sum, lead) => sum + lead.pairCount,
    0,
  );
  assert.equal(leadPairs, accuracy.coverage.pairCount);
  if (accuracy.coverage.pairCount === 0) {
    assert.equal(accuracy.state, "COLLECTING");
    assert.equal(accuracy.overall, null);
  } else {
    assert.ok(
      accuracy.overall.temperature.maxTemperature.sampleCount <=
        accuracy.coverage.pairCount,
    );
  }
});
