// analysis.js — 생육 분석 로직 (UI 미노출 · 백엔드 연동 대비)
//
// 백엔드에 이미 구현되어 있는 다섯 가지 기능을 프론트에서도 같은 개념으로
// 쓸 수 있게 만든 모듈입니다. 화면에는 아직 연결하지 않았고,
// 백엔드 API가 열리면 이 모듈의 함수 시그니처에 응답을 흘려보내거나
// 함수 내부를 fetch로 교체하면 됩니다.
//
//  1) 표준 생육 지침 ↔ 실제 환경변수 비교분석   compareEnvironment(cropId, env)
//  2) 작물이 자라기에 적절한지 판단              assessSuitability(cropId, env)
//  3) 작물별 민감도 차이                         CROP_SENSITIVITY + adjustSeverity()
//  4) 단·중기예보의 위험 신호 반영               forecastRiskSignals(cropId, week)
//  5) 초보 귀농인 눈높이 자연어 가이드            generateGuide(cropId, env, week)
//
// 사용 예:
//   import { generateGuide } from './analysis.js';
//   const guide = generateGuide('lettuce',
//     { tMax: 31, tMin: 24, moisture: 45, ph: 6.5 },
//     [{ code: 'heatwave', tMax: 34, tMin: 26, label: '오늘' }, ...]);

import { CONDITIONS } from './conditions.js';

/* ════════════════════════════════════════════
   1) 작물별 표준 생육 지침 데이터
   (농촌진흥청 표준 재배법 기준의 근사값 — 백엔드 실데이터로 교체 예정)
════════════════════════════════════════════ */

export const CROP_STANDARDS = {
  //          생육 적온(℃)          생육 한계(℃)             적정 토양수분(%)      적정 pH
  lettuce:  { name: '상추', temp: { min: 15, max: 20 }, tempLimit: { min: 5,   max: 28 }, moisture: { min: 40, max: 70 }, ph: { min: 6.0, max: 6.8 } },
  cucumber: { name: '오이', temp: { min: 22, max: 28 }, tempLimit: { min: 10,  max: 33 }, moisture: { min: 50, max: 80 }, ph: { min: 5.8, max: 6.8 } },
  potato:   { name: '감자', temp: { min: 14, max: 23 }, tempLimit: { min: 3,   max: 30 }, moisture: { min: 35, max: 65 }, ph: { min: 5.0, max: 6.5 } },
  apple:    { name: '사과', temp: { min: 15, max: 24 }, tempLimit: { min: -10, max: 33 }, moisture: { min: 30, max: 60 }, ph: { min: 5.5, max: 6.5 } },
  pear:     { name: '배',   temp: { min: 15, max: 25 }, tempLimit: { min: -8,  max: 33 }, moisture: { min: 35, max: 65 }, ph: { min: 5.5, max: 7.0 } },
};

/* ════════════════════════════════════════════
   3) 작물별 민감도 (1 = 보통, 클수록 민감)
   민감도가 1.5 이상이면 해당 위험의 등급이 한 단계 올라가고(주의→위험),
   0.8 이하면 한 단계 내려갑니다(위험→주의).
════════════════════════════════════════════ */

export const CROP_SENSITIVITY = {
  lettuce:  { heat: 1.6, cold: 1.0, wet: 1.2, drought: 1.3, wind: 0.8 }, // 상추: 더위에 매우 약함
  cucumber: { heat: 1.0, cold: 1.5, wet: 1.1, drought: 1.4, wind: 1.0 }, // 오이: 저온·가뭄에 약함
  potato:   { heat: 1.3, cold: 0.9, wet: 1.6, drought: 1.0, wind: 0.7 }, // 감자: 과습(썩음)에 매우 약함
  apple:    { heat: 1.0, cold: 0.8, wet: 1.0, drought: 0.9, wind: 1.4 }, // 사과: 내한성 강함, 강풍(낙과) 주의
  pear:     { heat: 1.0, cold: 0.9, wet: 1.0, drought: 0.9, wind: 1.5 }, // 배: 강풍(낙과)에 가장 약함
};

// 상태 코드 → 민감도 축
const FACTOR_OF_CODE = {
  heat: 'heat', heatwave: 'heat',
  cold: 'cold', frost: 'cold',
  rain: 'wet', downpour: 'wet', overwet: 'wet', drainage: 'wet', flood: 'wet',
  drought: 'drought', dry: 'drought',
  wind: 'wind', typhoon: 'wind',
};
const SEV_RANK = { good: 0, warn: 1, danger: 2 };

/** 작물 민감도를 반영해 상태 코드의 등급을 조정합니다. */
export function adjustSeverity(cropId, code) {
  const base = CONDITIONS[code]?.severity || 'good';
  const factor = FACTOR_OF_CODE[code];
  if (!factor || base === 'good') return base;
  const s = (CROP_SENSITIVITY[cropId] || {})[factor] ?? 1;
  if (s >= 1.5 && base === 'warn') return 'danger';
  if (s <= 0.8 && base === 'danger') return 'warn';
  return base;
}

/* ════════════════════════════════════════════
   1) 표준 지침 ↔ 실제 환경변수 비교분석
════════════════════════════════════════════ */

/**
 * @param {string} cropId
 * @param {object} env - { tAvg?, tMax?, tMin?, moisture?, ph? } (있는 값만 비교)
 * @returns {Array<{factor, actual, optimal, unit, status:'ok'|'low'|'high', delta}>}
 */
export function compareEnvironment(cropId, env = {}) {
  const std = CROP_STANDARDS[cropId];
  if (!std) return [];
  const rows = [];
  const push = (factor, actual, optimal, unit) => {
    if (actual == null) return;
    let status = 'ok', delta = 0;
    if (actual < optimal.min) { status = 'low'; delta = +(optimal.min - actual).toFixed(1); }
    else if (actual > optimal.max) { status = 'high'; delta = +(actual - optimal.max).toFixed(1); }
    rows.push({ factor, actual, optimal, unit, status, delta });
  };
  const tAvg = env.tAvg ?? (env.tMax != null && env.tMin != null ? +((env.tMax + env.tMin) / 2).toFixed(1) : null);
  push('temp', tAvg, std.temp, '℃');
  push('moisture', env.moisture, std.moisture, '%');
  push('ph', env.ph, std.ph, '');
  return rows;
}

/* ════════════════════════════════════════════
   2) 작물이 자라기에 적절한지 판단 (0~100점)
════════════════════════════════════════════ */

/**
 * 적정 범위를 벗어난 정도(적정 폭 대비)에 비례해 감점하고,
 * 생육 한계선을 넘으면 크게 감점합니다.
 * @returns {{cropId, score, verdict:'적합'|'조건부 적합'|'부적합', deviations}}
 */
export function assessSuitability(cropId, env = {}) {
  const std = CROP_STANDARDS[cropId];
  const rows = compareEnvironment(cropId, env);
  let score = 100;
  for (const r of rows) {
    if (r.status === 'ok') continue;
    const span = r.optimal.max - r.optimal.min;
    const over = Math.min(r.delta / (span || 1), 1.5); // 적정 폭 대비 벗어난 비율
    score -= Math.round(30 * over);
  }
  if (std && env.tMax != null && env.tMax > std.tempLimit.max) score -= 25; // 생육 한계 초과
  if (std && env.tMin != null && env.tMin < std.tempLimit.min) score -= 25;
  score = Math.max(0, Math.min(score, 100));
  const verdict = score >= 75 ? '적합' : score >= 50 ? '조건부 적합' : '부적합';
  return { cropId, score, verdict, deviations: rows.filter((r) => r.status !== 'ok') };
}

/* ════════════════════════════════════════════
   4) 단·중기예보의 위험 신호 반영
   0~2일 뒤 = 단기, 3일 뒤부터 = 중기.
   작물 민감도로 등급을 조정하고, 심한 것/가까운 것부터 정렬합니다.
════════════════════════════════════════════ */

/**
 * @param {string} cropId
 * @param {Array<{code, tMax?, tMin?, label?}>} week - 0번째 = 오늘
 * @returns {Array<{dayIndex, label, horizon:'단기'|'중기', code, name, severity, escalated}>}
 */
export function forecastRiskSignals(cropId, week = []) {
  const signals = [];
  week.forEach((day, i) => {
    const severity = adjustSeverity(cropId, day.code);
    if (severity === 'good') return;
    signals.push({
      dayIndex: i,
      label: day.label || (i === 0 ? '오늘' : `${i}일 뒤`),
      horizon: i <= 2 ? '단기' : '중기',
      code: day.code,
      name: CONDITIONS[day.code]?.label || day.code,
      severity,
      escalated: severity !== (CONDITIONS[day.code]?.severity || 'good'), // 민감도로 격상됐는지
    });
  });
  return signals.sort(
    (a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || (a.dayIndex - b.dayIndex),
  );
}

/* ════════════════════════════════════════════
   5) 초보 귀농인 눈높이 자연어 가이드
   위 분석 결과들을 묶어 쉬운 한국어 문장으로 풀어줍니다.
════════════════════════════════════════════ */

const FACTOR_NAMES = { temp: '기온', moisture: '흙 속 수분', ph: '흙의 산도(pH)' };

// 받침 유무에 따라 이/가 조사를 붙임 (한글이 아니면 '가')
function withGa(word) {
  const code = word.charCodeAt(word.length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  const hasBatchim = isHangul && (code - 0xac00) % 28 > 0;
  return word + (hasBatchim ? '이' : '가');
}

const CONDITION_ADVICE = {
  heat: '한낮을 피해 아침저녁으로 물을 주세요.',
  heatwave: '차광막으로 볕을 가려주고 물을 넉넉히 주세요.',
  cold: '보온 덮개를 미리 준비해 두세요.',
  frost: '해 지기 전에 부직포를 덮어 서리를 막아주세요.',
  rain: '비 오기 전에 배수로만 정리해두면 걱정 없어요.',
  downpour: '물이 고이지 않게 고랑과 배수로를 꼭 점검하세요.',
  wind: '지지대를 단단히 고정하고 끈을 조여주세요.',
  typhoon: '시설을 묶어두고, 딸 수 있는 열매는 미리 수확하세요.',
  drought: '물 주는 횟수를 늘리고 흙 표면을 덮어 증발을 줄이세요.',
};

/**
 * @param {string} cropId
 * @param {object} env - 현재 환경 { tMax, tMin, moisture, ph ... }
 * @param {Array} week - 주간 예보 [{code, label?}, ...]
 * @returns {{ text: string, sentences: string[], suitability, signals }}
 */
export function generateGuide(cropId, env = {}, week = []) {
  const std = CROP_STANDARDS[cropId];
  const name = std ? std.name : cropId;
  const suitability = assessSuitability(cropId, env);
  const signals = forecastRiskSignals(cropId, week);
  const sentences = [];

  // ① 지금 환경이 어떤지
  if (!suitability.deviations.length) {
    sentences.push(`지금 밭 환경은 ${name}가 자라기에 알맞아요.`);
  } else {
    const parts = suitability.deviations.map((d) =>
      `${withGa(FACTOR_NAMES[d.factor])} 적정 범위(${d.optimal.min}~${d.optimal.max}${d.unit})보다 ${d.status === 'high' ? '높아요' : '낮아요'} (지금 ${d.actual}${d.unit})`);
    sentences.push(`지금 환경은 ${name}에게 '${suitability.verdict}' 수준이에요. ${parts.join(', ')}.`);
  }

  // ② 가까운 위험(단기)부터 알려주기
  const near = signals.filter((s) => s.horizon === '단기');
  const far = signals.filter((s) => s.horizon === '중기');
  if (near.length) {
    const worst = near[0];
    let line = `${worst.label} '${worst.name}' 예보가 있어요.`;
    if (worst.escalated) line += ` ${name}는 특히 ${worst.name}에 약한 작물이라 더 신경 써야 해요.`;
    const advice = CONDITION_ADVICE[worst.code];
    if (advice) line += ` ${advice}`;
    sentences.push(line);
  }

  // ③ 이번 주 후반(중기) 흐름
  if (far.length) {
    const names = [...new Set(far.map((s) => s.name))];
    sentences.push(`이번 주 후반에는 ${names.join(', ')} 예보가 있으니 미리 준비해두면 좋아요.`);
  }

  if (!signals.length) {
    sentences.push('이번 주는 크게 걱정할 날씨가 없어요. 평소처럼 돌봐주세요.');
  }

  return { text: sentences.join(' '), sentences, suitability, signals };
}
