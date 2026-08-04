// conditions.js — 밭 상태(날씨·토양) 판정 로직 + 표시 문구 + 아이콘
//
// ※ 아직 대시보드 UI에는 연결하지 않은 "대기 중" 모듈입니다.
//    나중에 기상청·농촌진흥청 등 실데이터 API가 붙으면:
//
//      import { classifyWeather, classifySoil, fieldHeadline, conditionBadge } from './conditions.js';
//      const h = fieldHeadline(weatherData, soilData);
//      $('#status-title').textContent = h.title;          // 예: "주의 · 폭염"
//      chipEl.innerHTML = conditionBadge(h.code);          // 아이콘 + 글씨 배지
//
//    처럼 쓰면 됩니다. (앞자리 = 등급 양호/주의/위험, 뒷자리 = 표시 문구)
//
// 미리보기: 서버 실행 후 /conditions-preview.html 에서 전체 문구·아이콘 확인 가능.

/* ════════════════════════════════════════════
   1. 판정 기준값 (실데이터 연동 시 여기 숫자만 조정)
════════════════════════════════════════════ */

export const THRESHOLDS = {
  // 날씨
  HEAT_TMAX: 30,      // ℃ 이상이면 고온 (작물 스트레스 시작)
  HEATWAVE_TMAX: 33,  // ℃ 이상이면 폭염 (폭염주의보 수준)
  COLD_TMIN: 5,       // ℃ 이하이면 저온
  FROST_TMIN: 0,      // ℃ 이하이면 서리 위험
  RAIN_ANY: 1,        // mm/일 이상이면 비
  RAIN_HEAVY: 80,     // mm/일 이상이면 폭우 (호우주의보 수준)
  WIND_STRONG: 14,    // m/s 이상이면 강풍 (강풍주의보 수준)
  DROUGHT_DAYS: 14,   // 무강수 지속 일수 이상이면 가뭄
  // 토양
  MOIST_DRY: 20,      // % 이하이면 토양 건조
  MOIST_WET: 80,      // % 이상이면 과습
  PH_MIN: 5.5,        // 적정 pH 하한
  PH_MAX: 7.5,        // 적정 pH 상한
  EC_MAX: 2,          // dS/m 이상이면 염류 과다
};

/* ════════════════════════════════════════════
   2. 상태 사전 — 데이터 조건 → 표시 문구
════════════════════════════════════════════ */

// severity: good(양호) | warn(주의) | danger(위험)
export const CONDITIONS = {
  // ── 날씨 원인 ──
  stable:     { group: 'weather', label: '날씨 안정',   severity: 'good',   condition: '위험 신호 없음' },
  clear:      { group: 'weather', label: '맑은 날씨',   severity: 'good',   condition: '맑고 적정 기온' },
  heat:       { group: 'weather', label: '고온',        severity: 'warn',   condition: '최고기온 기준 초과' },
  heatwave:   { group: 'weather', label: '폭염',        severity: 'danger', condition: '심각한 고온' },
  cold:       { group: 'weather', label: '저온',        severity: 'warn',   condition: '최저기온 기준 미달' },
  frost:      { group: 'weather', label: '서리',        severity: 'danger', condition: '영하·서리 위험' },
  rain:       { group: 'weather', label: '비',          severity: 'warn',   condition: '강수 예상' },
  downpour:   { group: 'weather', label: '폭우',        severity: 'danger', condition: '많은 강수' },
  wind:       { group: 'weather', label: '강풍',        severity: 'warn',   condition: '강한 바람' },
  typhoon:    { group: 'weather', label: '태풍',        severity: 'danger', condition: '태풍 영향' },
  drought:    { group: 'weather', label: '가뭄',        severity: 'warn',   condition: '강수 부족 지속' },
  // ── 땅·토양 원인 ──
  soilStable: { group: 'soil',    label: '토양 안정',   severity: 'good',   condition: '확인 항목이 적정' },
  dry:        { group: 'soil',    label: '토양 건조',   severity: 'warn',   condition: '수분 부족' },
  overwet:    { group: 'soil',    label: '과습',        severity: 'warn',   condition: '수분 과다' },
  drainage:   { group: 'soil',    label: '배수 불량',   severity: 'warn',   condition: '물 빠짐 불량' },
  acidity:    { group: 'soil',    label: '산도 불균형', severity: 'warn',   condition: 'pH 기준 이탈' },
  salinity:   { group: 'soil',    label: '염류 과다',   severity: 'warn',   condition: 'EC 기준 초과' },
  texture:    { group: 'soil',    label: '토성 주의',   severity: 'warn',   condition: '토성 부적합' },
  flood:      { group: 'soil',    label: '침수',        severity: 'danger', condition: '침수 수준' },
};

export const SEVERITY_LABELS = { good: '양호', warn: '주의', danger: '위험' };
const SEVERITY_RANK = { good: 0, warn: 1, danger: 2 };

function cond(code) {
  const c = CONDITIONS[code];
  return { code, ...c, severityLabel: SEVERITY_LABELS[c.severity] };
}

/* ════════════════════════════════════════════
   3. 판정 로직 (심각한 것부터 검사, 첫 일치가 결과)
════════════════════════════════════════════ */

/**
 * 날씨 데이터 → 상태.
 * @param {object} w
 *   tMax(℃ 최고기온) · tMin(℃ 최저기온) · rainMm(일 강수량) · windMs(최대 풍속)
 *   typhoon(태풍 영향권 여부) · frost(서리 예보 여부) · dryDays(무강수 지속 일수)
 *   cloudy(흐림 여부 — 맑은 날씨 판정에만 사용)
 */
export function classifyWeather(w = {}) {
  const T = THRESHOLDS;
  const { tMax = null, tMin = null, rainMm = 0, windMs = 0,
          typhoon = false, frost = false, dryDays = 0, cloudy = false } = w;

  if (typhoon) return cond('typhoon');
  if (rainMm >= T.RAIN_HEAVY) return cond('downpour');
  if (frost || (tMin !== null && tMin <= T.FROST_TMIN)) return cond('frost');
  if (tMax !== null && tMax >= T.HEATWAVE_TMAX) return cond('heatwave');
  if (windMs >= T.WIND_STRONG) return cond('wind');
  if (tMin !== null && tMin <= T.COLD_TMIN) return cond('cold');
  if (tMax !== null && tMax >= T.HEAT_TMAX) return cond('heat');
  if (rainMm >= T.RAIN_ANY) return cond('rain');
  if (dryDays >= T.DROUGHT_DAYS) return cond('drought');
  if (!cloudy && tMax !== null) return cond('clear');
  return cond('stable');
}

/**
 * 토양 데이터 → 상태.
 * @param {object} s
 *   moisture(토양 수분 %) · drainagePoor(물 빠짐 불량 여부) · ph(산도) · ec(전기전도도 dS/m)
 *   textureOk(토성 적합 여부) · flooded(침수 여부)
 */
export function classifySoil(s = {}) {
  const T = THRESHOLDS;
  const { moisture = null, drainagePoor = false, ph = null, ec = null,
          textureOk = true, flooded = false } = s;

  if (flooded) return cond('flood');
  if (moisture !== null && moisture >= T.MOIST_WET) return cond('overwet');
  if (drainagePoor) return cond('drainage');
  if (ec !== null && ec >= T.EC_MAX) return cond('salinity');
  if (ph !== null && (ph < T.PH_MIN || ph > T.PH_MAX)) return cond('acidity');
  if (moisture !== null && moisture <= T.MOIST_DRY) return cond('dry');
  if (!textureOk) return cond('texture');
  return cond('soilStable');
}

/**
 * 날씨+토양을 합쳐 대시보드 헤드라인 한 줄을 만듭니다.
 * 더 심각한 쪽의 문구를 앞세우고, 같으면 날씨를 우선합니다.
 * @returns {{ title:string, code:string, label:string, severity:string,
 *             severityLabel:string, weather:object, soil:object }}
 *   title 예: "양호 · 맑은 날씨", "주의 · 과습", "위험 · 폭염"
 */
export function fieldHeadline(weatherData = {}, soilData = {}) {
  const w = classifyWeather(weatherData);
  const s = classifySoil(soilData);
  const primary = SEVERITY_RANK[s.severity] > SEVERITY_RANK[w.severity] ? s : w;
  return {
    title: `${primary.severityLabel} · ${primary.label}`,
    code: primary.code,
    label: primary.label,
    severity: primary.severity,
    severityLabel: primary.severityLabel,
    weather: w,
    soil: s,
  };
}

/* ════════════════════════════════════════════
   4. 아이콘 (앱 일러스트와 같은 손그림 팔레트)
   좌표계: viewBox 0 0 44 44
════════════════════════════════════════════ */

const INK = '#4b4237';
const SUN = '#d8b856', SUN_FILL = '#f2dfa0';
const CLOUD = '#eef0e6', CLOUD_LINE = '#a9b0a0';
const RAIN = '#7f9cb0', RAIN_FILL = '#a9c2d2';
const SOIL = '#a3855f', SOIL_DEEP = '#7c6347';
const GREEN = '#6f815a', GREEN_SOFT = '#aab98d';
const WARN = '#c9825b', DANGER = '#b04a35';

// ── 조각 도우미 ──
function sunArt(cx, cy, r, withRays = true) {
  let rays = '';
  if (withRays) {
    for (let i = 0; i < 8; i++) {
      const a = (i * 45 * Math.PI) / 180;
      rays += `<line x1="${cx + Math.cos(a) * (r + 2.5)}" y1="${cy + Math.sin(a) * (r + 2.5)}"
        x2="${cx + Math.cos(a) * (r + 5.5)}" y2="${cy + Math.sin(a) * (r + 5.5)}"/>`;
    }
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN_FILL}" stroke="${SUN}" stroke-width="1.8"/>
    <g stroke="${SUN}" stroke-width="1.8" stroke-linecap="round">${rays}</g>`;
}

function cloudArt(cx, cy, s = 1, fill = CLOUD, line = CLOUD_LINE) {
  return `<g transform="translate(${cx} ${cy}) scale(${s})">
    <path d="M-11 5 q-5 0 -5 -4.5 q0 -5 5 -5 q1.5 -5 7 -5 q5 0 7 4 q6 -0.5 7 4 q1 5 -4 6.5 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.8" stroke-linejoin="round"/>
  </g>`;
}

function dropArt(x, y, s = 1, fill = RAIN_FILL, line = RAIN) {
  return `<path d="M${x} ${y - 4 * s} q ${3.2 * s} ${3.8 * s} 0 ${5.6 * s} q ${-3.2 * s} ${-1.8 * s} 0 ${-5.6 * s} Z"
    fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function soilArt(y = 30, cracks = '') {
  return `<path d="M6 ${y + 3} Q14 ${y - 1} 22 ${y} Q30 ${y - 1} 38 ${y + 3} L38 40 L6 40 Z"
      fill="${SOIL}" stroke="${SOIL_DEEP}" stroke-width="1.8" stroke-linejoin="round"/>
    <circle cx="14" cy="${y + 6}" r="1" fill="${SOIL_DEEP}" opacity=".6"/>
    <circle cx="29" cy="${y + 7}" r="1" fill="${SOIL_DEEP}" opacity=".6"/>
    ${cracks}`;
}

function thermoArt(level, color) {
  const top = 9, bottom = 27;
  const mercY = bottom - (bottom - top) * level;
  return `
    <rect x="19" y="6" width="7" height="24" rx="3.5" fill="#fdfbf4" stroke="${INK}" stroke-width="1.8"/>
    <circle cx="22.5" cy="33" r="5.5" fill="${color}" stroke="${INK}" stroke-width="1.8"/>
    <line x1="22.5" y1="${mercY}" x2="22.5" y2="30" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/>
    <line x1="28.5" y1="12" x2="31" y2="12" stroke="${INK}" stroke-width="1.4" opacity=".5"/>
    <line x1="28.5" y1="18" x2="31" y2="18" stroke="${INK}" stroke-width="1.4" opacity=".5"/>`;
}

function snowflakeArt(cx, cy, r, color = RAIN) {
  let arms = '';
  for (let i = 0; i < 3; i++) {
    const a = (i * 60 * Math.PI) / 180;
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
    arms += `<line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}"/>`;
    // 가지 끝 잔가지
    for (const t of [0.65, -0.65]) {
      const px = cx + dx * t, py = cy + dy * t;
      const b = a + Math.PI / 2;
      arms += `<line x1="${px - Math.cos(b) * 2.4}" y1="${py - Math.sin(b) * 2.4}"
        x2="${px + Math.cos(b) * 2.4}" y2="${py + Math.sin(b) * 2.4}"/>`;
    }
  }
  return `<g stroke="${color}" stroke-width="1.7" stroke-linecap="round">${arms}</g>`;
}

// ── 문구별 아이콘 ──
const ICONS = {
  // 날씨
  stable: () => `${sunArt(16, 15, 6)}${cloudArt(27, 26, 0.85)}`,
  clear: () => sunArt(22, 22, 8.5),
  heat: () => `${thermoArt(0.62, WARN)}${sunArt(35, 9, 4, true)}`,
  heatwave: () => `${thermoArt(0.92, DANGER)}
    <g stroke="${WARN}" stroke-width="1.8" stroke-linecap="round" fill="none">
      <path d="M31 16 q2.5 -2.5 5 0"/><path d="M31 22 q2.5 -2.5 5 0"/><path d="M31 28 q2.5 -2.5 5 0"/>
    </g>`,
  cold: () => `${thermoArt(0.22, RAIN)}${snowflakeArt(34, 13, 4.5)}`,
  frost: () => snowflakeArt(22, 22, 11),
  rain: () => `${cloudArt(22, 15, 1.05)}${dropArt(14, 30)}${dropArt(22, 34)}${dropArt(30, 30)}`,
  downpour: () => `${cloudArt(22, 13, 1.05, '#d9dde3', '#8f98a8')}
    ${dropArt(12, 27)}${dropArt(20, 31)}${dropArt(28, 27)}${dropArt(34, 32, 0.85)}${dropArt(16, 36, 0.85)}
    <path d="M24 39 q3 1.5 6 0" fill="none" stroke="${RAIN}" stroke-width="1.5" stroke-linecap="round"/>`,
  wind: () => `<g stroke="${RAIN}" stroke-width="2" stroke-linecap="round" fill="none">
      <path d="M6 15 h17 q5.5 0 5.5 -4.5 q0 -3.5 -3.5 -3.5"/>
      <path d="M6 23 h24 q6 0 6 5 q0 4 -4 4"/>
      <path d="M6 31 h13"/>
    </g>`,
  typhoon: () => `<g stroke="${RAIN}" stroke-width="2.2" stroke-linecap="round" fill="none">
      <path d="M22 22 m-1.5 -1 a2 2 0 1 1 -1 3.4 a5.5 5.5 0 1 0 6 -8 a10 10 0 1 1 -13 10.5"/>
    </g>
    ${dropArt(35, 12, 0.8)}${dropArt(9, 33, 0.8)}`,
  drought: () => `${sunArt(22, 12, 5.5)}${soilArt(28, `
    <g stroke="${SOIL_DEEP}" stroke-width="1.6" stroke-linecap="round" fill="none">
      <path d="M15 29.5 l-3 6"/><path d="M22 28.5 v7.5"/><path d="M29 29.5 l3.5 5.5"/>
      <path d="M22 32 l3 2"/>
    </g>`)}`,
  // 토양
  soilStable: () => `${soilArt(29)}
    <path d="M22 29 q-1 -6 0 -9" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <path d="M22 20 Q17 20 16 15 Q21 15.5 22 20 Z" fill="${GREEN_SOFT}" stroke="${GREEN}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M22 20 Q27 20 28 15 Q23 15.5 22 20 Z" fill="${GREEN_SOFT}" stroke="${GREEN}" stroke-width="1.6" stroke-linejoin="round"/>`,
  dry: () => `${soilArt(24, `
    <g stroke="${SOIL_DEEP}" stroke-width="1.7" stroke-linecap="round" fill="none">
      <path d="M14 26 l-3.5 7"/><path d="M22 25 v9 M22 30 l3.5 2.5"/><path d="M30 26 l4 6"/>
    </g>`)}
    <path d="M13 20 q-1.5 -4 1 -6 M17 21 q0 -4.5 2 -6" fill="none" stroke="#b3a06a" stroke-width="1.6" stroke-linecap="round"/>`,
  overwet: () => `${dropArt(22, 12, 1.4)}${soilArt(27)}
    ${dropArt(15, 23, 0.9)}${dropArt(29, 23, 0.9)}`,
  drainage: () => `${soilArt(30)}
    <g stroke="${RAIN}" stroke-width="2" stroke-linecap="round" fill="none">
      <path d="M9 25 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0 q3 2.5 6 0"/>
      <path d="M13 19.5 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0"/>
    </g>`,
  acidity: () => `
    <path d="M22 6 C27.5 14 31 19 31 25 a9 9 0 0 1 -18 0 C13 19 16.5 14 22 6 Z"
      fill="${RAIN_FILL}" stroke="${RAIN}" stroke-width="1.8" stroke-linejoin="round"/>
    <text x="22" y="29" text-anchor="middle" font-size="10.5" fill="${INK}"
      font-family="'Gowun Dodum', sans-serif">pH</text>`,
  salinity: () => `${soilArt(29)}
    <g fill="#fdfbf4" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round">
      <rect x="12" y="13" width="5.5" height="5.5" transform="rotate(45 14.75 15.75)"/>
      <rect x="25" y="8" width="6" height="6" transform="rotate(45 28 11)"/>
      <rect x="30" y="19" width="4.5" height="4.5" transform="rotate(45 32.25 21.25)"/>
    </g>`,
  texture: () => `
    <path d="M7 15 Q22 11 37 15 L37 22 Q22 18 7 22 Z" fill="#c4ad85" stroke="${SOIL_DEEP}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M7 22 Q22 18 37 22 L37 29 Q22 25 7 29 Z" fill="${SOIL}" stroke="${SOIL_DEEP}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M7 29 Q22 25 37 29 L37 37 L7 37 Z" fill="#8a6c47" stroke="${SOIL_DEEP}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="36" cy="9" r="5.5" fill="#f5e3da" stroke="${WARN}" stroke-width="1.5"/>
    <line x1="36" y1="6.5" x2="36" y2="10" stroke="${WARN}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="36" cy="12" r="0.9" fill="${WARN}"/>`,
  flood: () => `
    <path d="M22 16 Q17 16 16 11 Q21 11.5 22 16 Z" fill="${GREEN_SOFT}" stroke="${GREEN}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M22 16 Q27 16 28 11 Q23 11.5 22 16 Z" fill="${GREEN_SOFT}" stroke="${GREEN}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M22 21 v-5" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <g stroke="${RAIN}" stroke-width="2" stroke-linecap="round" fill="none">
      <path d="M7 23 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0"/>
      <path d="M9 29.5 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0 q3 2.5 6 0"/>
      <path d="M12 36 q3 -2.5 6 0 q3 2.5 6 0 q3 -2.5 6 0"/>
    </g>`,
};

/** 문구 아이콘 SVG. code는 CONDITIONS의 키. */
export function conditionIcon(code, size = 40) {
  const draw = ICONS[code];
  if (!draw) return '';
  return `<svg viewBox="0 0 44 44" width="${size}" height="${size}" role="img"
    aria-label="${CONDITIONS[code]?.label || code}">${draw()}</svg>`;
}

/** 아이콘 + 글씨 배지 (스타일은 style.css의 .cond-badge) */
export function conditionBadge(code, size = 22) {
  const c = CONDITIONS[code];
  if (!c) return '';
  return `<span class="cond-badge cond-${c.severity}">${conditionIcon(code, size)}<span>${c.label}</span></span>`;
}
