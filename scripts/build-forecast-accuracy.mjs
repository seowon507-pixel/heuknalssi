/**
 * 예보 정확도 지표 생성기.
 *
 * `forecast-ledger.json`에 쌓인 예보-실측 쌍을 검수된 백테스트 엔진에 넣어
 * MAE·RMSE·bias와 강수확률 Brier score를 계산하고, 화면이 읽을 정적 JSON을
 * 만든다. 매 요청마다 다시 계산하지 않는다.
 *
 * 원칙
 * - 결측은 보간하지 않는다. 예보와 실측이 모두 있는 쌍만 센다.
 * - 리드타임을 섞지 않는다. 하루 뒤 예보와 사흘 뒤 예보는 정확도가 다르다.
 * - 표본 수를 숨기지 않는다. 적으면 적다고 그대로 싣는다.
 *
 * 실행: node scripts/build-forecast-accuracy.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { calculateIssuedForecastMetrics } from "../backend-v3/src/application/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, "..", "backend-v3", "runtime");
const LEDGER_PATH = join(runtimeDir, "forecast-ledger.json");
// 화면이 읽는 산출물이라 UI 디렉터리에 둔다. dev 서버가 /ui-integration/ 를
// 그대로 서빙하고 Vercel 빌드도 같은 목록으로 복사한다.
const OUTPUT_PATH = join(here, "..", "ui-integration", "forecast-accuracy.json");

// 이 아래면 숫자를 대표값으로 내세우지 않는다. 표본이 적을 때 소수점을
// 들이미는 것이 이 제품에서 가장 하기 쉬운 거짓말이다.
const MIN_REPORTABLE_SAMPLES = 10;

function toEngineRows(entries) {
  const issuedForecasts = [];
  const observations = [];
  for (const entry of entries) {
    if (!entry?.observed) continue;
    issuedForecasts.push({
      issuedAt: entry.issuedAt,
      validAt: entry.validAt,
      validDate: entry.validDate,
      minTemperature: entry.minTemperature,
      maxTemperature: entry.maxTemperature,
      precipitationProbability: entry.precipitationProbability,
    });
    observations.push({
      date: entry.validDate,
      minTemperature: entry.observed.minTemperature,
      maxTemperature: entry.observed.maxTemperature,
      precipitationAmount: entry.observed.precipitationAmount,
    });
  }
  return { issuedForecasts, observations };
}

/**
 * 엔진은 유효일 하나에 관측 하나를 기대한다. 지점이 여러 곳이면 같은 날짜가
 * 겹치므로 지점별로 따로 돌린 뒤 오차 표본을 합친다.
 */
function metricsForGroup(entries) {
  const byStation = new Map();
  for (const entry of entries) {
    const list = byStation.get(entry.stationId) ?? [];
    list.push(entry);
    byStation.set(entry.stationId, list);
  }
  const merged = {
    minTemperature: { errors: [], absolute: [] },
    maxTemperature: { errors: [], absolute: [] },
    brier: [],
  };
  for (const list of byStation.values()) {
    const { issuedForecasts, observations } = toEngineRows(list);
    if (issuedForecasts.length === 0) continue;
    const result = calculateIssuedForecastMetrics({
      issuedForecasts,
      observations,
    });
    for (const metric of ["minTemperature", "maxTemperature"]) {
      const stat = result.temperature[metric];
      if (stat.sampleCount === 0) continue;
      // 엔진은 요약값만 돌려준다. 지점별 표본 수로 가중해 합친다.
      merged[metric].errors.push([stat.bias, stat.sampleCount]);
      merged[metric].absolute.push([
        stat.meanAbsoluteError,
        stat.rootMeanSquaredError,
        stat.sampleCount,
      ]);
    }
    if (result.precipitation.sampleCount > 0) {
      merged.brier.push([
        result.precipitation.brierScore,
        result.precipitation.sampleCount,
      ]);
    }
  }
  return summarize(merged);
}

function weightedMean(pairs) {
  const total = pairs.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  return (
    pairs.reduce((sum, [value, count]) => sum + value * count, 0) / total
  );
}

function summarize(merged) {
  const temperature = {};
  for (const metric of ["minTemperature", "maxTemperature"]) {
    const samples = merged[metric].absolute.reduce(
      (sum, [, , count]) => sum + count,
      0,
    );
    temperature[metric] = {
      sampleCount: samples,
      meanAbsoluteError: round(
        weightedMean(merged[metric].absolute.map(([mae, , n]) => [mae, n])),
      ),
      // RMSE는 제곱평균이라 그대로 가중평균하면 과소평가된다. 제곱해서 합친다.
      rootMeanSquaredError: round(
        rootWeightedMeanSquare(merged[metric].absolute),
      ),
      bias: round(weightedMean(merged[metric].errors)),
    };
  }
  const brierSamples = merged.brier.reduce((sum, [, count]) => sum + count, 0);
  return {
    temperature,
    precipitation: {
      sampleCount: brierSamples,
      brierScore: round(weightedMean(merged.brier), 3),
      eventDefinition: "ASOS 일강수량 > 0 mm",
    },
  };
}

function rootWeightedMeanSquare(rows) {
  const total = rows.reduce((sum, [, , count]) => sum + count, 0);
  if (total === 0) return null;
  const meanSquare =
    rows.reduce((sum, [, rmse, count]) => sum + rmse * rmse * count, 0) / total;
  return Math.sqrt(meanSquare);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  let ledger;
  try {
    ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  } catch {
    ledger = { entries: [] };
  }
  const entries = (ledger.entries ?? []).filter((entry) => entry?.observed);

  const byLead = new Map();
  for (const entry of entries) {
    const lead = Number.isFinite(entry.leadDays) ? entry.leadDays : null;
    if (lead === null) continue;
    const list = byLead.get(lead) ?? [];
    list.push(entry);
    byLead.set(lead, list);
  }

  const leadTimes = [...byLead.entries()]
    .sort(([a], [b]) => a - b)
    .map(([leadDays, list]) => ({
      leadDays,
      pairCount: list.length,
      ...metricsForGroup(list),
    }));

  const overall = entries.length > 0 ? metricsForGroup(entries) : null;
  const pairCount = entries.length;
  const stationIds = [...new Set(entries.map((entry) => entry.stationId))];
  const dates = entries.map((entry) => entry.validDate).sort();

  const accuracy = {
    version: 1,
    state:
      pairCount === 0
        ? "COLLECTING"
        : pairCount < MIN_REPORTABLE_SAMPLES
          ? "PARTIAL"
          : "READY",
    minimumReportableSamples: MIN_REPORTABLE_SAMPLES,
    generatedAt: new Date().toISOString(),
    source: {
      forecast: "기상청 단기예보 조회서비스 (발행분 원장 누적)",
      observation: "기상청 지상(종관, ASOS) 일자료 조회서비스",
      note:
        "단기예보 API가 최근 3일분만 제공하므로 매일 수집해 쌓은 발행분과 " +
        "이후 확정된 ASOS 실측을 짝지어 계산한다. 결측은 보간하지 않는다.",
    },
    coverage: {
      pairCount,
      stationCount: stationIds.length,
      firstValidDate: dates[0] ?? null,
      lastValidDate: dates.at(-1) ?? null,
    },
    overall,
    leadTimes,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(accuracy, null, 2)}\n`, "utf8");
  const headline = overall?.temperature?.maxTemperature;
  console.log(
    `정확도 ${accuracy.state} · 쌍 ${pairCount}건 · 지점 ${stationIds.length}곳` +
      (headline?.meanAbsoluteError !== null && headline?.meanAbsoluteError !== undefined
        ? ` · 최고기온 MAE ${headline.meanAbsoluteError}℃`
        : ""),
  );
  for (const lead of leadTimes) {
    console.log(
      `  리드 ${lead.leadDays}일: ${lead.pairCount}쌍 · 최고 MAE ` +
        `${lead.temperature.maxTemperature.meanAbsoluteError ?? "—"}℃ · 최저 MAE ` +
        `${lead.temperature.minTemperature.meanAbsoluteError ?? "—"}℃`,
    );
  }
}

await main();
