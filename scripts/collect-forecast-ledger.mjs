/**
 * 예보 정확도 원장 수집기.
 *
 * 기상청 단기예보 API는 "최근 3일 간의 자료만 제공합니다"(resultCode 10)로
 * 응답한다. 즉 1년 전 발행분을 지금 와서 조회할 수 없다. 과거 발행분을 한
 * 번에 받으려면 기상청 API허브의 단기예보 과거자료 활용신청이 필요하고,
 * 현재 그 API는 403("활용신청이 필요한 API 입니다")을 돌려준다.
 *
 * 그래서 오늘부터 쌓는다. 하루 한 번 이 스크립트를 돌리면
 *   1) 오늘 받을 수 있는 발행 예보를 리드타임별로 원장에 적어 두고
 *   2) 유효일에 ASOS 실측이 나온 항목을 찾아 관측값을 채운다
 * 예보와 관측이 모두 있는 쌍만 정확도 계산에 쓴다. 결측은 보간하지 않고
 * 비워 둔 채로 남긴다.
 *
 * 실행: node --env-file=.env scripts/collect-forecast-ledger.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { REVIEWED_LOCATION_MAPPINGS } from "../backend-v3/runtime/reviewed-location-mappings.js";
import { toKmaGrid } from "../backend-v3/src/application/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(here, "..", "backend-v3", "runtime", "forecast-ledger.json");

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY?.trim() || null;
const SHORT_FORECAST_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const ASOS_DAILY_URL =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList";

// 발행 시각. 05시 발행분이 그날의 첫 정식 예보다.
const BASE_TIME = "0500";
// 원장이 무한정 자라지 않게 자른다. 리드타임 4일 × 지점 수 × 보관일 기준.
const MAX_ENTRIES = 5_000;
// 예보 정확도는 지점별로 다르다. 관측지점이 겹치는 시·군은 한 번만 받는다.
const STATION_SAMPLE_LIMIT = Number(process.env.LEDGER_STATION_LIMIT ?? 8);

function kstDate(offsetDays = 0) {
  const date = new Date(Date.now() + 9 * 3_600_000 - offsetDays * 86_400_000);
  return {
    compact: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    iso: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** KST 날짜·시각을 정규 ISO 순간(UTC)으로 바꾼다. */
function kstInstant(isoDate, time) {
  return new Date(`${isoDate}T${time}+09:00`).toISOString();
}

function isoFromCompact(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 관측지점이 같은 시·군은 예보 격자도 사실상 같으므로 지점당 하나만 고른다. */
function sampleTargets() {
  const byStation = new Map();
  for (const mapping of Object.values(REVIEWED_LOCATION_MAPPINGS)) {
    const station = mapping.observationStation;
    if (!station?.verified || byStation.has(station.id)) continue;
    const grid = toKmaGrid(station.latitude, station.longitude);
    if (!grid) continue;
    byStation.set(station.id, {
      stationId: station.id,
      stationName: station.name,
      displayName: mapping.displayName,
      ...grid,
    });
  }
  return [...byStation.values()].slice(0, STATION_SAMPLE_LIMIT);
}

async function requestJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 200) };
  }
}

function resultCodeOf(payload) {
  return payload?.response?.header?.resultCode ?? null;
}

/**
 * 하루치 발행 예보를 유효일별로 접는다.
 * TMX(최고기온)·TMN(최저기온)은 하루 한 번, POP(강수확률)은 시간대별로 온다.
 * 강수확률은 그날의 최댓값을 대표값으로 쓴다. 평균을 내면 소나기 예보가
 * 희석되고, 그건 우리가 만든 값이 되어 버린다.
 */
function foldForecastItems(items, issuedIso) {
  const byDate = new Map();
  for (const item of items) {
    const date = isoFromCompact(String(item.fcstDate ?? ""));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const entry = byDate.get(date) ?? {
      validDate: date,
      maxTemperature: null,
      minTemperature: null,
      precipitationProbability: null,
    };
    const value = finite(item.fcstValue);
    if (value === null) continue;
    if (item.category === "TMX") entry.maxTemperature = value;
    if (item.category === "TMN") entry.minTemperature = value;
    if (item.category === "POP") {
      entry.precipitationProbability =
        entry.precipitationProbability === null
          ? value
          : Math.max(entry.precipitationProbability, value);
    }
    byDate.set(date, entry);
  }
  // 같은 날 05시 발행분이 그날 최고기온을 예측하는 것도 실제 예보다.
  // 버리지 않고 리드타임 0으로 명시해 둔다. 발행 이전 날짜만 제외한다.
  return [...byDate.values()]
    .filter((entry) => entry.validDate >= issuedIso)
    .map((entry) => ({
      ...entry,
      leadDays: Math.round(
        (Date.parse(`${entry.validDate}T00:00:00Z`) -
          Date.parse(`${issuedIso}T00:00:00Z`)) /
          86_400_000,
      ),
    }));
}

async function fetchIssuedForecast(target, baseCompact) {
  const url =
    `${SHORT_FORECAST_URL}?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
    `&pageNo=1&numOfRows=1000&dataType=JSON&base_date=${baseCompact}` +
    `&base_time=${BASE_TIME}&nx=${target.nx}&ny=${target.ny}`;
  const payload = await requestJson(url);
  const code = resultCodeOf(payload);
  if (code !== "00") return { code, days: [] };
  const items = payload?.response?.body?.items?.item ?? [];
  return { code, days: foldForecastItems(items, isoFromCompact(baseCompact)) };
}

async function fetchObservation(stationId, compact) {
  const url =
    `${ASOS_DAILY_URL}?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
    `&pageNo=1&numOfRows=1&dataType=JSON&dataCd=ASOS&dateCd=DAY` +
    `&startDt=${compact}&endDt=${compact}&stnIds=${stationId}`;
  const payload = await requestJson(url);
  if (resultCodeOf(payload) !== "00") return null;
  const item = payload?.response?.body?.items?.item?.[0];
  if (!item) return null;
  return {
    maxTemperature: finite(item.maxTa),
    minTemperature: finite(item.minTa),
    // 무강수일은 빈 문자열로 온다. 결측이 아니라 0으로 확정된 값이다.
    precipitationAmount:
      String(item.sumRn ?? "").trim() === "" ? 0 : finite(item.sumRn),
  };
}

async function readLedger() {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function keyOf(entry) {
  return `${entry.stationId}|${entry.issuedDate}|${entry.validDate}`;
}

async function main() {
  if (!SERVICE_KEY) {
    console.error("DATA_GO_KR_SERVICE_KEY 가 없어 수집을 건너뜁니다.");
    process.exitCode = 1;
    return;
  }

  const ledger = await readLedger();
  const byKey = new Map(ledger.entries.map((entry) => [keyOf(entry), entry]));
  const targets = sampleTargets();
  const today = kstDate(0);
  let added = 0;
  let filled = 0;
  const issueStates = [];

  // 1) 오늘 받을 수 있는 발행분을 적어 둔다. 최근 3일까지만 응답하므로
  //    D-0과 D-1만 시도하고, 이미 적어 둔 발행분은 다시 쓰지 않는다.
  for (const target of targets) {
    for (const offset of [0, 1]) {
      const base = kstDate(offset);
      const { code, days } = await fetchIssuedForecast(target, base.compact);
      issueStates.push(`${target.stationName}/${base.compact}:${code}`);
      for (const day of days) {
        const entry = {
          stationId: target.stationId,
          stationName: target.stationName,
          regionLabel: target.displayName,
          issuedDate: base.iso,
          // 백테스트 엔진은 정규 ISO 순간(UTC)만 받는다. 날짜 필드는 KST
          // 기준 그대로 두고, 시각만 UTC로 환산해 적는다.
          issuedAt: kstInstant(base.iso, "05:00:00"),
          validDate: day.validDate,
          // 일 최고·최저기온은 그날 안에 확정된다. 유효 시각을 그날 끝으로
          // 두면 리드타임 0인 당일 발행분도 발행 → 유효 순서가 성립한다.
          validAt: kstInstant(day.validDate, "23:59:59"),
          leadDays: day.leadDays,
          maxTemperature: day.maxTemperature,
          minTemperature: day.minTemperature,
          precipitationProbability: day.precipitationProbability,
          observed: null,
        };
        const key = keyOf(entry);
        if (!byKey.has(key)) {
          byKey.set(key, entry);
          added += 1;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  // 2) 유효일이 지났고 아직 실측이 비어 있는 항목을 채운다.
  //    ASOS 일자료는 전날까지만 제공되므로 오늘 것은 건드리지 않는다.
  const pending = [...byKey.values()].filter(
    (entry) => entry.observed === null && entry.validDate < today.iso,
  );
  const observationCache = new Map();
  for (const entry of pending) {
    const compact = entry.validDate.replaceAll("-", "");
    const cacheKey = `${entry.stationId}|${compact}`;
    if (!observationCache.has(cacheKey)) {
      observationCache.set(
        cacheKey,
        await fetchObservation(entry.stationId, compact),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const observed = observationCache.get(cacheKey);
    if (observed) {
      entry.observed = observed;
      filled += 1;
    }
  }

  const entries = [...byKey.values()]
    .sort((a, b) =>
      a.issuedDate === b.issuedDate
        ? a.validDate.localeCompare(b.validDate)
        : a.issuedDate.localeCompare(b.issuedDate),
    )
    .slice(-MAX_ENTRIES);

  const pairedCount = entries.filter((entry) => entry.observed !== null).length;
  await writeFile(
    LEDGER_PATH,
    `${JSON.stringify(
      {
        version: 1,
        note:
          "기상청 단기예보는 최근 3일분만 조회되므로 매일 수집해 쌓는다. " +
          "예보와 ASOS 실측이 모두 있는 항목만 정확도 계산에 쓰고 결측은 보간하지 않는다.",
        collectedAt: new Date().toISOString(),
        stationCount: targets.length,
        entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`지점 ${targets.length}곳 · 발행분 상태: ${issueStates.join(", ")}`);
  console.log(
    `원장 ${entries.length}건 (신규 ${added} · 실측 채움 ${filled} · 예보-실측 쌍 ${pairedCount})`,
  );
}

await main();
