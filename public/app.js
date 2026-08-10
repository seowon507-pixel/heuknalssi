// app.js — 귀농이 프론트엔드
// 그림은 전부 아래 "일러스트 라이브러리"에서 코드로 그립니다.
// (외부 이미지 없음 → 어떤 화면에서도 스타일이 어긋나지 않음)

import { CONDITIONS, conditionIcon, conditionBadge } from './conditions.js';
import { buildAnalysisViewModel } from './analysis-model.js';
import { assessSuitability } from './analysis.js';
import { currentDayPeriod } from './day-period.js';

/* ════════════════════════════════════════════
   1. 일러스트 라이브러리 (SVG)
   좌표계: viewBox 0 0 260 288, 지면 y≈227, 식물 기준점 (130, 227)
════════════════════════════════════════════ */

const INK = '#4b4237';

// 작물별 그림 팔레트
const CP = {
  lettuce:  { leaf: '#9cb873', deep: '#748f50', light: '#c3d29d' },
  cucumber: { leaf: '#8aab63', deep: '#5e7c41', light: '#aac186', body: '#7fa05b' },
  potato:   { leaf: '#8ca86b', deep: '#68854b', light: '#aec28c', tuber: '#b39062', tuberDeep: '#8a6c47' },
  apple:    { leaf: '#87a465', deep: '#647f47', light: '#a8bf88', fruit: '#c4705a', fruitDeep: '#9e5240', trunk: '#8a6b4d', trunkDeep: '#6b5138', blossom: '#f6e9e4' },
  pear:     { leaf: '#93af72', deep: '#6d884d', light: '#b3c692', fruit: '#dcb56e', fruitDeep: '#a67f45', trunk: '#8a6b4d', trunkDeep: '#6b5138', blossom: '#f8f3e3' },
};

/* ── 조각 그리기 도우미 ── */

// 잎: (x,y)에서 ang 방향(도)으로 len 길이, w 폭의 물방울 잎
function leaf(x, y, len, w, ang, fill, stroke) {
  return `<g transform="translate(${x} ${y}) rotate(${ang})">
    <path d="M0 0 Q ${len * 0.42} ${-w} ${len} -1 Q ${len * 0.45} ${w * 0.9} 0 0 Z"
      fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M${len * 0.14} 0 Q ${len * 0.5} ${-w * 0.2} ${len * 0.78} -1"
      fill="none" stroke="${stroke}" stroke-width="1" opacity=".4"/>
  </g>`;
}

function stem(d, color, w = 3) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}

// 얼굴 — mood에 따라 표정이 바뀜
//   happy(양호): 점 눈 + 미소 + 발그레
//   sad(주의): 처진 눈썹 + 시무룩한 입
//   danger(위험): X자 눈 + 덜덜 떠는 입 + 식은땀
function face(x, y, s = 1, mood = 'happy') {
  if (mood === 'danger') {
    const xEye = (cx) => `
      <line x1="${cx - 1.9 * s}" y1="${y - 1.9 * s}" x2="${cx + 1.9 * s}" y2="${y + 1.9 * s}"/>
      <line x1="${cx + 1.9 * s}" y1="${y - 1.9 * s}" x2="${cx - 1.9 * s}" y2="${y + 1.9 * s}"/>`;
    return `<g>
      <g stroke="${INK}" stroke-width="${1.6 * s}" stroke-linecap="round">
        ${xEye(x - 6 * s)}${xEye(x + 6 * s)}
      </g>
      <path d="M ${x - 3.4 * s} ${y + 5.2 * s} q ${1.7 * s} ${-2.2 * s} ${3.4 * s} 0 q ${1.7 * s} ${2.2 * s} ${3.4 * s} 0"
        fill="none" stroke="${INK}" stroke-width="${1.4 * s}" stroke-linecap="round"/>
      <path d="M ${x + 11 * s} ${y - 7 * s} q ${3 * s} ${3.6 * s} 0 ${5.4 * s} q ${-3 * s} ${-1.8 * s} 0 ${-5.4 * s} Z"
        fill="#a9c2d2" stroke="#7f9cb0" stroke-width="${1.1 * s}"/>
    </g>`;
  }
  if (mood === 'sad') {
    return `<g>
      <circle cx="${x - 6 * s}" cy="${y}" r="${1.9 * s}" fill="${INK}"/>
      <circle cx="${x + 6 * s}" cy="${y}" r="${1.9 * s}" fill="${INK}"/>
      <path d="M ${x - 8.8 * s} ${y - 4.6 * s} l ${4.2 * s} ${1.6 * s} M ${x + 8.8 * s} ${y - 4.6 * s} l ${-4.2 * s} ${1.6 * s}"
        stroke="${INK}" stroke-width="${1.3 * s}" stroke-linecap="round" fill="none"/>
      <path d="M ${x - 2.6 * s} ${y + 6 * s} q ${2.6 * s} ${-2.4 * s} ${5.2 * s} 0"
        fill="none" stroke="${INK}" stroke-width="${1.4 * s}" stroke-linecap="round"/>
      <ellipse cx="${x - 10 * s}" cy="${y + 3.6 * s}" rx="${2.7 * s}" ry="${1.6 * s}" fill="#c9825b" opacity=".18"/>
      <ellipse cx="${x + 10 * s}" cy="${y + 3.6 * s}" rx="${2.7 * s}" ry="${1.6 * s}" fill="#c9825b" opacity=".18"/>
    </g>`;
  }
  return `<g>
    <circle cx="${x - 6 * s}" cy="${y}" r="${1.9 * s}" fill="${INK}"/>
    <circle cx="${x + 6 * s}" cy="${y}" r="${1.9 * s}" fill="${INK}"/>
    <path d="M ${x - 2.6 * s} ${y + 4.2 * s} q ${2.6 * s} ${2.4 * s} ${5.2 * s} 0"
      fill="none" stroke="${INK}" stroke-width="${1.4 * s}" stroke-linecap="round"/>
    <ellipse cx="${x - 10 * s}" cy="${y + 3.6 * s}" rx="${2.7 * s}" ry="${1.6 * s}" fill="#c9825b" opacity=".3"/>
    <ellipse cx="${x + 10 * s}" cy="${y + 3.6 * s}" rx="${2.7 * s}" ry="${1.6 * s}" fill="#c9825b" opacity=".3"/>
  </g>`;
}

// 다섯 잎 꽃
function flower5(x, y, r, petal, center) {
  let p = '';
  for (let i = 0; i < 5; i++) {
    p += `<ellipse cx="0" cy="${-r * 0.62}" rx="${r * 0.34}" ry="${r * 0.52}"
      fill="${petal}" stroke="${INK}" stroke-width="1.1" opacity=".95"
      transform="rotate(${i * 72})"/>`;
  }
  return `<g transform="translate(${x} ${y})">${p}
    <circle r="${r * 0.26}" fill="${center}" stroke="${INK}" stroke-width="1"/>
  </g>`;
}

function sparkle(x, y, s = 1, color = '#dcbc5f') {
  return `<g stroke="${color}" stroke-width="${1.6 * s}" stroke-linecap="round" opacity=".85">
    <line x1="${x - 4 * s}" y1="${y}" x2="${x + 4 * s}" y2="${y}"/>
    <line x1="${x}" y1="${y - 4 * s}" x2="${x}" y2="${y + 4 * s}"/>
  </g>`;
}

function dew(x, y, s = 1) {
  return `<g>
    <path d="M${x} ${y - 5 * s} q ${4 * s} ${4.6 * s} 0 ${7 * s} q ${-4 * s} ${-2.4 * s} 0 ${-7 * s} Z"
      fill="#a9c2d2" stroke="#7f9cb0" stroke-width="1.2"/>
    <circle cx="${x - 1.1 * s}" cy="${y - 0.4 * s}" r="${0.9 * s}" fill="#fff" opacity=".8"/>
  </g>`;
}

function tuft(x, y, flip = 1) {
  return `<g stroke="#8f9d72" stroke-width="1.6" stroke-linecap="round" fill="none">
    <path d="M${x} ${y} q ${-3 * flip} -7 ${-6 * flip} -9"/>
    <path d="M${x + 3 * flip} ${y} q 0 -8 ${1 * flip} -11"/>
    <path d="M${x + 6 * flip} ${y} q ${3 * flip} -6 ${6 * flip} -8"/>
  </g>`;
}

function cloudArt(x, y, s = 1, { fill = '#eef0e6', line = '#a9b0a0', rain = true } = {}) {
  const drops = rain
    ? `<g stroke="#90a9ba" stroke-width="1.6" stroke-linecap="round" opacity=".8">
        <line x1="-12" y1="16" x2="-14" y2="22"/>
        <line x1="0" y1="18" x2="-2" y2="24"/>
        <line x1="12" y1="16" x2="10" y2="22"/>
      </g>`
    : '';
  return `<g transform="translate(${x} ${y}) scale(${s})" opacity=".9">
    <path d="M-20 8 q-8 0 -8 -7 q0 -8 8 -8 q2 -8 11 -8 q8 0 11 6 q9 -1 11 6 q2 8 -6 11 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.6" stroke-linejoin="round"/>
    ${drops}
  </g>`;
}

function sunArt(x, y, r = 13, fill = '#f2dfa0', stroke = '#d8b856') {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * 45 * Math.PI) / 180;
    rays += `<line x1="${x + Math.cos(a) * (r + 4)}" y1="${y + Math.sin(a) * (r + 4)}"
      x2="${x + Math.cos(a) * (r + 9)}" y2="${y + Math.sin(a) * (r + 9)}"/>`;
  }
  return `<g class="celestial-sun">
    <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>
    <g stroke="${stroke}" stroke-width="1.6" stroke-linecap="round">${rays}</g>
  </g>`;
}

// 초승달 — 밤하늘에 뜸
function moonArt(x, y, r = 12) {
  return `<g class="celestial-moon">
    <path d="M ${x} ${y - r} A ${r} ${r} 0 1 1 ${x} ${y + r} A ${r * 1.3} ${r * 1.3} 0 0 0 ${x} ${y - r} Z"
      fill="#ecdfa8" stroke="#c9b370" stroke-width="1.6" stroke-linejoin="round"/>
  </g>`;
}

// 지평선 부근의 빛 번짐 — 노을·새벽 하늘의 아랫부분을 물들임
function horizonGlow(color, opacity) {
  return `<ellipse cx="130" cy="236" rx="160" ry="64" fill="${color}" opacity="${opacity}"/>`;
}

// 지면(흙 두둑 + 자갈 + 풀)
function ground() {
  return `
  <path d="M14,241 Q75,225 130,227 Q186,224 246,241 L246,290 L14,290 Z" fill="#a3855f"/>
  <path d="M14,241 Q75,225 130,227 Q186,224 246,241" fill="none" stroke="#7c6347" stroke-width="2"/>
  <g fill="#7c6347" opacity=".55">
    <circle cx="78" cy="248" r="2"/><circle cx="102" cy="258" r="1.5"/>
    <circle cx="160" cy="252" r="2"/><circle cx="190" cy="246" r="1.4"/>
    <circle cx="128" cy="266" r="1.7"/><circle cx="60" cy="260" r="1.4"/>
  </g>
  ${tuft(52, 236, 1)}
  ${tuft(196, 234, -1)}`;
}

/* ── 성장 단계별 그림 ── */

function seedArt(cropId, mood = 'happy') {
  const c = CP[cropId];
  let seed, seedFace;
  if (cropId === 'potato') {
    seed = `<path d="M111 206 q-9 11 -1.5 20 q8.5 10 22 5.5 q12.5 -4 10.5 -15.5 q-2 -12.5 -15.5 -15 q-11 -2 -15.5 5 Z"
      fill="${c.tuber}" stroke="${c.tuberDeep}" stroke-width="2.2"/>
      ${stem('M137 206 q4 -6 1.5 -10', c.deep, 2.2)}`;
    seedFace = face(128, 218, 0.72, mood);
  } else if (cropId === 'apple' || cropId === 'pear') {
    seed = `<path d="M130 198 C142.5 208 140.5 226 130 231 C119.5 226 117.5 208 130 198 Z"
      fill="#b08d5f" stroke="#6b5138" stroke-width="2.2"/>`;
    seedFace = face(130, 217, 0.68, mood);
  } else {
    const fill = cropId === 'cucumber' ? '#e3d9b4' : '#d9cba4';
    const line = cropId === 'cucumber' ? '#a99a6d' : '#8a7a54';
    seed = `<ellipse cx="130" cy="213" rx="11.5" ry="16.5" fill="${fill}" stroke="${line}"
      stroke-width="2.2" transform="rotate(8 130 213)"/>`;
    seedFace = face(130, 214, 0.68, mood);
  }
  return `
    <ellipse cx="130" cy="230" rx="20" ry="6" fill="#5f4c36" opacity=".3"/>
    ${seed}
    ${seedFace}
    ${sparkle(98, 196, 0.9)}
    ${sparkle(165, 188, 0.75)}`;
}

function sproutArt(cropId, mood = 'happy') {
  const c = CP[cropId];
  return `
    ${stem('M130 228 q -2 -12 1 -22', c.deep)}
    ${leaf(131, 205, 27, 9.5, -152, c.leaf, c.deep)}
    ${leaf(131, 205, 27, 9.5, -28, c.leaf, c.deep)}
    <circle cx="131" cy="199" r="7" fill="${c.light}" stroke="${c.deep}" stroke-width="1.8"/>
    ${face(131, 199, 0.55, mood)}`;
}

function seedlingArt(cropId, mood = 'happy') {
  const c = CP[cropId];
  return `
    ${stem('M130 228 q -3 -18 0 -38', c.deep)}
    ${leaf(130, 213, 31, 11, -158, c.leaf, c.deep)}
    ${leaf(130, 213, 31, 11, -22, c.leaf, c.deep)}
    ${leaf(130, 199, 25, 9, -128, c.leaf, c.deep)}
    ${leaf(130, 199, 25, 9, -52, c.leaf, c.deep)}
    <circle cx="130" cy="187" r="7.5" fill="${c.light}" stroke="${c.deep}" stroke-width="1.8"/>
    ${face(130, 187, 0.6, mood)}
    ${dew(154, 206, 0.9)}`;
}

// 상추 잎 한 장: 위쪽 가장자리가 물결치는(주름진) 잎
function lettuceLeaf(x, y, h, w, ang, fill, line) {
  return `<g transform="translate(${x} ${y}) rotate(${ang})">
    <path d="M0 0
      C ${-w * 1.05} ${-h * 0.2} ${-w * 1.1} ${-h * 0.55} ${-w * 0.72} ${-h * 0.74}
      Q ${-w * 0.82} ${-h * 0.96} ${-w * 0.38} ${-h * 0.88}
      Q ${-w * 0.32} ${-h * 1.12} 0 ${-h * 0.97}
      Q ${w * 0.32} ${-h * 1.12} ${w * 0.38} ${-h * 0.88}
      Q ${w * 0.82} ${-h * 0.96} ${w * 0.72} ${-h * 0.74}
      C ${w * 1.1} ${-h * 0.55} ${w * 1.05} ${-h * 0.2} 0 0 Z"
      fill="${fill}" stroke="${line}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M0 ${-h * 0.08} Q ${-w * 0.08} ${-h * 0.5} 0 ${-h * 0.82}"
      fill="none" stroke="${line}" stroke-width="1.2" opacity=".4"/>
  </g>`;
}

// 상추: 속이 차지 않는 잎상추 — 주름진 잎들이 위로 펼쳐진 다발
function rosetteArt(big, mood = 'happy') {
  const c = CP.lettuce;
  if (!big) {
    // growing: 아직 작은 잎 다발
    return `
      ${lettuceLeaf(114, 227, 44, 12, -14, c.leaf, c.deep)}
      ${lettuceLeaf(146, 227, 44, 12, 14, c.leaf, c.deep)}
      ${lettuceLeaf(130, 227, 52, 13, 0, c.leaf, c.deep)}
      ${lettuceLeaf(130, 227, 36, 11, 0, c.light, c.deep)}
      ${face(130, 207, 0.72, mood)}`;
  }
  // mature: 뒷잎(진한색) + 앞잎(연한색), 얼굴은 앞 가운데 잎에
  return `
    ${lettuceLeaf(106, 227, 58, 14, -18, c.leaf, c.deep)}
    ${lettuceLeaf(154, 227, 58, 14, 18, c.leaf, c.deep)}
    ${lettuceLeaf(117, 227, 68, 15, -8, c.leaf, c.deep)}
    ${lettuceLeaf(143, 227, 68, 15, 8, c.leaf, c.deep)}
    ${lettuceLeaf(130, 227, 74, 16, 0, c.leaf, c.deep)}
    ${lettuceLeaf(119, 227, 46, 13, -10, c.light, c.deep)}
    ${lettuceLeaf(141, 227, 46, 13, 10, c.light, c.deep)}
    ${lettuceLeaf(130, 227, 52, 14, 0, c.light, c.deep)}
    ${face(130, 202, 1, mood)}
    ${sparkle(174, 166, 0.9)}`;
}

// 감자: 덤불 — stage: 'leafing'(잎 성장) | 'bulking'(감자 비대) | 'mature'(수확)
function potatoBushArt(stage, mood = 'happy') {
  const c = CP.potato;
  const mature = stage === 'mature';
  const s = mature ? 1.15 : stage === 'bulking' ? 1 : 0.8;
  const stems = `
    ${stem(`M130 228 q ${-13 * s} -22 ${-21 * s} ${-38 * s}`, c.deep)}
    ${stem(`M130 228 q 0 -24 0 ${-42 * s}`, c.deep)}
    ${stem(`M130 228 q ${13 * s} -22 ${21 * s} ${-38 * s}`, c.deep)}`;
  const leaves = `
    ${leaf(109 - 8 * (s - 1) * 10, 192, 21, 8, -148, c.leaf, c.deep)}
    ${leaf(112, 205, 19, 7.5, -170, c.leaf, c.deep)}
    ${leaf(130, 188 - 8 * (s - 1) * 5, 20, 8, -90, c.light, c.deep)}
    ${leaf(130, 204, 19, 7.5, -35, c.leaf, c.deep)}
    ${leaf(148, 205, 19, 7.5, -10, c.leaf, c.deep)}
    ${leaf(151, 192, 21, 8, -32, c.leaf, c.deep)}
    ${leaf(120, 196, 18, 7, -115, c.leaf, c.deep)}
    ${leaf(141, 196, 18, 7, -65, c.light, c.deep)}`;
  const flowers = mature
    ? `${flower5(109, 186, 6.5, '#f2ecdd', '#dcbc5f')}
       ${flower5(151, 186, 6.5, '#f2ecdd', '#dcbc5f')}
       ${flower5(130, 178, 7, '#f2ecdd', '#dcbc5f')}`
    : '';
  const tubers = mature
    ? `<g>
        <ellipse cx="104" cy="234" rx="13" ry="10" fill="${c.tuber}" stroke="${c.tuberDeep}" stroke-width="2"/>
        <circle cx="100" cy="231" r="1.3" fill="${c.tuberDeep}"/>
        <circle cx="109" cy="236" r="1.3" fill="${c.tuberDeep}"/>
        <ellipse cx="157" cy="236" rx="15" ry="11.5" fill="${c.tuber}" stroke="${c.tuberDeep}" stroke-width="2"/>
        ${face(157, 233, 0.82, mood)}
      </g>`
    : stage === 'bulking'
      // 감자 비대: 흙 위로 빼꼼 나온 아기 감자에 얼굴
      ? `<ellipse cx="146" cy="236" rx="10" ry="7.5" fill="${c.tuber}" stroke="${c.tuberDeep}" stroke-width="2"/>
         ${face(146, 234, 0.6, mood)}`
      // 잎 성장: 가운데 줄기 끝 둥근 순에 얼굴
      : `<circle cx="130" cy="196" r="7.5" fill="${c.light}" stroke="${c.deep}" stroke-width="1.8"/>
         ${face(130, 196, 0.6, mood)}`;
  return stems + leaves + flowers + tubers;
}

// 오이: 덩굴+꽃 (flower 단계) / 듬직한 오이 (mature)
function cucumberFlowerArt(mood = 'happy') {
  const c = CP.cucumber;
  return `
    ${stem('M130 228 C 126 202 140 186 134 164', c.deep)}
    ${leaf(128, 202, 40, 15, -162, c.leaf, c.deep)}
    ${leaf(133, 184, 29, 11, -26, c.leaf, c.deep)}
    ${stem('M134 172 q 15 -4 14 -14 q -1 -9 -9 -7 q -7 2 -4 8', c.deep, 1.8)}
    <ellipse cx="121" cy="170" rx="3.4" ry="5" fill="#dcbc5f" stroke="#b3903a" stroke-width="1.3" transform="rotate(-24 121 170)"/>
    ${flower5(134, 158, 9.5, '#e8ce74', '#b3903a')}
    ${stem('M133 190 q 8 2 11 7', c.deep, 1.6)}
    <rect x="139" y="195" width="13" height="26" rx="6.5" fill="${c.body}" stroke="${c.deep}" stroke-width="2"
      transform="rotate(8 145.5 208)"/>
    ${face(146, 204, 0.52, mood)}
    ${dew(106, 190, 0.9)}`;
}

// 오이 열매 단계: 덩굴에 오이 두 개가 매달림 (큰 쪽에 얼굴)
function cucumberFruitArt(mood = 'happy') {
  const c = CP.cucumber;
  return `
    ${stem('M130 228 C 123 198 143 180 134 150', c.deep)}
    ${leaf(126, 198, 44, 16, -164, c.leaf, c.deep)}
    ${leaf(134, 172, 32, 12, -24, c.leaf, c.deep)}
    ${leaf(129, 156, 26, 10, -140, c.light, c.deep)}
    ${stem('M134 156 q 14 -4 13 -13 q -1 -8 -8 -6 q -6 2 -3 7', c.deep, 1.7)}
    ${flower5(136, 144, 7, '#e8ce74', '#b3903a')}
    ${stem('M132 188 q -9 3 -12 10', c.deep, 1.8)}
    <rect x="109" y="196" width="18" height="36" rx="9" fill="${c.body}" stroke="${c.deep}" stroke-width="2.2"
      transform="rotate(-7 118 214)"/>
    <g fill="${c.deep}" opacity=".45">
      <circle cx="114" cy="208" r="1.1"/><circle cx="122" cy="218" r="1.1"/><circle cx="118" cy="226" r="1.1"/>
    </g>
    ${face(118, 208, 0.62, mood)}
    ${stem('M136 174 q 9 3 11 9', c.deep, 1.6)}
    <rect x="141" y="181" width="12" height="25" rx="6" fill="${c.body}" stroke="${c.deep}" stroke-width="2"
      transform="rotate(8 147 193)"/>
    ${dew(102, 186, 0.9)}`;
}

function cucumberMatureArt(mood = 'happy') {
  const c = CP.cucumber;
  return `
    ${leaf(102, 227, 60, 21, -124, c.leaf, c.deep)}
    ${leaf(156, 227, 40, 14, -48, c.leaf, c.deep)}
    <g>
      <rect x="112" y="148" width="38" height="82" rx="19"
        fill="${c.body}" stroke="${c.deep}" stroke-width="2.5"
        transform="rotate(-4 131 189)"/>
      <g fill="${c.deep}" opacity=".45">
        <circle cx="120" cy="164" r="1.4"/><circle cx="140" cy="172" r="1.4"/>
        <circle cx="124" cy="196" r="1.4"/><circle cx="142" cy="206" r="1.4"/>
        <circle cx="128" cy="220" r="1.4"/><circle cx="116" cy="184" r="1.4"/>
      </g>
      ${face(129, 172, 1.05, mood)}
    </g>
    ${stem('M146 156 q 16 -6 15 -17 q -1 -10 -10 -8 q -8 2 -4 9', c.deep, 1.8)}
    ${flower5(128, 143, 8.5, '#e8ce74', '#b3903a')}
    ${sparkle(170, 160, 0.9)}
    ${sparkle(92, 172, 0.75)}`;
}

// 나무형(사과·배): sapling → blossom → fruit → mature
function canopyPath(cx, cy, w, h) {
  return `M ${cx - w} ${cy}
    C ${cx - w} ${cy - h * 0.55}, ${cx - w * 0.6} ${cy - h * 0.95}, ${cx - w * 0.32} ${cy - h * 0.78}
    C ${cx - w * 0.28} ${cy - h * 1.2}, ${cx + w * 0.28} ${cy - h * 1.2}, ${cx + w * 0.32} ${cy - h * 0.78}
    C ${cx + w * 0.6} ${cy - h * 0.95}, ${cx + w} ${cy - h * 0.55}, ${cx + w} ${cy}
    C ${cx + w} ${cy + h * 0.42}, ${cx - w} ${cy + h * 0.42}, ${cx - w} ${cy} Z`;
}

// 사과: 위가 살짝 파인 붉은 열매 + 꼭지 잎
function appleFruit(x, y, c) {
  return `<g>
    <path d="M${x - 7} ${y} a7 7 0 1 0 14 0 a7 7.4 0 0 0 -5.6 -7 q-1.4 0.9 -2.8 0 a7 7.4 0 0 0 -5.6 7 Z"
      fill="${c.fruit}" stroke="${c.fruitDeep}" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M${x - 3.6} ${y - 3} q0.6 -1.8 2 -2.6" fill="none" stroke="#eccabb" stroke-width="1.4"
      stroke-linecap="round" opacity=".9"/>
    <line x1="${x}" y1="${y - 6.4}" x2="${x}" y2="${y - 10}" stroke="${c.trunkDeep}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M${x + 0.5} ${y - 9} q3.6 -2.6 5.6 0 q-2.8 2.4 -5.6 0 Z"
      fill="${c.leaf}" stroke="${c.deep}" stroke-width="1.2" stroke-linejoin="round"/>
  </g>`;
}

// 배: 한국 배(신고배) — 둥글고 황갈색, 과점(작은 반점)이 있음
function pearFruit(x, y, c) {
  return `<g>
    <circle cx="${x}" cy="${y}" r="7.2" fill="${c.fruit}" stroke="${c.fruitDeep}" stroke-width="1.8"/>
    <g fill="${c.fruitDeep}" opacity=".5">
      <circle cx="${x - 2.6}" cy="${y - 1.4}" r="0.75"/>
      <circle cx="${x + 2.2}" cy="${y + 1.2}" r="0.75"/>
      <circle cx="${x - 0.4}" cy="${y + 3.2}" r="0.75"/>
      <circle cx="${x + 2.9}" cy="${y - 2.7}" r="0.75"/>
      <circle cx="${x - 3.4}" cy="${y + 1.8}" r="0.75"/>
    </g>
    <path d="M${x - 3.4} ${y - 3.4} q0.7 -1.6 2.2 -2.3" fill="none" stroke="#f0dcae" stroke-width="1.3"
      stroke-linecap="round" opacity=".9"/>
    <line x1="${x}" y1="${y - 7.2}" x2="${x}" y2="${y - 10.5}" stroke="${c.trunkDeep}" stroke-width="1.6" stroke-linecap="round"/>
  </g>`;
}

function treeArt(cropId, stageKey, mood = 'happy') {
  const c = CP[cropId];
  if (stageKey === 'sapling') {
    return `
      ${stem('M130 228 q -2 -16 1 -32', c.trunk, 4.5)}
      ${stem('M130 212 q -8 -4 -12 -10', c.trunk, 3)}
      ${leaf(118, 202, 17, 7, -145, c.leaf, c.deep)}
      ${leaf(131, 199, 17, 7, -25, c.leaf, c.deep)}
      <circle cx="130" cy="192" r="8" fill="${c.light}" stroke="${c.deep}" stroke-width="1.8"/>
      ${face(130, 192, 0.6, mood)}`;
  }
  // 어린 나무: 묘목보다 크고 성목보다 작은, 갓 우거지기 시작한 나무
  if (stageKey === 'young') {
    return `
      ${stem('M130 228 q -2 -18 1 -34', c.trunk, 5)}
      ${stem('M130 210 q -9 -5 -13 -11', c.trunk, 3)}
      <path d="${canopyPath(130, 194, 25, 19)}"
        fill="${c.leaf}" stroke="${c.deep}" stroke-width="2.2" stroke-linejoin="round"/>
      ${leaf(108, 200, 13, 5.5, -160, c.light, c.deep)}
      ${face(130, 189, 0.64, mood)}`;
  }
  const mature = stageKey === 'mature';
  const w = mature ? 46 : 36, h = mature ? 36 : 28;
  const cy = mature ? 176 : 184;
  const trunk = mature
    ? `${stem('M130 228 q -3 -22 1 -44', c.trunk, 6)}
       ${stem('M130 206 q -12 -6 -18 -14', c.trunk, 3.5)}
       ${stem('M130 198 q 12 -6 17 -13', c.trunk, 3.5)}`
    : `${stem('M130 228 q -3 -20 1 -40', c.trunk, 5)}
       ${stem('M130 206 q -10 -5 -15 -12', c.trunk, 3)}`;
  const canopy = `<path d="${canopyPath(130, cy, w, h)}"
    fill="${c.leaf}" stroke="${c.deep}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M${130 - w * 0.5} ${cy - h * 0.35} q ${w * 0.5} ${-h * 0.4} ${w} 0"
      fill="none" stroke="${c.deep}" stroke-width="1.2" opacity=".35"/>`;
  let deco = '';
  if (stageKey === 'grown') {
    // 성목: 다 자란 수형, 아직 꽃·열매는 없음
    deco = `${leaf(103, 180, 12, 5, -165, c.light, c.deep)}
      ${face(128, 172, 0.72, mood)}`;
  } else if (stageKey === 'blossom') {
    deco = `${flower5(112, 174, 6, c.blossom, '#dcbc5f')}
      ${flower5(147, 170, 6, c.blossom, '#dcbc5f')}
      ${flower5(140, 186, 5.5, c.blossom, '#dcbc5f')}
      ${face(128, 172, 0.72, mood)}`;
  } else if (stageKey === 'fruit' || mature) {
    const F = cropId === 'apple' ? appleFruit : pearFruit;
    deco = mature
      ? `${F(110, 172, c)}${F(150, 168, c)}${F(130, 188, c)}
         ${flower5(142, 150, 5.5, c.blossom, '#dcbc5f')}
         ${face(130, 152, 0.9, mood)}
         ${sparkle(172, 148, 0.9)}`
      : `${F(114, 178, c)}${F(146, 174, c)}
         ${face(130, 164, 0.72, mood)}`;
  }
  return trunk + canopy + deco;
}

// 작물+단계 → 그림 조각 (mood = 얼굴 표정: happy | sad | danger — 전 단계 적용)
function plantArt(cropId, stageKey, mood = 'happy') {
  if (stageKey === 'seed') return seedArt(cropId, mood);
  if (stageKey === 'sprout') return sproutArt(cropId, mood);
  if (stageKey === 'seedling') return seedlingArt(cropId, mood);
  switch (cropId) {
    case 'lettuce':
      return rosetteArt(stageKey === 'mature', mood);
    case 'potato':
      return potatoBushArt(stageKey, mood); // leafing | bulking | mature
    case 'cucumber':
      if (stageKey === 'flower') return cucumberFlowerArt(mood);
      if (stageKey === 'fruit') return cucumberFruitArt(mood);
      return cucumberMatureArt(mood);
    case 'apple':
    case 'pear':
      return treeArt(cropId, stageKey, mood); // sapling | young | grown | blossom | fruit | mature
  }
  return sproutArt(cropId, mood);
}

let uid = 0;
// 단계가 오를수록 화면을 채우도록 그림 배율을 키움 (기준점: 지면 (130,227))
const STAGE_SCALE = {
  seed: 1, sprout: 1.15, seedling: 1.22, sapling: 1.22,
  young: 1.26, grown: 1.3, leafing: 1.24, bulking: 1.3,
  growing: 1.3, flower: 1.28, blossom: 1.32, fruit: 1.34, mature: 1.4,
};

// 원형 장면 전체 (mood: 'wait' 비 오기 전 / 'done' 돌봄 완료 / 'none')
function plantScene(cropId, stageKey, mood = 'none') {
  const id = `vg${++uid}`;
  const t = timeLayer();
  // 해·달은 시각에 따라 celestialArt가 그림 — 여기서는 기분 연출만 더함
  const ambient =
    mood === 'wait' ? cloudArt(78, 78, 1)
    : mood === 'done' ? sparkle(70, 110, 0.8, '#c9b98a')
    : '';
  const sway = stageKey === 'seed' ? '' : 'class="sway"';
  const s = STAGE_SCALE[stageKey] || 1.2;
  return `<svg viewBox="0 0 260 288" role="img" aria-label="키우는 작물" class="${t.cls}">
    <defs><clipPath id="${id}"><ellipse cx="130" cy="144" rx="112" ry="130"/></clipPath></defs>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="${t.sky || '#fbf8ef'}"/>
    <g clip-path="url(#${id})">
      <path d="M10,216 Q130,197 250,216" fill="none" stroke="#e3dbc4" stroke-width="1.6"/>
      ${t.air}${celestialArt()}${ambient}
      ${ground()}
      <g ${sway}><g transform="translate(130 227) scale(${s}) translate(-130 -227)">
        ${plantArt(cropId, stageKey)}
      </g></g>
      ${t.tint}
    </g>
    ${frameDecor()}
  </svg>`;
}

// 선택 카드/기록/다이어리용 작은 초상 (단계 지정 가능, 기본은 다 자란 모습)
function cropPortrait(cropId, stageKey = 'mature') {
  const s = STAGE_SCALE[stageKey] || 1.2;
  return `<svg viewBox="40 88 180 198">
    ${ground()}
    <g transform="translate(130 227) scale(${s}) translate(-130 -227)">${plantArt(cropId, stageKey)}</g>
  </svg>`;
}

/* ── 밭 상태(날씨·토양) 연출 — conditions.js의 상태 코드를 정원 장면에 입힘 ──
   ※ 아직 대시보드에는 연결하지 않음. 미리보기: /conditions-preview.html */

function snowflakeSceneArt(cx, cy, r, color = '#8fb0c4') {
  let arms = '';
  for (let i = 0; i < 3; i++) {
    const a = (i * 60 * Math.PI) / 180;
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
    arms += `<line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}"/>`;
    for (const t of [0.6, -0.6]) {
      const px = cx + dx * t, py = cy + dy * t;
      const b = a + Math.PI / 2;
      arms += `<line x1="${px - Math.cos(b) * r * 0.22}" y1="${py - Math.sin(b) * r * 0.22}"
        x2="${px + Math.cos(b) * r * 0.22}" y2="${py + Math.sin(b) * r * 0.22}"/>`;
    }
  }
  return `<g stroke="${color}" stroke-width="1.7" stroke-linecap="round">${arms}</g>`;
}

function heatWavesArt(x, y, s = 1) {
  return `<g stroke="#d8a256" stroke-width="${2 * s}" stroke-linecap="round" fill="none" opacity=".85">
    <path d="M${x} ${y} q5 -5 10 0 q5 5 10 0"/>
    <path d="M${x + 4} ${y + 11} q5 -5 10 0 q5 5 10 0"/>
  </g>`;
}

function thermometerArt(x, y, s = 1, danger = false) {
  const mercury = danger ? '#c85c46' : '#d98a43';
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="-6.5" y="-28" width="13" height="38" rx="6.5"
      fill="#fffaf0" stroke="#9b7b5d" stroke-width="1.8"/>
    <circle cx="0" cy="14" r="10" fill="#fffaf0" stroke="#9b7b5d" stroke-width="1.8"/>
    <rect x="-2.4" y="-20" width="4.8" height="31" rx="2.4" fill="${mercury}"/>
    <circle cx="0" cy="14" r="6.2" fill="${mercury}"/>
    <g stroke="#9b7b5d" stroke-width="1.4" stroke-linecap="round">
      <line x1="8.5" y1="-18" x2="13" y2="-18"/>
      <line x1="8.5" y1="-9" x2="12" y2="-9"/>
      <line x1="8.5" y1="0" x2="13" y2="0"/>
    </g>
  </g>`;
}

function soilCracksArt() {
  return `<g stroke="#5f4c36" stroke-width="2" stroke-linecap="round" fill="none" opacity=".8">
    <path d="M84 244 l-9 15"/>
    <path d="M130 240 v17 M130 249 l9 7"/>
    <path d="M176 244 l11 13"/>
    <path d="M105 253 l-6 10"/>
  </g>`;
}

function rippleArt(cx, cy) {
  return `<g stroke="#8fa9ba" stroke-width="1.6" fill="none" opacity=".8">
    <ellipse cx="${cx}" cy="${cy}" rx="13" ry="4"/>
    <ellipse cx="${cx}" cy="${cy}" rx="6" ry="1.8"/>
  </g>`;
}

function phDropArt(x, y, s = 1) {
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M0 -14 C5.5 -6 9 -1 9 5 a9 9 0 0 1 -18 0 C-9 -1 -5.5 -6 0 -14 Z"
      fill="#a9c2d2" stroke="#7f9cb0" stroke-width="1.8" stroke-linejoin="round"/>
    <text x="0" y="9" text-anchor="middle" font-size="10.5" fill="${INK}"
      font-family="'Gowun Dodum', sans-serif">pH</text>
  </g>`;
}

// 애니메이션 도우미 — 요소를 클래스/딜레이가 붙은 그룹으로 감쌈
// (안쪽 요소의 transform 속성과 충돌하지 않도록 바깥 그룹에서 CSS 애니메이션)
function fx(cls, inner, delay = 0, dur = null) {
  const style = [];
  if (delay) style.push(`animation-delay:${delay}s`);
  if (dur) style.push(`animation-duration:${dur}s`);
  return `<g class="fx ${cls}"${style.length ? ` style="${style.join(';')}"` : ''}>${inner}</g>`;
}

/* ── 시간 로직: 실제 시각에 따른 하늘 분위기와 해·달의 위치 ──
   날씨 로직(CONDITION_FX)과는 분리되어 있음 — 시간은 "해가 어디에 있는가"를,
   날씨는 "해가 보이는가(구름에 가렸는가)"를 각각 결정한다.
   시연·검수용으로 ?hour=22 나 ?hour=7.5 처럼 시각을 강제할 수 있음 */
const FORCED_HOUR = Number(new URLSearchParams(location.search).get('hour'));

function currentHour() {
  if (Number.isFinite(FORCED_HOUR)) return FORCED_HOUR;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

function timeOfDay(hour = currentHour()) {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'sunset';
  return 'night';
}

// 해는 6시에 동쪽(왼쪽) 지평선에서 떠서 남중을 지나 19시에 서쪽(오른쪽)으로 진다.
// 그 밖의 시각에는 달이 같은 궤적으로 밤하늘을 가로지른다.
// 지평선 근처의 해는 크고 주홍빛(노을·아침놀), 높이 뜬 해는 노란빛.
const SUNRISE = 6, SUNSET_H = 19;

function celestialArt(sunScale = 1) {
  const h = currentHour();
  if (h >= SUNRISE && h < SUNSET_H) {
    const p = (h - SUNRISE) / (SUNSET_H - SUNRISE); // 0=동쪽 지평선, 1=서쪽 지평선
    const x = 52 + p * 156;
    const y = 224 - Math.sin(p * Math.PI) * 152;
    // 7시 이전(뜰 무렵)·17시 이후(질 무렵)에만 주홍빛 — 시간대 구분과 일치
    const nearHorizon = p < 0.08 || p > 0.85;
    const r = (nearHorizon ? 14 : 12) * sunScale;
    const sun = nearHorizon
      ? sunArt(x, y, r, '#efa763', '#c96f3d')
      : sunArt(x, y, r);
    // 이른 아침에는 미처 사라지지 못한 별이 서쪽 하늘에 희미하게 남음
    const fading = h < 7
      ? `${fx('fx-twinkle', sparkle(178, 88, 0.7, '#b7abcf'))}
         ${fx('fx-twinkle', sparkle(148, 118, 0.55, '#b7abcf'), 0.8)}`
      : '';
    return `${fx('fx-pulse', sun)}${fading}`;
  }
  // 밤: 19시(서쪽 일몰)부터 다음날 6시(동쪽 일출)까지 달이 동→서로 이동
  const nightH = h >= SUNSET_H ? h - SUNSET_H : h + 24 - SUNSET_H;
  const p = Math.min(1, nightH / (24 - SUNSET_H + SUNRISE));
  const x = 52 + p * 156;
  const y = 218 - Math.sin(p * Math.PI) * 148;
  return `${fx('fx-bob', moonArt(x, y, 12))}
    ${fx('fx-twinkle', sparkle(66, 92, 0.9, '#e6ddb8'))}
    ${fx('fx-twinkle', sparkle(94, 128, 0.7, '#d8d2b4'), 0.7)}
    ${fx('fx-twinkle', sparkle(142, 84, 0.6, '#e6ddb8'), 1.2)}
    ${fx('fx-twinkle', sparkle(208, 126, 0.7, '#d8d2b4'), 0.4)}`;
}

// 장면 타원과 같은 모양의 반투명 덮개 — 시간대의 빛 분위기를 입힘
const sceneTint = (color, opacity) =>
  `<ellipse cx="130" cy="144" rx="112" ry="130" fill="${color}" opacity="${opacity}"/>`;

// 시간대별 "분위기" 레이어 — 하늘색·지평선 놀·틴트만 담당.
// 해·달·별 같은 천체는 celestialArt()가 시각으로 계산해 따로 그린다.
// sky: 시간대 하늘색(null이면 날씨별 하늘 유지) / air: 대기 연출 / tint: 장면 덮개
const TIME_LAYERS = {
  day: { sky: null, air: '', tint: '', cls: '' },
  dawn: {
    // 동트기 전 — 보랏빛 하늘, 지평선의 분홍 여명
    sky: '#dfd9ec',
    air: horizonGlow('#f2cfc0', 0.55),
    tint: sceneTint('#b7a9d0', 0.07),
    cls: 'scene-dawn',
  },
  sunset: {
    // 해 질 녘 — 주황 하늘, 지평선의 붉은 놀
    sky: '#f0cfa3',
    air: horizonGlow('#ec9d55', 0.45),
    tint: sceneTint('#d97a3a', 0.12),
    cls: 'scene-sunset',
  },
  night: {
    sky: '#434c66',
    air: '',
    tint: sceneTint('#242b42', 0.24),
    cls: 'scene-night',
  },
};

const timeLayer = () => TIME_LAYERS[timeOfDay()];

// 상태 코드 → 장면 연출 (날씨 로직 — 해·달의 위치는 celestialArt가 시간으로 결정)
// sev: 등급(good=웃음 / warn=시무룩 / danger=빈사+덜덜)
// sky: 하늘색 / air: 공중 효과 / soilFx: 흙 위 효과 / overlay: 식물 위 덮개
// hideSun: 하늘이 구름에 덮여 해·달·별이 보이지 않는 날씨
// sunScale: 해가 유난히 크고 강하게 보이는 날씨 (폭염·가뭄)
const CONDITION_FX = {
  // ── 날씨 ──
  stable: {
    sev: 'good',
    air: fx('fx-drift', cloudArt(176, 72, 0.9, { rain: false })),
  },
  clear: {
    sev: 'good',
    sky: '#fdfaf0',
    air: `${fx('fx-twinkle', sparkle(76, 112, 0.9))}${fx('fx-twinkle', sparkle(58, 152, 0.7, '#c9b98a'), 0.9)}`,
  },
  heat: {
    sev: 'warn',
    sky: '#fdf5e5',
    sunScale: 1.15,
    air: `${fx('fx-pulse', thermometerArt(62, 88, 0.9), 0.35, 2.8)}
      ${fx('fx-shimmer', heatWavesArt(78, 132))}`,
  },
  heatwave: {
    sev: 'danger',
    sky: '#faeddc',
    sunScale: 1.3,
    air: `${fx('fx-pulse', thermometerArt(58, 88, 1, true), 0.25, 1.9)}
      ${fx('fx-shimmer', heatWavesArt(82, 122))}${fx('fx-shimmer', heatWavesArt(96, 158, 0.9), 0.7)}`,
  },
  cold: {
    sev: 'warn',
    sky: '#f2f6f6',
    air: `${fx('fx-drift', cloudArt(90, 76, 0.9, { rain: false }))}
      ${fx('fx-snow', snowflakeSceneArt(70, 132, 6))}${fx('fx-snow', snowflakeSceneArt(180, 122, 5), 1.8)}`,
  },
  frost: {
    sev: 'danger',
    sky: '#eef4f6',
    hideSun: true,
    air: `${fx('fx-snow', snowflakeSceneArt(80, 92, 8))}${fx('fx-snow', snowflakeSceneArt(172, 76, 6), 1.2)}
      ${fx('fx-snow', snowflakeSceneArt(120, 128, 5), 2.4)}${fx('fx-snow', snowflakeSceneArt(196, 140, 6.5), 0.6)}
      ${fx('fx-snow', snowflakeSceneArt(58, 168, 4.5), 3)}`,
    soilFx: `<g stroke="#dfeaf0" stroke-width="2.2" stroke-linecap="round" opacity=".9">
      <path d="M72 238 l6 -4 M100 233 l6 -4 M132 231 l6 -4 M164 233 l6 -4 M192 238 l6 -4"/>
    </g>`,
  },
  rain: {
    sev: 'warn',
    sky: '#f0f3ee',
    hideSun: true,
    air: `${fx('fx-drift', cloudArt(96, 74, 1.05))}${fx('fx-drift', cloudArt(178, 60, 0.75, { rain: false }), 2)}
      ${fx('fx-fall', dew(72, 138, 1))}${fx('fx-fall', dew(120, 118, 0.9), 0.6)}
      ${fx('fx-fall', dew(160, 142, 1), 1.1)}${fx('fx-fall', dew(196, 168, 0.85), 0.3)}`,
    soilFx: `${fx('fx-twinkle', rippleArt(84, 252), 0, 2.6)}${fx('fx-twinkle', rippleArt(182, 258), 1.2, 2.6)}`,
  },
  downpour: {
    sev: 'danger',
    sky: '#e9ece8',
    hideSun: true,
    air: `${fx('fx-drift', cloudArt(88, 68, 1.1, { fill: '#d9dde3', line: '#8f98a8' }), 0, 5)}
      ${fx('fx-drift', cloudArt(180, 56, 0.9, { fill: '#d9dde3', line: '#8f98a8' }), 1, 5)}
      ${fx('fx-fall-fast', `<g stroke="#8fa9ba" stroke-width="2" stroke-linecap="round" opacity=".85">
        <line x1="70" y1="116" x2="64" y2="132"/><line x1="140" y1="112" x2="134" y2="128"/>
        <line x1="200" y1="112" x2="194" y2="128"/>
      </g>`)}
      ${fx('fx-fall-fast', `<g stroke="#8fa9ba" stroke-width="2" stroke-linecap="round" opacity=".85">
        <line x1="104" y1="130" x2="98" y2="146"/><line x1="172" y1="128" x2="166" y2="144"/>
        <line x1="88" y1="158" x2="82" y2="174"/><line x1="196" y1="160" x2="190" y2="176"/>
      </g>`, 0.45)}`,
    soilFx: `<ellipse cx="172" cy="256" rx="26" ry="6.5" fill="#a9c2d2" opacity=".65" stroke="#7f9cb0" stroke-width="1.5"/>
      ${fx('fx-twinkle', rippleArt(84, 250), 0, 1.6)}
      ${fx('fx-twinkle', `<g stroke="#7f9cb0" stroke-width="1.6" stroke-linecap="round">
        <path d="M152 246 l-4 -6 M188 246 l4 -6"/>
      </g>`, 0.5, 1.6)}`,
  },
  wind: {
    sev: 'warn',
    sky: '#f7f6ec',
    air: `<g class="fx-flow" stroke="#9aa7ae" stroke-width="2.2" stroke-linecap="round" fill="none" opacity=".9">
        <path d="M34 104 h64 q11 0 11 -8 q0 -7 -7 -7"/>
        <path d="M56 144 h88 q13 0 13 10 q0 7 -7 7"/>
        <path d="M40 184 h46"/>
      </g>
      ${fx('fx-leaf-fly', leaf(190, 96, 13, 5, 30, '#aab98d', '#7c8b62'))}
      ${fx('fx-leaf-fly', leaf(200, 170, 11, 4.5, 20, '#aab98d', '#7c8b62'), 1.5)}`,
  },
  typhoon: {
    sev: 'danger',
    sky: '#e5e8e5',
    hideSun: true,
    air: `${fx('fx-drift', cloudArt(84, 62, 1.05, { fill: '#ccd2cf', line: '#828c88', rain: false }), 0, 4)}
      ${fx('fx-drift', cloudArt(186, 78, 0.85, { fill: '#ccd2cf', line: '#828c88', rain: false }), 0.8, 4)}
      ${fx('fx-spin', `<path d="M130 108 m-2 -1.4 a2.8 2.8 0 1 1 -1.4 4.8 a7.7 7.7 0 1 0 8.4 -11.2 a14 14 0 1 1 -18.2 14.7"
        fill="none" stroke="#7f9cb0" stroke-width="2.6" stroke-linecap="round"/>`)}
      ${fx('fx-fall-fast', `<g stroke="#8fa9ba" stroke-width="2" stroke-linecap="round" opacity=".85">
        <line x1="66" y1="140" x2="56" y2="152"/><line x1="170" y1="144" x2="160" y2="156"/>
      </g>`)}
      ${fx('fx-fall-fast', `<g stroke="#8fa9ba" stroke-width="2" stroke-linecap="round" opacity=".85">
        <line x1="102" y1="156" x2="92" y2="168"/><line x1="200" y1="120" x2="190" y2="132"/>
      </g>`, 0.4)}`,
  },
  drought: {
    sev: 'warn',
    sky: '#fdf5df',
    sunScale: 1.2,
    air: fx('fx-shimmer', heatWavesArt(62, 116, 0.9)),
    soilFx: soilCracksArt(),
  },
  // ── 땅·토양 ──
  soilStable: {
    sev: 'good',
    air: fx('fx-twinkle', sparkle(84, 196, 0.85, '#c9b98a')),
    soilFx: `${tuft(96, 240, 1)}${tuft(168, 242, -1)}`,
  },
  dry: {
    sev: 'warn',
    sky: '#fcf8ec',
    air: fx('fx-shimmer', heatWavesArt(70, 130, 0.8), 0.4),
    soilFx: soilCracksArt(),
  },
  overwet: {
    sev: 'warn',
    sky: '#f3f5f1',
    air: fx('fx-fall', dew(96, 152, 1.2), 0, 2.4),
    soilFx: `<ellipse cx="130" cy="250" rx="46" ry="9" fill="#6b5540" opacity=".35"/>
      ${fx('fx-twinkle', dew(98, 240, 0.9), 0, 2.4)}${fx('fx-twinkle', dew(166, 244, 0.9), 1.2, 2.4)}`,
  },
  drainage: {
    sev: 'warn',
    sky: '#f3f5f1',
    soilFx: fx('fx-drift', `<g stroke="#7f9cb0" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".9">
        <path d="M58 236 q6 -5 12 0 q6 5 12 0 q6 -5 12 0 q6 5 12 0 q6 -5 12 0 q6 5 12 0 q6 -5 12 0 q6 5 12 0"/>
        <path d="M76 246 q6 -5 12 0 q6 5 12 0 q6 -5 12 0 q6 5 12 0 q6 -5 12 0"/>
      </g>`, 0, 4),
  },
  acidity: {
    sev: 'warn',
    soilFx: `${fx('fx-pulse', phDropArt(180, 249, 1.08), 0, 2.8)}
      ${fx('fx-twinkle', `<ellipse cx="180" cy="255" rx="18" ry="5.5" fill="none"
        stroke="#7f9cb0" stroke-width="1.4" opacity=".65"/>`, 0.7, 2.8)}`,
  },
  salinity: {
    sev: 'warn',
    soilFx: `${fx('fx-twinkle', `<g fill="#f7f3e6" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round">
        <rect x="88" y="236" width="7" height="7" transform="rotate(45 91.5 239.5)"/>
        <rect x="174" y="244" width="6" height="6" transform="rotate(45 177 247)"/>
      </g>`)}
      ${fx('fx-twinkle', `<g fill="#f7f3e6" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round">
        <rect x="138" y="232" width="8" height="8" transform="rotate(45 142 236)"/>
        <rect x="112" y="250" width="6" height="6" transform="rotate(45 115 253)"/>
      </g>`, 1)}`,
  },
  texture: {
    sev: 'warn',
    air: fx('fx-pulse', `<g>
        <circle cx="196" cy="106" r="10" fill="#f5e3da" stroke="#c9825b" stroke-width="1.6"/>
        <line x1="196" y1="101" x2="196" y2="108" stroke="#c9825b" stroke-width="2" stroke-linecap="round"/>
        <circle cx="196" cy="112" r="1.2" fill="#c9825b"/>
      </g>`, 0, 1.6),
    soilFx: `<path d="M30 252 Q130 243 230 252 L230 260 Q130 251 30 260 Z" fill="#c4ad85" opacity=".75"/>
      <path d="M44 268 Q130 260 216 268 L216 275 Q130 267 44 275 Z" fill="#8a6c47" opacity=".6"/>`,
  },
  flood: {
    sev: 'danger',
    sky: '#edf2f1',
    hideSun: true,
    overlay: fx('fx-bob', `<path d="M14 210 q10 -6 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 L254 288 L6 288 Z"
        fill="#9db8c9" opacity=".45"/>
      <g stroke="#7f9cb0" stroke-width="2" stroke-linecap="round" fill="none" opacity=".8">
        <path d="M40 224 q7 -5 14 0 q7 5 14 0"/>
        <path d="M150 236 q7 -5 14 0 q7 5 14 0"/>
        <path d="M84 254 q7 -5 14 0 q7 5 14 0"/>
      </g>`),
  },
};

/**
 * 상태를 입힌 정원 장면.
 * 등급에 따라 작물 표정(웃음/시무룩/빈사)과 움직임(살랑/덜덜)도 함께 바뀝니다.
 * @param {string} cropId - 작물 (lettuce|cucumber|potato|apple|pear)
 * @param {string} stageKey - 성장 단계 (기본 mature)
 * @param {string|string[]} codes - conditions.js의 상태 코드. 날씨와 토양을 함께 표시할 수 있습니다.
 */
function conditionScene(cropId, stageKey = 'mature', codes = 'stable') {
  const codeList = [...new Set((Array.isArray(codes) ? codes : [codes])
    .filter((code) => CONDITION_FX[code]))];
  if (codeList.length === 0) codeList.push('stable');
  const fxDefs = codeList.map((code) => CONDITION_FX[code]);
  const severityRank = { good: 0, warn: 1, danger: 2 };
  const sev = fxDefs.reduce((highest, definition) =>
    severityRank[definition.sev || 'good'] > severityRank[highest]
      ? definition.sev
      : highest, 'good');
  // 시간대 레이어 — 낮에는 상태별 하늘색, 그 외에는 시간대 하늘색이 우선
  const t = timeLayer();
  const condSky = fxDefs.find((definition) => definition.sky)?.sky || '#fbf8ef';
  const sky = t.sky || condSky;
  // 시간(위치) × 날씨(가림) 분리: 흐린 날씨(hideSun)면 해·달·별을 통째로 감춤
  const hideSun = fxDefs.some((definition) => definition.hideSun);
  const sunScale = Math.max(1, ...fxDefs.map((definition) => definition.sunScale || 1));
  const celestial = hideSun ? '' : celestialArt(sunScale);
  const air = fxDefs.map((definition) => definition.air || '').join('');
  const soilFx = fxDefs.map((definition) => definition.soilFx || '').join('');
  const overlay = fxDefs.map((definition) => definition.overlay || '').join('');
  const faceMood = sev === 'danger' ? 'danger' : sev === 'warn' ? 'sad' : 'happy';
  // 등급별 움직임: 양호=통통 튀는 리듬 / 주의=축 처진 흔들림 / 위험=덜덜 떨림
  const swayClass = sev === 'danger' ? 'sway-danger' : sev === 'warn' ? 'sway-sad' : 'sway-happy';
  const id = `vg${++uid}`;
  const s = STAGE_SCALE[stageKey] || 1.2;
  const sceneLabel = codeList.map((code) => CONDITIONS[code]?.label || code).join(' · ');
  return `<svg viewBox="0 0 260 288" role="img" aria-label="${CROP_NAMES[cropId] || cropId} · ${sceneLabel}" class="${t.cls}">
    <defs><clipPath id="${id}"><ellipse cx="130" cy="144" rx="112" ry="130"/></clipPath></defs>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="${sky}"/>
    <g clip-path="url(#${id})">
      <path d="M10,216 Q130,197 250,216" fill="none" stroke="#e3dbc4" stroke-width="1.6"/>
      ${t.air}${celestial}${air}
      ${ground()}
      ${soilFx}
      <g class="${swayClass}"><g transform="translate(130 227) scale(${s}) translate(-130 -227)">
        ${plantArt(cropId, stageKey, faceMood)}
      </g></g>
      ${overlay}
      ${t.tint}
    </g>
    ${frameDecor()}
  </svg>`;
}

// 비료 포대 아이콘
function sackIcon(size) {
  const w = [40, 46, 54][size];
  const stitches = size === 2
    ? `<path d="M14 24 h20 M14 30 h20" stroke="#7c6347" stroke-width="1.2" stroke-dasharray="2 3" opacity=".6"/>`
    : '';
  return `<svg width="${w}" height="${w * 1.08}" viewBox="0 0 48 52">
    <path d="M14 14 q-7 6 -8 20 q-1 13 18 13 q19 0 18 -13 q-1 -14 -8 -20 Z"
      fill="#ece2c8" stroke="#7c6347" stroke-width="2" stroke-linejoin="round"/>
    <path d="M16 13 q8 -7 16 0" fill="none" stroke="#7c6347" stroke-width="2" stroke-linecap="round"/>
    <path d="M20 9 q4 -3 8 0 M18 13 l-4 -5 M30 13 l4 -5" fill="none" stroke="#7c6347" stroke-width="1.8" stroke-linecap="round"/>
    ${stitches}
    <g stroke="#6f815a" stroke-width="2" fill="none" stroke-linecap="round">
      <path d="M24 40 v-8"/>
      <path d="M24 34 q-5 -1 -6 -6 q6 0 6 6"/>
      <path d="M24 34 q5 -1 6 -6 q-6 0 -6 6"/>
    </g>
  </svg>`;
}

// 하단 탭 아이콘
const TAB_ICONS = {
  home: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 19 V11"/>
    <path d="M11 11 Q4.5 10.5 4 4.5 Q10.5 5 11 11 Z"/>
    <path d="M11 11 Q17.5 10.5 18 4.5 Q11.5 5 11 11 Z"/>
    <path d="M6 19 h10"/>
  </svg>`,
  todos: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4.5" y="4.5" width="13" height="14.5" rx="2.2"/>
    <path d="M8.5 4.5 Q11 2.2 13.5 4.5"/>
    <path d="M7.8 12.2 l2.3 2.3 l4.2 -4.8"/>
  </svg>`,
  records: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 5 Q4 3.5 5.5 3.5 H16.5 Q18 3.5 18 5 V17 Q18 18.5 16.5 18.5 H5.5 Q4 18.5 4 17 Z"/>
    <path d="M7.5 3.5 V18.5"/>
    <path d="M10.5 8 H15 M10.5 11 H15 M10.5 14 H13.5"/>
  </svg>`,
  chat: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6 Q4 4 6 4 H16 Q18 4 18 6 V12.5 Q18 14.5 16 14.5 H9.5 L5.5 18 V14.5 Q4 14.5 4 12.5 Z"/>
    <path d="M11 11.5 V9.6"/>
    <path d="M11 9.6 Q8.8 9.4 8.5 7.2 Q10.7 7.4 11 9.6 Z"/>
    <path d="M11 9.6 Q13.2 9.4 13.5 7.2 Q11.3 7.4 11 9.6 Z"/>
  </svg>`,
  settings: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="3.2"/>
    <path d="M11 3.5 v2.2 M11 16.3 v2.2 M3.5 11 h2.2 M16.3 11 h2.2 M5.7 5.7 l1.6 1.6 M14.7 14.7 l1.6 1.6 M16.3 5.7 l-1.6 1.6 M7.3 14.7 l-1.6 1.6"/>
  </svg>`,
};

/* ════════════════════════════════════════════
   2. API 클라이언트
════════════════════════════════════════════ */

let userName = localStorage.getItem('farm.name') || '';
const DEFAULT_FARM_REGION = '인천광역시 남동구';
let farmRegion = localStorage.getItem('farm.region') || DEFAULT_FARM_REGION;
const environmentCache = new Map();

// 이메일 인증코드 로그인 세션 (Supabase access token)
let sbToken = localStorage.getItem('farm.sbToken') || '';
let sbEmail = localStorage.getItem('farm.sbEmail') || '';

function setSession(token, email) {
  sbToken = token || '';
  sbEmail = email || '';
  if (sbToken) {
    localStorage.setItem('farm.sbToken', sbToken);
    localStorage.setItem('farm.sbEmail', sbEmail);
  } else {
    localStorage.removeItem('farm.sbToken');
    localStorage.removeItem('farm.sbEmail');
  }
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (sbToken) headers['Authorization'] = `Bearer ${sbToken}`;
  // 로그인 전(sbToken 없음)에는 예전 방식대로 이름으로 식별 — HTTP 헤더에는
  // 한글을 담을 수 없어 인코딩해서 보냄 (서버에서 디코딩)
  else headers['x-user-id'] = encodeURIComponent(userName);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && sbToken && !path.startsWith('/api/auth/')) {
    setSession(null, null);
    toast('로그인이 만료됐어요. 다시 로그인해 주세요.');
    renderLogin();
    show('login', { tabbar: false });
    return { ok: false, message: '로그인이 만료됐어요.' };
  }
  return res.json();
}

/* ════════════════════════════════════════════
   3. 화면 전환 & 공용 UI
════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const views = ['login', 'wizard', 'home', 'todos', 'rewards', 'chat', 'records', 'settings'];
const TAB_LABELS = { home: '대시보드', todos: 'TO-DO', chat: '흙톡', records: '기록', settings: '설정' };

function show(name, { tabbar = true } = {}) {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
  $('#tabbar').hidden = !tabbar;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ════════════════════════════════════════════
   2-1. 로그인 / 회원가입 (이메일 + 비밀번호)
   가입할 때만 이메일 인증코드를 한 번 확인하고, 이후 로그인은 비밀번호만으로 됩니다.
════════════════════════════════════════════ */

let loginMode = 'login'; // 'login' | 'signup' | 'confirm'
let loginEmail = '';

function renderLogin() {
  const body = $('#login-body');

  if (loginMode === 'confirm') {
    body.innerHTML = `
      <p class="login-note">${loginEmail}로 인증코드를 보냈어요. 가입할 때 한 번만 확인하면 돼요.</p>
      <form id="login-confirm-form" class="login-form">
        <input id="login-confirm-code" type="text" inputmode="numeric" placeholder="6자리 인증코드" autocomplete="one-time-code" required/>
        <button type="submit" class="btn btn-primary">확인하고 시작하기</button>
      </form>
      <p class="login-note"><button class="link-btn" id="login-cancel-confirm" type="button">이메일 다시 입력하기</button></p>`;
    $('#login-confirm-form').onsubmit = async (e) => {
      e.preventDefault();
      const code = $('#login-confirm-code').value.trim();
      if (!code) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const res = await api('/api/auth/confirm-signup', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, code }),
      });
      btn.disabled = false;
      if (!res.ok) { toast(res.message || '인증코드가 올바르지 않아요.'); return; }
      setSession(res.accessToken, res.email);
      loginMode = 'login';
      loginEmail = '';
      toast('가입을 완료했어요.');
      await enterApp();
    };
    $('#login-cancel-confirm').onclick = () => { loginMode = 'signup'; renderLogin(); };
    return;
  }

  const isSignup = loginMode === 'signup';
  body.innerHTML = `
    <form id="login-form" class="login-form">
      <input id="login-email" type="email" placeholder="you@example.com" autocomplete="email" required value="${loginEmail}"/>
      <input id="login-password" type="password"
        placeholder="${isSignup ? '비밀번호 (6자 이상)' : '비밀번호'}"
        autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="6"/>
      <button type="submit" class="btn btn-primary">${isSignup ? '회원가입' : '로그인'}</button>
    </form>
    <p class="login-note">
      ${isSignup ? '이미 계정이 있으신가요? ' : '계정이 없으신가요? '}
      <button class="link-btn" id="login-switch" type="button">${isSignup ? '로그인' : '회원가입'}</button>
    </p>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const res = await api(isSignup ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    btn.disabled = false;
    if (!res.ok) {
      toast(res.message || (isSignup ? '회원가입에 실패했어요.' : '로그인에 실패했어요.'));
      return;
    }
    if (isSignup && res.needsConfirmation) {
      loginEmail = email;
      loginMode = 'confirm';
      toast('인증코드를 보냈어요. 메일함을 확인해 주세요.');
      renderLogin();
      return;
    }
    setSession(res.accessToken, res.email);
    loginMode = 'login';
    loginEmail = '';
    toast(isSignup ? '가입을 완료했어요.' : '로그인했어요.');
    await enterApp();
  };
  $('#login-switch').onclick = () => {
    loginMode = isSignup ? 'login' : 'signup';
    renderLogin();
  };
}

// 로그인 성공 직후(또는 이미 로그인된 상태로 부팅할 때) 실제 앱으로 진입
async function enterApp() {
  if (!userName) {
    startWizard();
    return;
  }
  await enter();
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(d = new Date()) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일`;
}
function fmtKey(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}월 ${d}일`;
}
// 'YYYY-MM-DD' 두 날짜의 일수 차이 (b - a)
function diffDaysKey(aKey, bKey) {
  const [ay, am, ad] = aKey.split('-').map(Number);
  const [by, bm, bd] = bKey.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

/* ════════════════════════════════════════════
   4. 대시보드
════════════════════════════════════════════ */

let status = null;        // GET /api/me/status 캐시
let activeCropId = null;  // 대시보드에 크게 보여줄 작물 (아이콘으로 전환)

// 단계 스테퍼에 쓰는 짧은 이름 (씨앗에서 수확까지)
const STEP_LABELS = {
  seed: '씨앗', sprout: '새싹', seedling: '모종', sapling: '묘목',
  young: '어린 나무', grown: '성목', leafing: '잎 성장', bulking: '비대',
  growing: '성장', flower: '꽃', blossom: '꽃', fruit: '열매', mature: '수확',
};
// 작물별 예외 라벨 (감자는 씨감자/싹으로 부름)
const CROP_STEP_LABELS = {
  potato: { seed: '씨감자', sprout: '싹' },
};
// 작물별 성장 단계 key (config.js와 동일한 순서 — 시작 상태 질문에 사용)
const CROP_STAGE_KEYS = {
  lettuce:  ['seed', 'sprout', 'growing', 'mature'],
  cucumber: ['seed', 'sprout', 'seedling', 'flower', 'fruit', 'mature'],
  potato:   ['seed', 'sprout', 'leafing', 'bulking', 'mature'],
  apple:    ['sapling', 'young', 'grown', 'blossom', 'fruit', 'mature'],
  pear:     ['sapling', 'young', 'grown', 'blossom', 'fruit', 'mature'],
};
// 시작 상태로 고를 수 있는 단계 (마지막 '수확'은 제외)
const startableStages = (cropId) => (CROP_STAGE_KEYS[cropId] || []).slice(0, -1);
function stepLabel(cropId, key) {
  return (CROP_STEP_LABELS[cropId] && CROP_STEP_LABELS[cropId][key]) || STEP_LABELS[key] || key;
}

// 지금 대시보드에 보여줄 작물 (없어졌으면 첫 작물로)
function getActiveCrop() {
  const crops = status.crops || [];
  if (!crops.length) return null;
  return crops.find((c) => c.cropId === activeCropId) || crops[0];
}

/* ── 작물 테두리 꾸미기 (포인트 해금 상점) ──────
   대시보드 정원의 타원 테두리를 꾸미는 장식 6종.
   need = 해금에 필요한 누적 포인트 (출석으로 모임, 소모되지 않음) */

const FRAMES = [
  { id: 'basic',     name: '기본',      need: 0 },
  { id: 'sprout',    name: '새싹 리스', need: 50 },
  { id: 'bloom',     name: '꽃잔치',    need: 150 },
  { id: 'dew',       name: '이슬방울',  need: 300 },
  { id: 'butterfly', name: '나비 정원', need: 450 },
  { id: 'sun',       name: '햇살',      need: 600 },
  { id: 'snow',      name: '눈꽃',      need: 800 },
  { id: 'night',     name: '별밤',      need: 1000 },
  { id: 'rainbow',   name: '무지개',    need: 1500 },
];

const activeFrameId = () => localStorage.getItem('farm.frame') || 'basic';
const currentFrameName = () =>
  (FRAMES.find((f) => f.id === activeFrameId()) || FRAMES[0]).name;

// 나비 한 마리 (테두리 장식용)
function butterflyArt(x, y, s = 1, wing = '#cbb6dd', line = '#8f7ca6') {
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M0 0 C -11 -12 -18 -6 -14 1 C -17 8 -8 11 0 2 Z"
      fill="${wing}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M0 0 C 11 -12 18 -6 14 1 C 17 8 8 11 0 2 Z"
      fill="${wing}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="0" y1="-3" x2="0" y2="5" stroke="${line}" stroke-width="2" stroke-linecap="round"/>
    <path d="M-0.6 -3 q-3 -4 -5.4 -5 M0.6 -3 q3 -4 5.4 -5"
      fill="none" stroke="${line}" stroke-width="1.1" stroke-linecap="round"/>
  </g>`;
}

// 타원 둘레의 균등한 점들 (장식 배치용)
function ringPts(n, phase = 0, rx = 112, ry = 130) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (((i / n) * 360 + phase) * Math.PI) / 180;
    pts.push({ x: 130 + rx * Math.cos(a), y: 144 + ry * Math.sin(a), deg: (a * 180) / Math.PI });
  }
  return pts;
}

// 테두리 장식 — plantScene/conditionScene의 타원 테두리 자리에 들어감
function frameDecor(frameId = activeFrameId()) {
  const outline = (color = INK, op = 0.7) =>
    `<ellipse cx="130" cy="144" rx="112" ry="130" fill="none" stroke="${color}" stroke-width="1.6" opacity="${op}"/>`;
  const inner = (color, dash = '0.5 8') =>
    `<ellipse cx="130" cy="144" rx="103" ry="121" fill="none" stroke="${color}" stroke-width="1.3"
      stroke-dasharray="${dash}" stroke-linecap="round" opacity=".55"/>`;

  switch (frameId) {
    case 'sprout': // 새싹 리스: 초록 점선 + 둘레의 작은 잎들
      return `${outline('#6d874c')}${inner('#aab98d', '3 7')}
        ${ringPts(10, -90).map((p) => leaf(p.x, p.y, 11, 4.5, p.deg, '#aab98d', '#7c8b62')).join('')}`;
    case 'bloom': // 꽃잔치: 분홍 점선 + 둘레의 꽃들
      return `${outline('#b98a92')}${inner('#dcb2ba', '2 8')}
        ${ringPts(7, -90).map((p) => flower5(p.x, p.y, 8, '#f4dde1', '#dcbc5f')).join('')}
        ${ringPts(7, -64).map((p) => sparkle(p.x, p.y, 0.9, '#d09aa4')).join('')}`;
    case 'dew': // 이슬방울: 파란 실선 + 둘레의 물방울
      return `${outline('#7f9cb0')}${inner('#a9c2d2', '6 6')}
        ${ringPts(8, -90).map((p) => dew(p.x, p.y, 0.85)).join('')}`;
    case 'sun': { // 햇살: 금빛 이중 테 + 사방으로 뻗는 빛살
      const rays = ringPts(24, -90).map((p) => {
        const a = (p.deg * Math.PI) / 180;
        return `<line x1="${p.x}" y1="${p.y}" x2="${130 + 119 * Math.cos(a)}" y2="${144 + 137 * Math.sin(a)}"/>`;
      }).join('');
      return `${outline('#c9a13d', 0.85)}${inner('#e0c26a', '10 5')}
        <g stroke="#d8b856" stroke-width="2" stroke-linecap="round">${rays}</g>`;
    }
    case 'butterfly': // 나비 정원: 연보라 테 + 둘레를 도는 나비들
      return `${outline('#8f7ca6')}${inner('#cbb6dd', '4 6')}
        ${ringPts(6, -90).map((p) => butterflyArt(p.x, p.y, 0.78)).join('')}
        ${ringPts(6, -60).map((p) => sparkle(p.x, p.y, 0.5, '#cbb6dd')).join('')}`;
    case 'snow': // 눈꽃: 시린 파란 테 + 크고 작은 눈송이
      return `${outline('#8fb0c4')}${inner('#cfe0e8', '2 6')}
        ${ringPts(9, -90).map((p, i) => snowflakeSceneArt(p.x, p.y, i % 2 ? 5 : 7.5)).join('')}`;
    case 'rainbow': { // 무지개: 위쪽에 걸린 일곱 색 아치 + 아래 둘레의 색점
      const hues = ['#d98a8a', '#e0aa72', '#ddd07c', '#94b97e', '#7fa8c4', '#8f8fc4', '#b98fc0'];
      const at = (rx, ry, deg) => {
        const a = (deg * Math.PI) / 180;
        return `${(130 + rx * Math.cos(a)).toFixed(1)} ${(144 + ry * Math.sin(a)).toFixed(1)}`;
      };
      const arcs = hues.map((h, i) => {
        const rx = 112 - i * 3.1, ry = 130 - i * 3.1;
        return `<path d="M ${at(rx, ry, 196)} A ${rx} ${ry} 0 0 1 ${at(rx, ry, 344)}"
          fill="none" stroke="${h}" stroke-width="3" stroke-linecap="round" opacity=".85"/>`;
      }).join('');
      const dots = ringPts(18, -90)
        .filter((p) => p.y > 150)
        .map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="3.2" fill="${hues[i % 7]}"
          stroke="${INK}" stroke-width="0.8" opacity=".85"/>`)
        .join('');
      return `${outline('#9a8fb0')}${arcs}${dots}`;
    }
    case 'night': // 별밤: 남보라 테 + 반짝이는 별들
      return `${outline('#5d5a7a', 0.9)}${inner('#8a87a8', '2 6')}
        ${ringPts(8, -90).map((p) => sparkle(p.x, p.y, 1.25, '#d8b856')).join('')}
        ${ringPts(8, -68).map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.3" fill="#9a97b8"/>`).join('')}`;
    default: // 기본
      return `${outline()}${inner('#c9825b')}`;
  }
}

// 미니 상점 아이콘 — 초록 천막을 두른 작은 가게 (대시보드 진입 버튼용)
function shopIcon(s = 26) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 26 26" aria-hidden="true">
    <path d="M5 11 h16 v8.6 q0 1.4 -1.4 1.4 H6.4 Q5 21 5 19.6 Z"
      fill="#fbf8ef" stroke="#7c6347" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M9.6 21 v-5.2 q0 -1.7 1.7 -1.7 h1 q1.7 0 1.7 1.7 V21 Z"
      fill="#e6d7b4" stroke="#7c6347" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="16.1" y="14.3" width="3.8" height="3.5" rx="0.9"
      fill="#cfe0e8" stroke="#7c6347" stroke-width="1.2"/>
    <path d="M3.4 10.9 L5.8 5.4 h14.4 l2.4 5.5 Z"
      fill="#9cb873" stroke="#6d874c" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M8.4 5.4 L7 10.9 M13 5.4 v5.5 M17.6 5.4 l1.4 5.5"
      stroke="#f3f6ea" stroke-width="1.3" opacity=".85" fill="none"/>
  </svg>`;
}

// 상점 카드용 미리보기 (빈 타원 + 장식만)
function frameThumb(frameId) {
  return `<svg viewBox="0 0 260 288" class="frame-thumb">
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="#fbf8ef"/>
    ${frameDecor(frameId)}
  </svg>`;
}

// 성장 박스 밑 미니 상점 아이콘 — 새로 해금된 테두리가 있으면 점이 붙음
function renderShopDock() {
  const pts = status?.points ?? 0;
  const unlocked = FRAMES.filter((f) => pts >= f.need).length;
  const seen = Number(localStorage.getItem('farm.frameSeen') || 1);
  const isNew = unlocked > seen;

  $('#shop-dock').innerHTML = `
    <span class="point-pill">보유 포인트 <strong>${pts.toLocaleString()}P</strong></span>
    <button class="shop-btn ${isNew ? 'has-new' : ''}" id="frame-shop-btn"
      title="테두리 상점 — ${currentFrameName()}" aria-label="테두리 상점 열기">
      ${shopIcon(26)}
    </button>`;
  $('#frame-shop-btn').onclick = () => {
    localStorage.setItem('farm.frameSeen', String(unlocked));
    openFrameShop();
  };
}

function openFrameShop() {
  const pts = status?.points ?? 0;
  const cur = activeFrameId();
  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.remove('detail');

  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <p class="eyebrow">테두리 상점</p>
    <h2 class="sheet-title">정원 테두리 꾸미기</h2>
    <p class="sheet-sub">보유 포인트 <strong>${pts.toLocaleString()}P</strong> — 기준을 넘으면 자동으로 열려요.</p>
    <div class="frame-grid">
      ${FRAMES.map((f) => {
        const unlocked = pts >= f.need;
        const active = f.id === cur;
        const label = f.need === 0 ? '기본 제공'
          : unlocked ? (active ? '적용 중' : '적용하기')
          : `${f.need}P에 해금`;
        return `
        <button class="frame-card ${unlocked ? '' : 'locked'} ${active ? 'active' : ''}" data-f="${f.id}">
          ${frameThumb(f.id)}
          <div class="frame-name">${f.name}</div>
          <div class="frame-state ${unlocked && !active ? 'can' : ''}">${label}</div>
        </button>`;
      }).join('')}
    </div>`;

  overlay.hidden = false;
  $('#sheet-close').onclick = closeOverlay;
  overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };

  panel.querySelectorAll('.frame-card').forEach((card) => {
    card.onclick = () => {
      const f = FRAMES.find((x) => x.id === card.dataset.f);
      if (pts < f.need) {
        toast(`${f.need}P를 모으면 열려요. (지금 ${pts}P — 출석으로 모을 수 있어요)`);
        return;
      }
      localStorage.setItem('farm.frame', f.id);
      renderHome();
      if (!$('#view-settings').hidden) renderSettings(); // 마이페이지에서 열었을 때도 표시 갱신
      popVignette();
      openFrameShop(); // 적용 상태 갱신
      toast(`'${f.name}' 테두리를 둘렀어요!`);
    };
  });
}

// 정원 장면을 살짝 튀어오르게 (전환 피드백)
function popVignette() {
  const vg = $('#vignette');
  vg.classList.remove('pop-in');
  void vg.offsetWidth;
  vg.classList.add('pop-in');
}

// 내가 키우는 작물들 — 상단 오른편 아이콘 (누르면 그 작물의 상황으로 전환)
function renderCropIcons(active) {
  const crops = status.crops || [];
  const growing = new Set(crops.map((c) => c.cropId));
  const canAdd = Object.keys(CROP_NAMES).some((id) => !growing.has(id));

  $('#crop-badges').innerHTML =
    crops.map((c) => {
      const cached = environmentCache.get(`${farmRegion}:${c.cropId}`);
      return `
      <button class="crop-badge ${active && c.cropId === active.cropId ? 'active' : ''} ${cropBadgeStateClass(cached?.status)}"
        data-crop="${c.cropId}" title="${CROP_NAMES[c.cropId] || ''} 보기"
        aria-label="${CROP_NAMES[c.cropId] || ''} 상황 보기">
        ${cropPortrait(c.cropId)}
      </button>`;
    }).join('')
    + (canAdd ? `<button class="crop-badge add" id="add-crop-btn" title="새 작물 심기" aria-label="새 작물 심기">+</button>` : '');

  $('#crop-badges').querySelectorAll('button[data-crop]').forEach((btn) => {
    btn.onclick = () => {
      if (activeCropId === btn.dataset.crop) return;
      activeCropId = btn.dataset.crop;
      renderHome();
      popVignette();
    };
  });
  const addBtn = $('#add-crop-btn');
  if (addBtn) addBtn.onclick = openSeedOverlay;

  refreshCropBadgeStates(crops.filter((crop) => crop.cropId !== active?.cropId));
}

function cropBadgeStateClass(state) {
  if (state === 'DANGER') return 'crop-state-danger';
  if (state === 'CAUTION') return 'crop-state-caution';
  if (state === 'GOOD') return 'crop-state-good';
  return 'crop-state-pending';
}

function applyCropBadgeState(cropId, detail) {
  const badge = document.querySelector(`.crop-badge[data-crop="${cropId}"]`);
  if (!badge) return;
  badge.classList.remove(
    'crop-state-good',
    'crop-state-caution',
    'crop-state-danger',
    'crop-state-pending',
  );
  badge.classList.add(cropBadgeStateClass(detail?.status));
  const cropName = CROP_NAMES[cropId] || cropId;
  const stateLabel = detail?.statusLabel || '분석 중';
  badge.title = `${cropName} · ${stateLabel}`;
  badge.setAttribute('aria-label', `${cropName} 상황 보기 · ${stateLabel}`);
}

async function refreshCropBadgeStates(crops) {
  const requestedRegion = farmRegion;
  await Promise.allSettled(crops.map(async (crop) => {
    const detail = await loadEnvironmentDetail(crop);
    if (requestedRegion !== farmRegion) return;
    applyCropBadgeState(crop.cropId, detail);
  }));
}

function renderHome() {
  $('#home-greet').textContent = `${userName}의 작은 밭`;
  $('#home-date').textContent = fmtDate();

  const crop = getActiveCrop();
  activeCropId = crop ? crop.cropId : null;
  renderCropIcons(crop);

  // 출석 여부와 무관하게 홈은 항상 같은 모습으로 렌더링 —
  // 실제 상태(등급·원인)는 refreshHomeEnvironment가 분석 결과로 채움
  const matured = !!(crop && crop.matured);

  // 장면
  const vignette = $('#vignette');
  if (crop) {
    vignette.innerHTML = plantScene(crop.cropId, crop.stageKey, matured ? 'done' : 'none');
  } else {
    vignette.innerHTML = '';
  }

  // 상태 문구
  const sub = $('#status-sub');
  if (!crop) {
    renderStatusTitle('시작', '작물 없음', 'HOLD');
    sub.textContent = '아직 키우는 작물이 없어요. 새로 심어볼까요?';
  } else if (matured) {
    renderStatusTitle('양호', '수확 준비', 'GOOD');
    sub.textContent = `${crop.cropName}가 다 자랐어요! 수확해 주세요.`;
  } else {
    renderStatusTitle('분석 중', '오늘의 밭', 'HOLD');
    sub.textContent = `${farmRegion} 환경을 분석하고 있어요.`;
  }

  // 성장 카드 — 태어난 지 N일째 + 씨앗→수확 단계 스테퍼
  const sc = $('#stage-card');
  if (crop) {
    const born = crop.startedKey ? diffDaysKey(crop.startedKey, todayKey()) + 1 : null;
    const steps = (crop.stages || []).map((s, i) => `
      <div class="step ${i < crop.stageIndex ? 'passed' : ''} ${i === crop.stageIndex ? 'current' : ''}">
        <span class="step-dot"></span>
        <span class="step-label">${stepLabel(crop.cropId, s.key)}</span>
      </div>`).join('');
    sc.innerHTML = `
      <div class="stage-top">
        <span class="stage-name">${crop.stageName}</span>
        <span class="stage-meta">${born ? `태어난 지 ${born}일째` : ''}</span>
      </div>
      <div class="stage-steps">${steps}</div>`;
  } else {
    sc.innerHTML = '';
  }
  renderShopDock();

  // 버튼: 다 자란 작물은 수확, 키우는 작물이 없으면 새로 심기, 그 외에는 상세 보기.
  // 출석은 별도 절차가 아니라 팝업/보조 버튼으로 — 안 해도 모든 기능을 쓸 수 있다.
  const btn = $('#checkin-btn');
  btn.className = 'btn btn-wide btn-primary';
  btn.disabled = false;
  if (matured) {
    btn.textContent = `${crop.cropName} 수확하기`;
    btn.onclick = () => doHarvest(crop.cropId);
  } else if (!crop) {
    btn.textContent = '새 작물 심기';
    btn.onclick = openSeedOverlay;
  } else {
    btn.textContent = '상세 보기';
    btn.onclick = () => openDetailSheet(crop);
  }

  // 아직 출석 전이면 메인 버튼 아래에 가벼운 출석 버튼을 함께 보여줌
  let ghost = $('#checkin-ghost');
  if (crop && !status.checkedInToday) {
    if (!ghost) {
      ghost = document.createElement('button');
      ghost.id = 'checkin-ghost';
      ghost.className = 'btn btn-ghost btn-wide';
      btn.parentElement.appendChild(ghost);
    }
    ghost.textContent = '오늘도 출석하기';
    ghost.disabled = false;
    ghost.onclick = () => doCheckIn(ghost);
  } else if (ghost) {
    ghost.remove();
  }

  if (crop) refreshHomeEnvironment(crop);
}

async function refreshHomeEnvironment(crop) {
  try {
    const detail = await loadEnvironmentDetail(crop);
    if (getActiveCrop()?.cropId !== crop.cropId) return;
    applyCropBadgeState(crop.cropId, detail);
    renderStatusTitle(detail.statusLabel, detail.causeLabel, detail.status);
    $('#status-sub').textContent = Number.isFinite(detail.totalScore)
      ? `${farmRegion} · 환경 점수 ${detail.totalScore}점`
      : `${farmRegion} 환경을 분석하고 있어요.`;
    $('#vignette').innerHTML = conditionScene(
      crop.cropId,
      crop.stageKey,
      detail.sceneCodes,
    );
  } catch {
    // 출석·성장 화면은 분석 서버 장애와 무관하게 계속 사용할 수 있습니다.
  }
}

function renderStatusTitle(statusLabel, causeLabel, status = 'HOLD') {
  const title = $('#status-title');
  const tone = status === 'DANGER'
    ? 'danger'
    : status === 'CAUTION'
      ? 'caution'
      : status === 'GOOD'
        ? 'good'
        : 'neutral';
  const level = document.createElement('span');
  level.className = `status-level status-level-${tone}`;
  level.textContent = statusLabel;
  const cause = document.createElement('span');
  cause.className = 'status-cause';
  cause.textContent = causeLabel;
  title.replaceChildren(level, cause);
}

async function loadEnvironmentDetail(crop, { force = false } = {}) {
  const cacheKey = `${farmRegion}:${crop.cropId}`;
  if (!force && environmentCache.has(cacheKey)) {
    return environmentCache.get(cacheKey);
  }
  const response = await api(
    `/api/me/environment?crop=${encodeURIComponent(crop.cropId)}&region=${encodeURIComponent(farmRegion)}&cultivationMode=OPEN_FIELD${force ? '&force=1' : ''}`,
  );
  if (!response?.ok || !response.analysis) {
    throw new Error(response?.message || '농장 환경 분석을 불러오지 못했습니다.');
  }
  const detail = buildAnalysisViewModel(response.analysis);
  environmentCache.set(cacheKey, detail);
  return detail;
}

async function doCheckIn(triggerBtn = null) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await api('/api/me/checkin', { method: 'POST' });
    if (!res.ok) {
      toast(res.message || '출석에 실패했어요.');
      if (triggerBtn) triggerBtn.disabled = false;
      return;
    }
    status = res.status;
    closeOverlay(); // 출석 팝업에서 눌렀다면 닫아줌
    renderHome();
    popVignette();
    toast(res.message);
  } catch {
    toast('서버에 연결할 수 없어요. (npm start 확인)');
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

/* ── 출석 팝업 ────────────────────────────────
   시작할 때 팝업으로만 권유 — 닫거나 출석하지 않아도
   나머지 기능은 전부 정상적으로 쓸 수 있다. */

function openCheckinPopup() {
  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.remove('detail', 'soil-test-guide');
  panel.innerHTML = `
    <button class="sheet-close" id="checkin-close" aria-label="닫기">✕</button>
    <p class="eyebrow">오늘의 출석</p>
    <h2 class="sheet-title">밭에 물 주고 가실래요?</h2>
    <p class="sheet-sub">출석하면 작물이 자라고 포인트가 쌓여요.<br/>
      지금 안 해도 괜찮아요 — 홈의 출석 버튼으로 언제든 할 수 있어요.</p>
    <div class="home-actions">
      <button class="btn btn-primary btn-wide" id="checkin-popup-btn">오늘도 출석하기</button>
      <button class="btn btn-ghost btn-wide" id="checkin-later">오늘은 그냥 둘러볼게요</button>
    </div>`;
  overlay.hidden = false;
  $('#checkin-close').onclick = closeOverlay;
  $('#checkin-later').onclick = closeOverlay;
  $('#checkin-popup-btn').onclick = () => doCheckIn($('#checkin-popup-btn'));
  overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };
}

// 하루에 한 번만, 아직 출석 전이고 키우는 작물이 있을 때만 권유
function maybeOfferCheckin() {
  if (!status || status.checkedInToday) return;
  if (!(status.crops || []).length) return;
  const KEY = 'farm.checkinPromptDay';
  if (localStorage.getItem(KEY) === todayKey()) return;
  localStorage.setItem(KEY, todayKey());
  openCheckinPopup();
}

/* ── 상세 보기 시트 ──────────────────────────
   흙날씨 v3의 실제 분석 점수·원인 판정·단/중기 통합 예보를 표시합니다. */

function scoreGrade(n) {
  if (!Number.isFinite(n)) return '산정 중';
  return n >= 70 ? '양호' : n >= 50 ? '주의' : '위험';
}

const WEATHER_METRIC_COPY = Object.freeze({
  maxTemperature: { label: '최고기온', unit: '℃', pick: 'max' },
  minTemperature: { label: '최저기온', unit: '℃', pick: 'min' },
  precipitationProbability: { label: '강수확률', unit: '%', pick: 'max' },
  precipitationAmount: { label: '강수량', unit: 'mm', pick: 'max' },
  windSpeed: { label: '풍속', unit: 'm/s', pick: 'max' },
});

function readableScore(value) {
  if (!Number.isFinite(value)) return '산정 중';
  return Number.isInteger(value) ? `${value}점` : `${value.toFixed(2)}점`;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function triggerReading(trigger) {
  const readings = trigger?.readings?.filter((reading) => Number.isFinite(reading.value)) || [];
  if (!readings.length) return null;
  const meta = WEATHER_METRIC_COPY[trigger.metric] || { pick: 'max' };
  return readings.reduce((picked, reading) => {
    if (!picked) return reading;
    return meta.pick === 'min'
      ? (reading.value < picked.value ? reading : picked)
      : (reading.value > picked.value ? reading : picked);
  }, null);
}

function comparisonLabel(comparison, unit) {
  if (!Number.isFinite(comparison?.threshold)) return null;
  const suffix = comparison.operator === 'GT'
    ? '초과'
    : comparison.operator === 'GTE'
      ? '이상'
      : comparison.operator === 'LT'
        ? '미만'
        : comparison.operator === 'LTE'
          ? '이하'
          : '기준';
  return `${comparison.threshold}${unit} ${suffix}`;
}

function totalScoreExplanation(detail, crop) {
  if (!Number.isFinite(detail.totalScore)) {
    return {
      title: '점수를 계산할 자료가 더 필요해요',
      lines: ['확인된 기상과 토양 자료가 충분해지면 환경 점수와 이유를 함께 보여드릴게요.'],
    };
  }
  const componentParts = [
    Number.isFinite(detail.weather.score) ? `기상 ${readableScore(detail.weather.score)}` : null,
    Number.isFinite(detail.soil.score) ? `토양 ${readableScore(detail.soil.score)}` : null,
  ].filter(Boolean);
  const lines = [
    `${crop.cropName}의 기후 평년, 일주일 예보와 토양 상태를 작물 기준에 맞춰 비교했어요.`,
    `${componentParts.join(', ')}을 함께 반영했고, ${detail.causeLabel}이 현재 점수에 가장 큰 영향을 줬어요.`,
  ];
  if (
    Number.isFinite(detail.rawScore) &&
    Number.isFinite(detail.scoreCap?.value) &&
    detail.rawScore > detail.scoreCap.value
  ) {
    lines.push(`뚜렷한 위험 신호가 있어 최종 점수는 ${detail.scoreCap.value}점을 넘지 않도록 반영했어요.`);
  } else {
    lines.push('자료마다 실제 밭을 대표하는 정도가 달라 단순 평균하지 않고 신뢰할 수 있는 범위만 반영했어요.');
  }
  if (detail.soil.referenceOnly) {
    lines.push('토양은 아직 내 밭 실측값이 아니라 지역 통계이므로 참고 수준으로만 반영했어요.');
  }
  return { title: `${detail.totalScore}점 · ${scoreGrade(detail.totalScore)}`, lines };
}

function weatherScoreExplanation(detail, crop) {
  const trigger = detail.weather.trigger;
  const meta = WEATHER_METRIC_COPY[trigger?.metric] || { label: '기상값', unit: trigger?.unit || '' };
  const unit = trigger?.unit || meta.unit || '';
  const reading = triggerReading(trigger);
  const threshold = comparisonLabel(trigger?.comparison, unit);
  const lines = [];

  if (reading && threshold) {
    const date = reading.date ? `${Number(reading.date.slice(5, 7))}월 ${Number(reading.date.slice(8, 10))}일 ` : '';
    lines.push(`${date}${meta.label}이 ${reading.value}${unit}로 예보돼, ${crop.cropName}의 주의 기준인 ${threshold}에 해당해요.`);
  } else if (detail.weather.status === 'GOOD') {
    lines.push(`현재 예보에서는 ${crop.cropName}의 기상 기준을 벗어난 주요 위험이 확인되지 않았어요.`);
  } else {
    lines.push(`${crop.cropName}의 작물별 기상 기준과 비교한 결과 ${detail.weather.label} 신호가 확인됐어요.`);
  }
  const components = [
    { label: '기후 평년', ...detail.scoreComponents?.climate },
    { label: '일주일 예보', ...detail.scoreComponents?.forecast },
  ].filter((component) => Number.isFinite(component.score));
  const weighted = components.filter((component) =>
    Number.isFinite(component.effectiveWeight) && component.effectiveWeight > 0);
  const weightTotal = weighted.reduce((sum, component) => sum + component.effectiveWeight, 0);

  if (weighted.length > 1 && weightTotal > 0) {
    const formula = weighted.map((component) => {
      const percent = Math.round((component.effectiveWeight / weightTotal) * 100);
      return `${component.label} ${compactNumber(component.score)}점 × ${percent}%`;
    }).join(' + ');
    lines.push(`${formula}를 합쳐 기상 ${readableScore(detail.weather.score)}으로 계산했어요.`);
  } else if (components.length) {
    const values = components.map((component) =>
      `${component.label} ${compactNumber(component.score)}점`).join(', ');
    lines.push(`${values}을 반영해 기상 ${readableScore(detail.weather.score)}으로 계산했어요.`);
  } else {
    lines.push(`${detail.weather.label}의 정도와 이어지는 날짜를 반영해 기상 ${readableScore(detail.weather.score)}으로 계산했어요.`);
  }
  return { title: `${detail.weather.label}이 기상 점수에 반영된 이유`, lines };
}

function soilScoreExplanation(detail, crop) {
  const soil = detail.soil;
  const range = soil.optimalRange?.length === 2
    ? `${soil.optimalRange[0]}~${soil.optimalRange[1]}`
    : null;
  const lines = [];

  if (soil.code === 'acidity' && Number.isFinite(soil.observedValue) && range) {
    lines.push(`확인된 토양 pH는 ${soil.observedValue}이고, ${crop.cropName}의 적정 범위 ${range}에서 벗어나 산도 불균형으로 판단했어요.`);
  } else if (soil.code === 'acidity' && Number.isFinite(soil.outsideRatio)) {
    const outsidePercent = Math.round(soil.outsideRatio * 100);
    const fitPercent = Number.isFinite(soil.fitRatio)
      ? Math.round(soil.fitRatio * 100)
      : 100 - outsidePercent;
    const unclassifiedPercent = Math.max(0, 100 - fitPercent - outsidePercent);
    lines.push(`${crop.cropName}의 적정 pH는 ${range || '작물 기준 범위'}예요.`);
    lines.push('현재는 내 밭의 pH 실측값이 연결되지 않아, 측정값과 적정 범위를 직접 비교할 수 없어요.');
    lines.push(`대신 지역 토양 통계에서 적정 구간 면적은 약 ${fitPercent}%, 적정 구간 밖은 약 ${outsidePercent}%${unclassifiedPercent >= 1 ? `, 미분류는 약 ${unclassifiedPercent}%` : ''}로 나타나 지역 참고값 기준으로 ${soil.label}으로 표시했어요.`);
  } else if (soil.code === 'salinity' && Number.isFinite(soil.observedValue)) {
    lines.push(`확인된 EC는 ${soil.observedValue}dS/m로 ${crop.cropName}의 적정 범위를 벗어나 염류 과다로 판단했어요.`);
  } else if (soil.status === 'GOOD') {
    lines.push(`확인된 토양 항목이 ${crop.cropName}의 적정 범위에 들어왔어요.`);
  } else {
    lines.push(`${crop.cropName}의 토양 기준과 비교한 결과 ${soil.label} 신호가 확인됐어요.`);
  }
  if (soil.referenceOnly) {
    lines.push(`필지 토양검정 결과를 연결하면 ‘내 밭 pH 측정값 ↔ ${crop.cropName} 적정 pH${range ? ` ${range}` : ''}’로 바로 비교해 드려요.`);
  }
  return { title: `${soil.label}으로 판단한 이유`, lines };
}

function disclosureIcon() {
  return `<span class="score-disclosure" aria-hidden="true">
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path d="m6.5 8 3.5 3.5L13.5 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>`;
}

function weatherDayExplanation(day, crop, detail) {
  const dateLabel = day.date
    ? `${Number(day.date.slice(5, 7))}월 ${Number(day.date.slice(8, 10))}일`
    : day.label;
  const matchingOverallTrigger = detail.weather.code === day.code
    ? detail.weather.trigger
    : null;
  const trigger = day.trigger || matchingOverallTrigger;
  const meta = WEATHER_METRIC_COPY[trigger?.metric] || {
    label: '기상값',
    unit: trigger?.unit || '',
  };
  const unit = trigger?.unit || meta.unit || '';
  const exactReading = trigger?.readings?.find((reading) =>
    reading.date === day.date && Number.isFinite(reading.value));
  const reading = exactReading || triggerReading(trigger);
  const threshold = comparisonLabel(trigger?.comparison, unit);
  const lines = [];

  if (reading && threshold) {
    lines.push(`판단 이유: ${meta.label} ${reading.value}${unit}가 ${crop.cropName}의 ${threshold} 기준에 해당해 ${day.statusLabel}로 판단했어요.`);
  } else if (day.status === 'GOOD') {
    lines.push(`${crop.cropName}의 고온·저온·강수·바람 기준을 벗어난 주요 신호가 이 날 예보에서 확인되지 않았어요.`);
  } else {
    const readings = [
      Number.isFinite(day.tMax) ? `최고 ${day.tMax}℃` : null,
      Number.isFinite(day.tMin) ? `최저 ${day.tMin}℃` : null,
      Number.isFinite(day.precipitationProbability) ? `강수확률 ${day.precipitationProbability}%` : null,
      Number.isFinite(day.windSpeed) ? `풍속 ${day.windSpeed}m/s` : null,
    ].filter(Boolean).join(', ');
    lines.push(`판단 이유: ${readings ? `${readings}로 예보돼 ` : ''}${crop.cropName}의 작물별 기준에서 ${day.causeLabel} 신호가 확인됐어요.`);
  }

  if (day.guidance?.reason) {
    lines.push(`작물 영향: ${day.guidance.reason}`);
  }
  if (day.guidance?.actions?.length) {
    day.guidance.actions.forEach((action, index) => {
      lines.push(`${index === 0 ? '주의사항' : '추가 확인'}: ${action}`);
    });
  } else if (day.status !== 'GOOD') {
    lines.push(`주의사항: ${CONDITION_TODOS[day.code] || '작물과 밭 상태를 직접 확인해 주세요.'}`);
  }
  if (day.guidance?.recheck) {
    lines.push(`다시 확인: ${day.guidance.recheck}`);
  } else if (
    day.status !== 'GOOD' &&
    Number.isFinite(day.precipitationProbability) &&
    day.precipitationProbability > 0
  ) {
    lines.push(`강수확률은 ${day.precipitationProbability}%예요. 현장 작업 전에 최신 예보를 한 번 더 확인해 주세요.`);
  }

  return {
    title: `${dateLabel} · ${day.statusLabel} · ${day.causeLabel}`,
    lines,
  };
}

function fillScoreExplanation(selector, copy) {
  const panel = $(selector);
  panel.querySelector('strong').textContent = copy.title;
  const lines = panel.querySelector('.score-explanation-lines');
  lines.replaceChildren(...copy.lines.map((line) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    return paragraph;
  }));
}

function bindScoreExplanation(buttonSelector, panelSelector, peerSelectors = []) {
  const button = $(buttonSelector);
  const panel = $(panelSelector);
  button.onclick = () => {
    const willOpen = panel.hidden;
    for (const [peerButtonSelector, peerPanelSelector] of peerSelectors) {
      const peerButton = $(peerButtonSelector);
      const peerPanel = $(peerPanelSelector);
      peerPanel.hidden = true;
      peerButton.setAttribute('aria-expanded', 'false');
    }
    panel.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
  };
}

// 예보 상태 → 추천 할 일 문구
const CONDITION_TODOS = {
  heat: '아침저녁으로 나눠 물 주기',
  heatwave: '차광막 치고 물 넉넉히 주기',
  cold: '보온 덮개 준비하기',
  frost: '서리 대비 부직포 덮기',
  rain: '비 오기 전 배수로 정리하기',
  downpour: '폭우 대비 배수로·고랑 점검하기',
  wind: '지지대 단단히 고정하기',
  typhoon: '태풍 대비 시설 묶고 미리 수확하기',
  drought: '물 주는 횟수 늘리기',
};

// 토양 상태 → 오늘 할 일 (날씨와 달리 근거 세부 설명은 soilScoreExplanation을 재사용)
const SOIL_TODOS = {
  acidity: '토양 pH 교정 방법(석회 시용 등)을 농업기술센터에 문의하기',
  salinity: '관수로 염류를 씻어내거나 배수를 개선하기',
  drainage: '배수로·고랑을 정비해 물빠짐 개선하기',
  dry: '물 주는 횟수 늘리기',
  overwet: '배수를 개선해 과습 줄이기',
  texture: '유기물 보강 등 토성 개선 방법 문의하기',
};

// 예보 아이콘에 입힐 기존 fx 애니메이션
const ICON_ANIM = {
  clear: 'fx-pulse', stable: 'fx-pulse', drought: 'fx-pulse',
  heat: 'fx-shimmer', heatwave: 'fx-shimmer',
  rain: 'fx-bob', downpour: 'fx-bob', overwet: 'fx-bob',
  cold: 'fx-twinkle', frost: 'fx-twinkle',
  wind: 'fx-drift', typhoon: 'fx-drift',
};

// 오늘의 날씨·토양 판정에서 할 일과 그 이유를 함께 만듦
function todayActionSuggestions(detail, crop) {
  const suggestions = [];
  const today = detail.week[0];

  // 오늘 날씨가 주의·위험이면, 실제 위험 근거(guidance)에서 나온 행동을 그대로 씀
  if (today && (today.status === 'CAUTION' || today.status === 'DANGER')) {
    const sev = today.status === 'DANGER' ? 'danger' : 'warn';
    const guidance = today.guidance;
    const reason = guidance?.reason
      || `오늘 ${CONDITIONS[today.code]?.label || '날씨'} 예보가 있어요 (${CONDITIONS[today.code]?.condition || ''}).`;
    const actions = guidance?.actions?.length ? guidance.actions : [CONDITION_TODOS[today.code] || '밭 상태 살펴보기'];
    actions.forEach((text) => suggestions.push({ text, reason, sev, code: today.code }));
  }

  // 토양이 주의·위험이면(지역 통계든 실측이든), 그 판단 이유와 함께 할 일 추가
  if (detail.soil.status === 'CAUTION' || detail.soil.status === 'DANGER') {
    const sev = detail.soil.status === 'DANGER' ? 'danger' : 'warn';
    const reason = soilScoreExplanation(detail, crop).lines.join(' ');
    suggestions.push({
      text: SOIL_TODOS[detail.soil.code] || '토양 상태 살펴보기',
      reason,
      sev,
      code: detail.soil.code,
    });
  }

  return suggestions;
}

// 종합 점수 링 게이지
function ringGauge(score) {
  const available = Number.isFinite(score);
  const value = available ? score : 0;
  const r = 46, circ = 2 * Math.PI * r;
  const filled = (circ * Math.max(0, Math.min(value, 100))) / 100;
  const color = !available ? '#c8c8bb' : value >= 70 ? '#6f815a' : value >= 50 ? '#c9825b' : '#b04a35';
  return `<svg width="116" height="116" viewBox="0 0 116 116" role="img" aria-label="환경 점수 ${available ? `${value}점` : '산정 중'}">
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="#e6ead6" stroke-width="10"/>
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="${color}" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${filled} ${circ}" transform="rotate(-90 58 58)"/>
    <text x="58" y="56" text-anchor="middle" font-size="27" fill="#4b4237"
      font-family="'Gowun Dodum', sans-serif">${available ? value : '—'}</text>
    <text x="58" y="76" text-anchor="middle" font-size="12" fill="#8a7d6a"
      font-family="'Gowun Dodum', sans-serif">점</text>
  </svg>`;
}

function closeOverlay() {
  const overlay = $('#overlay');
  overlay.hidden = true;
  $('#overlay-panel').classList.remove('detail', 'soil-test-guide');
}

async function openDetailSheet(crop) {
  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.add('detail');
  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <div class="sheet-loading" role="status">
      <span class="loading-seed">⌁</span>
      <p>농장 환경을 분석하고 있어요.</p>
    </div>`;
  overlay.hidden = false;
  $('#sheet-close').onclick = closeOverlay;
  overlay.onclick = (event) => { if (event.target === overlay) closeOverlay(); };

  try {
    const detail = await loadEnvironmentDetail(crop);
    if (overlay.hidden) return;
    renderDetailSheet(panel, crop, detail);
  } catch (error) {
    if (overlay.hidden) return;
    panel.innerHTML = `
      <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
      <p class="eyebrow">상세 보기</p>
      <h2 class="sheet-title">분석을 불러오지 못했어요</h2>
      <p class="sheet-sub error-copy"></p>
      <button class="btn btn-primary btn-wide" id="detail-retry">다시 분석하기</button>`;
    $('.error-copy').textContent = error.message;
    $('#sheet-close').onclick = closeOverlay;
    $('#detail-retry').onclick = () => {
      closeOverlay();
      openDetailSheet(crop);
    };
  }
}

function renderDetailSheet(panel, crop, detail) {
  const born = crop.startedKey ? diffDaysKey(crop.startedKey, todayKey()) + 1 : null;
  const week = detail.week.map((day, index) => ({
    ...day,
    label: index === 0 ? '오늘' : day.date ? DOW[new Date(`${day.date}T00:00:00`).getDay()] : '—',
  }));
  const weatherScore = detail.weather.score;
  const soilScore = detail.soil.score;
  const scoreText = (value) => Number.isFinite(value) ? value : '—';
  const scoreWidth = (value) => Number.isFinite(value) ? value : 0;

  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <p class="eyebrow">${detail.regionLabel || farmRegion} · ${crop.cropName}</p>
    <h2 class="sheet-title">${detail.statusLabel} · ${detail.causeLabel}</h2>
    <p class="sheet-sub">${born ? `태어난 지 ${born}일째 · ` : ''}기상청·농촌진흥청 자료와 작물 기준으로 계산</p>

    <button class="score-hero score-toggle" id="total-score-toggle" type="button"
      aria-label="환경 점수 분석 내용 보기"
      aria-expanded="false" aria-controls="total-score-explanation">
      ${ringGauge(detail.totalScore)}
      <div class="score-hero-text">
        <div class="score-grade">${scoreGrade(detail.totalScore)}</div>
        <div class="score-name">환경 점수</div>
      </div>
      ${disclosureIcon()}
    </button>
    <div class="score-explanation score-explanation-total" id="total-score-explanation" hidden>
      <strong></strong>
      <div class="score-explanation-lines"></div>
    </div>

    <div class="score-row">
      <button class="score-cell score-toggle" id="weather-score-toggle" type="button"
        aria-label="기상 점수 분석 내용 보기"
        aria-expanded="false" aria-controls="weather-score-explanation">
        <div class="sc-head">기상 점수 <strong>${scoreText(weatherScore)}</strong></div>
        <div class="score-bar"><i style="width:${scoreWidth(weatherScore)}%"></i></div>
        ${conditionBadge(detail.weather.code)}
        ${disclosureIcon()}
      </button>
      <button class="score-cell score-toggle" id="soil-score-toggle" type="button"
        aria-label="토양 점수 분석 내용 보기"
        aria-expanded="false" aria-controls="soil-score-explanation">
        <div class="sc-head">토양 점수 <strong>${scoreText(soilScore)}</strong></div>
        <div class="score-bar"><i style="width:${scoreWidth(soilScore)}%"></i></div>
        ${conditionBadge(detail.soil.code)}
        ${detail.soil.referenceOnly ? '<span class="reference-note">지역 토양 참고값</span>' : ''}
        ${disclosureIcon()}
      </button>
    </div>
    <div class="score-axis-explanations">
      <div class="score-explanation" id="weather-score-explanation" hidden>
        <strong></strong>
        <div class="score-explanation-lines"></div>
      </div>
      <div class="score-explanation" id="soil-score-explanation" hidden>
        <strong></strong>
        <div class="score-explanation-lines"></div>
      </div>
    </div>

    ${detail.soil.referenceOnly ? `
      <div class="soil-test-prompt">
        <div>
          <strong>내 밭의 토양값이 필요해요</strong>
          <span class="reference-note">현재는 지역 토양 통계로 계산했어요.</span>
        </div>
        <button class="soil-test-open" id="soil-test-input-open" type="button">
          실측값 입력하기 <span aria-hidden="true">›</span>
        </button>
      </div>
      <p class="wiz-sub" style="text-align:center;margin-top:-4px">
        검사를 아직 안 받아보셨다면
        <button class="link-btn" id="soil-test-guide-open" type="button">무료 토양검정 안내</button>
      </p>` : detail.soil.measurementBasis === 'USER_SOIL_TEST' ? `
      <div class="soil-test-prompt">
        <div>
          <strong>내 밭 실측값으로 분석 중</strong>
          <span class="reference-note">${Number.isFinite(detail.soil.observedValue) ? `등록한 pH ${detail.soil.observedValue} 기준` : '등록한 실측값 기준'}</span>
        </div>
        <button class="soil-test-open" id="soil-test-input-open" type="button">
          값 수정하기 <span aria-hidden="true">›</span>
        </button>
      </div>` : ''}

    <h3 class="section-label">일주일 기상정보</h3>
    ${week.length ? `<div class="week-forecast">
      ${week.map((day, index) => weatherDayMarkup(day, index)).join('')}
    </div>
    <div class="score-explanation weather-day-explanation" id="weather-day-explanation" hidden>
      <strong></strong>
      <div class="score-explanation-lines"></div>
    </div>` : '<p class="empty-note forecast-empty">표시할 단·중기 예보가 없어요.</p>'}`;

  fillScoreExplanation('#total-score-explanation', totalScoreExplanation(detail, crop));
  fillScoreExplanation('#weather-score-explanation', weatherScoreExplanation(detail, crop));
  fillScoreExplanation('#soil-score-explanation', soilScoreExplanation(detail, crop));
  bindScoreExplanation('#total-score-toggle', '#total-score-explanation');
  bindScoreExplanation(
    '#weather-score-toggle',
    '#weather-score-explanation',
    [['#soil-score-toggle', '#soil-score-explanation']],
  );
  bindScoreExplanation(
    '#soil-score-toggle',
    '#soil-score-explanation',
    [['#weather-score-toggle', '#weather-score-explanation']],
  );
  document.querySelectorAll('.wf-day').forEach((button) => {
    button.onclick = () => {
      const day = week[Number(button.dataset.dayIndex)];
      const explanation = $('#weather-day-explanation');
      const willOpen = button.getAttribute('aria-expanded') !== 'true';
      document.querySelectorAll('.wf-day').forEach((peer) => {
        peer.setAttribute('aria-expanded', 'false');
      });
      if (!willOpen) {
        explanation.hidden = true;
        return;
      }
      fillScoreExplanation('#weather-day-explanation', weatherDayExplanation(day, crop, detail));
      explanation.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    };
  });
  const soilTestGuideButton = $('#soil-test-guide-open');
  if (soilTestGuideButton) {
    soilTestGuideButton.onclick = () => renderSoilTestGuide(panel, crop, detail);
  }
  const soilTestInputButton = $('#soil-test-input-open');
  if (soilTestInputButton) {
    soilTestInputButton.onclick = () => renderSoilTestForm(panel, crop, detail);
  }
  $('#sheet-close').onclick = closeOverlay;
}

function renderSoilTestGuide(panel, crop, detail) {
  panel.classList.add('detail', 'soil-test-guide');
  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <button class="sheet-back" id="soil-guide-back" type="button" aria-label="분석 상세로 돌아가기">
      <span aria-hidden="true">‹</span> 분석으로
    </button>

    <div class="soil-guide-heading">
      <div class="soil-guide-illustration" aria-hidden="true">
        <svg width="104" height="104" viewBox="0 0 104 104" fill="none">
          <circle cx="52" cy="52" r="49" fill="#F5F0E4" stroke="#DDD2BC" stroke-width="2"/>
          <path d="M19 73C29 64 41 66 50 70C60 75 73 72 85 66V88H19V73Z" fill="#B69A70"/>
          <path d="M55 38L67 57" stroke="#7B8560" stroke-width="4" stroke-linecap="round"/>
          <path d="M65 54C71 50 77 50 82 53C78 60 73 63 66 61L65 54Z" fill="#87976B" stroke="#6E7D55" stroke-width="1.5"/>
          <path d="M49 39C43 34 38 28 39 21C48 21 55 27 57 35L49 39Z" fill="#98A77A" stroke="#6E7D55" stroke-width="1.5"/>
          <path d="M31 32H49L45 68H35L31 32Z" fill="#FFFDF8" stroke="#8E816E" stroke-width="2"/>
          <path d="M33 49H47" stroke="#D29A70" stroke-width="2" stroke-dasharray="3 3"/>
          <path d="M38 56C40 53 43 53 45 56" stroke="#8E816E" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="37" cy="43" r="1.5" fill="#8E816E"/>
          <circle cx="44" cy="43" r="1.5" fill="#8E816E"/>
        </svg>
      </div>
      <p class="eyebrow">무료 토양검정 안내</p>
      <h2 class="sheet-title">내 밭의 흙을 직접 확인해 보세요</h2>
      <p class="sheet-sub">현재 ${crop.cropName} 분석은 지역 토양 통계를 참고했습니다. 실제 밭의 pH·EC 검사값이 있으면 더 정밀하게 판단할 수 있어요.</p>
    </div>

    <ol class="soil-guide-steps" aria-label="토양검사 신청 순서">
      <li>
        <span class="soil-step-number">1</span>
        <div><strong>농업기술센터에 문의</strong><p>가까운 시·군 농업기술센터에 “토양검정을 받고 싶어요”라고 문의하세요.</p></div>
      </li>
      <li>
        <span class="soil-step-number">2</span>
        <div><strong>안내받은 방법으로 흙 채취</strong><p>밭 여러 지점의 흙을 고르게 섞어 시료를 준비하면 한 지점의 편차를 줄일 수 있어요.</p></div>
      </li>
      <li>
        <span class="soil-step-number">3</span>
        <div><strong>농장 주소·작물과 함께 제출</strong><p>센터가 안내한 양과 용기에 맞춰 시료를 제출하고 결과지를 받아 두세요.</p></div>
      </li>
      <li>
        <span class="soil-step-number">4</span>
        <div><strong>pH·EC 결과로 다시 분석</strong><p>필지 검사값을 연결하면 지역 평균 대신 내 밭 상태를 점수와 행동 안내에 반영할 수 있어요.</p></div>
      </li>
    </ol>

    <div class="soil-guide-note">
      <strong>방문 전에 확인해 주세요</strong>
      <p>무료 지원 여부, 시료의 양·채취 깊이와 처리 기간은 지역별로 다를 수 있습니다.</p>
    </div>

    <a class="btn btn-primary btn-wide soil-guide-nearby"
      href="https://www.nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=208877&amp;menuId=PS00078&amp;totalSearchYn=Y"
      target="_blank" rel="noopener noreferrer">
      <span aria-hidden="true">⌖</span> 우리 지역 농업기술센터 찾기
    </a>`;

  $('#sheet-close').onclick = closeOverlay;
  $('#soil-guide-back').onclick = () => {
    panel.classList.remove('soil-test-guide');
    renderDetailSheet(panel, crop, detail);
  };
}

// 토양검정 결과지를 이미 받은 사용자가 pH·EC 등 실측값을 직접 입력하는 폼.
// 등록하면 지역 통계 대신 이 값으로 분석을 다시 계산한다 (soilTest=USER_SOIL_TEST).
async function renderSoilTestForm(panel, crop, detail) {
  panel.classList.add('detail', 'soil-test-guide');
  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <button class="sheet-back" id="soil-form-back" type="button" aria-label="분석 상세로 돌아가기">
      <span aria-hidden="true">‹</span> 분석으로
    </button>
    <p class="eyebrow">내 밭 실측값 입력</p>
    <h2 class="sheet-title">토양검정 결과지를 입력해 주세요</h2>
    <p class="sheet-sub">등록하면 지역 통계 대신 이 값으로 ${crop.cropName} 분석을 다시 계산해요.</p>
    <p class="sheet-sub">불러오는 중...</p>`;
  $('#sheet-close').onclick = closeOverlay;
  $('#soil-form-back').onclick = () => {
    panel.classList.remove('soil-test-guide');
    renderDetailSheet(panel, crop, detail);
  };

  const existing = await api('/api/me/soil-test');
  if (panel.classList.contains('soil-test-guide') === false) return; // 그새 화면이 바뀌었으면 중단
  const t = existing?.soilTest || {};

  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <button class="sheet-back" id="soil-form-back" type="button" aria-label="분석 상세로 돌아가기">
      <span aria-hidden="true">‹</span> 분석으로
    </button>
    <p class="eyebrow">내 밭 실측값 입력</p>
    <h2 class="sheet-title">토양검정 결과지를 입력해 주세요</h2>
    <p class="sheet-sub">등록하면 지역 통계 대신 이 값으로 ${crop.cropName} 분석을 다시 계산해요.</p>
    <form id="soil-test-form" class="soil-test-form">
      <label class="stf-row">
        <span>토양 산도 (pH) <em>필수</em></span>
        <input type="number" step="0.1" min="3" max="10" name="ph" required value="${t.ph ?? ''}" />
      </label>
      <label class="stf-row">
        <span>염류 농도 EC (dS/m)</span>
        <input type="number" step="0.1" min="0" max="30" name="electricalConductivity" value="${t.electricalConductivity ?? ''}" />
      </label>
      <label class="stf-row">
        <span>검사일</span>
        <input type="date" name="sampledOn" value="${t.sampledOn || todayKey()}" />
      </label>
      <label class="stf-row">
        <span>검사 기관 (선택)</span>
        <input type="text" name="issuer" maxlength="60" placeholder="예: OO시 농업기술센터" value="${t.issuer || ''}" />
      </label>
      <details class="stf-more">
        <summary>더 입력하기 (선택)</summary>
        <label class="stf-row"><span>유기물 (g/kg)</span><input type="number" step="1" min="0" max="500" name="organicMatter" value="${t.organicMatter ?? ''}"/></label>
        <label class="stf-row"><span>유효인산 (mg/kg)</span><input type="number" step="1" min="0" max="3000" name="availablePhosphate" value="${t.availablePhosphate ?? ''}"/></label>
        <label class="stf-row"><span>치환성 K (cmol+/kg)</span><input type="number" step="0.1" min="0" max="100" name="exchangeableK" value="${t.exchangeableK ?? ''}"/></label>
        <label class="stf-row"><span>치환성 Ca (cmol+/kg)</span><input type="number" step="0.1" min="0" max="100" name="exchangeableCa" value="${t.exchangeableCa ?? ''}"/></label>
        <label class="stf-row"><span>치환성 Mg (cmol+/kg)</span><input type="number" step="0.1" min="0" max="100" name="exchangeableMg" value="${t.exchangeableMg ?? ''}"/></label>
      </details>
      <button type="submit" class="btn btn-primary btn-wide">등록하고 다시 분석하기</button>
      ${existing?.soilTest ? '<button type="button" class="link-btn soil-test-clear" id="soil-test-clear">등록한 실측값 지우기</button>' : ''}
    </form>`;

  $('#sheet-close').onclick = closeOverlay;
  $('#soil-form-back').onclick = () => {
    panel.classList.remove('soil-test-guide');
    renderDetailSheet(panel, crop, detail);
  };
  $('#soil-test-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const body = {};
    for (const [key, value] of form.entries()) {
      if (value === '') continue;
      body[key] = key === 'sampledOn' || key === 'issuer' ? value : Number(value);
    }
    const submitBtn = event.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const res = await api('/api/me/soil-test', { method: 'POST', body: JSON.stringify(body) });
    submitBtn.disabled = false;
    if (!res.ok) { toast(res.message || '등록하지 못했어요.'); return; }
    toast('실측값을 등록했어요. 다시 분석할게요.');
    panel.classList.remove('soil-test-guide');
    const refreshed = await loadEnvironmentDetail(crop, { force: true });
    renderDetailSheet(panel, crop, refreshed);
  };
  const clearBtn = $('#soil-test-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      clearBtn.disabled = true;
      await api('/api/me/soil-test/clear', { method: 'POST' });
      toast('등록한 실측값을 지웠어요.');
      panel.classList.remove('soil-test-guide');
      const refreshed = await loadEnvironmentDetail(crop, { force: true });
      renderDetailSheet(panel, crop, refreshed);
    };
  }
}

function weatherDayMarkup(day, index) {
  const severity = day.status === 'DANGER'
    ? 'danger'
    : day.status === 'CAUTION'
      ? 'warn'
      : 'good';
  const temperature = (value) => Number.isFinite(value) ? `${value}°` : '—';
  const rain = Number.isFinite(day.precipitationProbability)
    ? `<span class="wf-rain">비 ${day.precipitationProbability}%</span>`
    : '';
  return `
    <button class="wf-day ${severity} ${index === 0 ? 'today' : ''}" type="button"
      data-day-index="${index}" aria-expanded="false" aria-controls="weather-day-explanation">
      <span class="wf-dow">${day.label}</span>
      <span class="fx ${ICON_ANIM[day.code] || 'fx-pulse'}" style="animation-delay:${index * 0.25}s">
        ${conditionIcon(day.code, 28)}
      </span>
      <span class="wf-hi">${temperature(day.tMax)}</span>
      <span class="wf-lo">${temperature(day.tMin)}</span>
      ${rain}
      <span class="wf-flag ${severity}">${day.statusLabel}</span>
    </button>`;
}

async function doHarvest(cropId) {
  const res = await api('/api/me/harvest', {
    method: 'POST',
    body: JSON.stringify({ cropId }),
  });
  toast(res.message || '수확하지 못했어요.');
  if (!res.ok) return;
  status = res.status;
  activeCropId = null;
  renderHome();
  popVignette();
  // 키우는 작물이 하나도 없으면 바로 새 씨앗 고르기
  if (!(status.crops || []).length) setTimeout(openSeedOverlay, 800);
}

/* ════════════════════════════════════════════
   5. 작물 선택 (온보딩 & 수확 후)
════════════════════════════════════════════ */

let selectableCrops = [];

function cropCardsHTML(list) {
  return list.map((c) => `
    <button type="button" class="crop-card" data-crop="${c.id}">
      ${cropPortrait(c.id)}
      <div class="crop-name">${c.name}</div>
      <div class="crop-days">매일 오면 7일 완성</div>
    </button>`).join('');
}

// 카드 여러 개 토글 선택 → 선택된 id Set을 돌려줌
function bindCropToggle(root, confirmBtn, baseLabel) {
  const picked = new Set();
  root.querySelectorAll('.crop-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.crop;
      if (picked.has(id)) picked.delete(id);
      else picked.add(id);
      card.classList.toggle('selected', picked.has(id));
      confirmBtn.disabled = picked.size === 0;
      confirmBtn.textContent = picked.size > 1 ? `${baseLabel} (${picked.size}개)` : baseLabel;
    });
  });
  return picked;
}

// 선택한 씨앗들을 순서대로 심고 성공 개수를 돌려줌
async function plantSeeds(cropIds, startedDaysAgo = null) {
  let planted = 0;
  let lastMessage = '';
  for (const id of cropIds) {
    const res = await api('/api/me/character', {
      method: 'POST',
      body: JSON.stringify({ characterId: id, startedDaysAgo }),
    });
    if (res.ok) { planted += 1; lastMessage = res.message; }
    else toast(res.message || '씨앗을 심지 못했어요.');
  }
  if (planted === 1) toast(lastMessage);
  else if (planted > 1) toast(`씨앗 ${planted}개를 심었어요! 매일 돌봐주세요.`);
  return planted;
}

/* ════════════════════════════════════════════
   5-0. 시작 마법사 — 질문식 온보딩
   틀: 상태 질문 → (준비 중이면) 지역 → 작물 → 적합성 확인/추천 → 심기
       (이미 재배 중이면) 지역 → 작물 등록
   region.env(작물 적합도 참고용 예시 기후값)는 assessSuitability로만 쓰이고,
   farmRegion(농장 지역, 실제 환경 분석 API에 보내는 값)과는 별개입니다.
════════════════════════════════════════════ */

const REGIONS = [
  { id: 'gangwon',   name: '강원 고랭지',  lat: 37.7, lng: 128.7, env: { tMax: 26, tMin: 16, moisture: 55, ph: 6.2 } },
  { id: 'gyeonggi',  name: '경기 북부',    lat: 37.7, lng: 127.0, env: { tMax: 29, tMin: 20, moisture: 50, ph: 6.4 } },
  { id: 'chungbuk',  name: '충북 내륙',    lat: 36.8, lng: 127.7, env: { tMax: 30, tMin: 21, moisture: 45, ph: 6.3 } },
  { id: 'chungnam',  name: '충남 서해안',  lat: 36.5, lng: 126.6, env: { tMax: 29, tMin: 22, moisture: 60, ph: 6.5 } },
  { id: 'jeonbuk',   name: '전북 평야',    lat: 35.8, lng: 127.0, env: { tMax: 31, tMin: 23, moisture: 55, ph: 6.0 } },
  { id: 'jeonnam',   name: '전남 남해안',  lat: 34.8, lng: 126.7, env: { tMax: 30, tMin: 23, moisture: 65, ph: 6.2 } },
  { id: 'gyeongbuk', name: '경북 내륙',    lat: 36.4, lng: 128.7, env: { tMax: 31, tMin: 21, moisture: 40, ph: 6.3 } },
  { id: 'gyeongnam', name: '경남 남부',    lat: 35.3, lng: 128.3, env: { tMax: 31, tMin: 23, moisture: 55, ph: 6.1 } },
  { id: 'jeju',      name: '제주',         lat: 33.4, lng: 126.5, env: { tMax: 29, tMin: 23, moisture: 60, ph: 5.8 } },
];
const regionOf = (id) => REGIONS.find((r) => r.id === id) || null;
const myRegion = () => regionOf(localStorage.getItem('farm.regionId'));

// ── 지도 API 연동 지점 ──────────────────────────
// 팀 지도 API가 연결되면 아래 두 함수를 실제 지오코딩/역지오코딩으로 교체하면 됩니다.
// 지금은: 좌표 → 가장 가까운 권역 / 주소 문자열 → 키워드 매칭.

// 좌표 → 가까운 권역 (역지오코딩 대체)
function nearestRegion(lat, lng) {
  let best = REGIONS[0], bestD = Infinity;
  for (const r of REGIONS) {
    const d = (r.lat - lat) ** 2 + (r.lng - lng) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

// 주소 문자열 → 권역 (지오코딩 대체: 시/도·주요 시군 키워드 매칭)
const ADDRESS_HINTS = {
  gangwon:   ['강원', '춘천', '원주', '강릉', '평창', '횡성', '홍천', '태백', '속초', '삼척', '정선', '영월', '철원', '인제', '양양', '동해'],
  gyeonggi:  ['경기', '서울', '인천', '수원', '고양', '용인', '성남', '부천', '안산', '파주', '김포', '평택', '안양', '의정부', '남양주', '화성', '이천', '양평', '가평', '포천', '여주', '안성'],
  chungbuk:  ['충북', '청주', '충주', '제천', '음성', '진천', '옥천', '영동', '괴산', '보은', '단양', '증평'],
  chungnam:  ['충남', '대전', '세종', '천안', '아산', '서산', '당진', '보령', '홍성', '예산', '태안', '공주', '논산', '부여', '서천', '금산', '청양', '계룡'],
  jeonbuk:   ['전북', '전주', '군산', '익산', '정읍', '김제', '남원', '완주', '부안', '고창', '임실', '순창', '진안', '무주', '장수'],
  jeonnam:   ['전남', '광주', '목포', '여수', '순천', '나주', '광양', '해남', '고흥', '보성', '무안', '영암', '강진', '장흥', '완도', '진도', '신안', '함평', '영광', '장성', '담양', '곡성', '구례', '화순'],
  gyeongbuk: ['경북', '대구', '포항', '경주', '안동', '구미', '영주', '영천', '상주', '문경', '경산', '의성', '청송', '영양', '영덕', '청도', '고령', '성주', '칠곡', '예천', '봉화', '울진', '울릉'],
  gyeongnam: ['경남', '부산', '울산', '창원', '진주', '김해', '양산', '거제', '통영', '사천', '밀양', '함안', '거창', '창녕', '고성', '하동', '합천', '남해', '함양', '산청', '의령'],
  jeju:      ['제주', '서귀포'],
};
function resolveAddress(text) {
  for (const [id, hints] of Object.entries(ADDRESS_HINTS)) {
    if (hints.some((h) => text.includes(h))) return regionOf(id);
  }
  return null;
}

let wiz = null;

async function startWizard({ skipName = false, settingsOnly = false } = {}) {
  // 첫 방문(로그인 전)에도 작물 목록이 필요 — 공개 API에서 로드
  if (!selectableCrops.length) {
    try {
      const ob = await api('/api/characters');
      selectableCrops = ob.characters || [];
    } catch { /* 서버 없으면 이후 단계에서 안내 */ }
  }
  wiz = { answers: { name: userName || '' }, history: [], settingsOnly };
  show('wizard', { tabbar: false });
  goWiz(settingsOnly ? 'region' : skipName ? 'mode' : 'name');
}

function goWiz(step) { wiz.history.push(step); renderWiz(); }
function backWiz() {
  if (wiz.history.length > 1) { wiz.history.pop(); renderWiz(); }
}

function wizFrame(title, sub, inner, eyebrow = '시작하기') {
  return `
    <p class="eyebrow">${eyebrow}</p>
    <h1 class="wiz-title">${title}</h1>
    ${sub ? `<p class="wiz-sub">${sub}</p>` : ''}
    ${inner}`;
}

function renderWiz() {
  const step = wiz.history[wiz.history.length - 1];
  const back = $('#wiz-back');
  back.hidden = wiz.history.length <= 1;
  back.onclick = backWiz;
  const body = $('#wizard-body');
  const a = wiz.answers;

  // ── 이름 ──
  if (step === 'name') {
    body.innerHTML = wizFrame('어떻게 불러드리면 될까요?',
      '매일 한 번 들르면, 작물이 조금씩 자라요.',
      `<form id="wiz-name-form" class="hello-form" style="max-width:none">
        <input id="wiz-name" type="text" maxlength="10" placeholder="이름 또는 별명" autocomplete="off" value="${a.name || ''}"/>
        <button type="submit" class="btn btn-primary">다음</button>
      </form>`);
    $('#wiz-name-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#wiz-name').value.trim();
      if (!v) { toast('이름을 입력해 주세요.'); return; }
      a.name = v;
      goWiz('mode');
    };
    return;
  }

  // ── 첫 질문: 지금 어떤 상태인가요? ──
  if (step === 'mode') {
    body.innerHTML = wizFrame('지금 어떤 상태인가요?', '상황에 맞게 시작을 도와드릴게요.',
      `<div class="wiz-options">
        <button class="option-card" data-v="growing">
          <b>이미 재배하고 있어요</b>
          <span>밭과 작물이 있어요 — 위치와 작물을 바로 등록해요.</span>
        </button>
        <button class="option-card" data-v="preparing">
          <b>재배를 준비하고 있어요</b>
          <span>생각해 둔 지역과 작물이 잘 맞는지 확인해 드려요.</span>
        </button>
      </div>`);
    body.querySelectorAll('.option-card').forEach((btn) => {
      btn.onclick = () => { a.mode = btn.dataset.v; goWiz('region'); };
    });
    return;
  }

  // ── 위치 확인: 현재 위치 또는 주소로 밭 위치를 찍음 (지도 API 연동 지점) ──
  if (step === 'region') {
    const title = a.mode === 'preparing' ? '밭을 생각해 둔 곳이 어디인가요?' : '밭이 어디에 있나요?';
    body.innerHTML = wizFrame(title, '현재 위치를 쓰거나 주소를 입력하면, 그 지역 기준으로 분석해요.',
      `<button class="option-card" id="wiz-geo">
        <b>📍 현재 위치로 찾기</b>
        <span>브라우저 위치 권한을 한 번 허용해 주세요.</span>
      </button>
      <form id="wiz-addr-form" class="addr-form">
        <input id="wiz-addr" type="text" placeholder="주소로 찾기 (예: 강원 평창군, 전남 해남군)"
          autocomplete="off" value="${a.address || ''}"/>
        <button type="submit" class="addr-find">찾기</button>
      </form>
      <div id="wiz-loc-result"></div>`, '위치 확인');

    const goNext = () => {
      if (wiz.settingsOnly) finishWiz();
      else if (a.mode === 'preparing') goWiz('crop-prep');
      else goWiz('crops-grow');
    };

    // 찾은 위치를 확인 카드로 보여주고, 확정 시 다음 단계로.
    // 화면에는 실제로 찾은 주소만 보여줍니다. region은 적합도 참고용 기후값을
    // 고르는 내부 계산에만 쓰고, 가짜 지역명("경기 북부" 등)은 사용자에게 노출하지 않습니다.
    const showResult = (region, detail, regionLabel = detail) => {
      a.regionId = region.id;
      a.address = detail;
      a.regionLabel = regionLabel;
      $('#wiz-loc-result').innerHTML = `
        <div class="loc-card">
          <div class="loc-info">
            <div class="loc-name">${detail}</div>
          </div>
          <button class="btn btn-primary loc-ok" id="wiz-loc-ok">이 위치로 확인</button>
        </div>`;
      $('#wiz-loc-ok').onclick = goNext;
    };

    // 현재 위치 — 실제 카카오 역지오코딩(흙날씨 v3 코어 백엔드 경유)으로 정확한 주소를 찾습니다.
    $('#wiz-geo').onclick = () => {
      if (!navigator.geolocation) { toast('이 브라우저는 위치를 지원하지 않아요. 주소로 입력해 주세요.'); return; }
      const geoBtn = $('#wiz-geo');
      geoBtn.disabled = true;
      toast('위치를 확인하는 중...');
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          const res = await api('/api/me/location-current', {
            method: 'POST',
            body: JSON.stringify({ latitude, longitude }),
          });
          geoBtn.disabled = false;
          const candidate = res.ok ? res.candidates?.[0] : null;
          if (!candidate) {
            toast(res.message || '현재 위치의 주소를 찾지 못했어요. 주소로 입력해 주세요.', 3200);
            return;
          }
          // 적합도 참고용 9개 대표 권역 중 가장 가까운 곳의 기후값을 씀(실제 위치는 아래 detail에 그대로 표시)
          const referenceRegion = resolveAddress(candidate.displayName) || nearestRegion(latitude, longitude);
          showResult(referenceRegion, candidate.displayName, candidate.displayName);
        },
        () => { geoBtn.disabled = false; toast('위치를 가져오지 못했어요. 주소로 입력해 주세요.', 3200); },
        { timeout: 8000 },
      );
    };

    // 주소 입력 — 실제 카카오 주소 검색(흙날씨 v3 코어 백엔드 경유)으로 전국 어디든 찾습니다.
    $('#wiz-addr-form').onsubmit = async (e) => {
      e.preventDefault();
      const text = $('#wiz-addr').value.trim();
      if (!text) { toast('주소를 입력해 주세요.'); return; }
      const findBtn = $('#wiz-addr-form .addr-find');
      findBtn.disabled = true;
      const res = await api(`/api/me/location-search?q=${encodeURIComponent(text)}`);
      findBtn.disabled = false;
      const candidate = res.ok ? res.candidates?.[0] : null;
      if (!candidate) {
        toast(res.message || '주소를 찾지 못했어요. 다시 확인해 주세요.', 3200);
        return;
      }
      // 적합도 참고용 9개 대표 권역 중 가장 가까운 곳의 기후값을 씀(실제 위치는 아래 detail에 그대로 표시)
      const referenceRegion = resolveAddress(candidate.displayName) || regionOf('gyeonggi');
      showResult(referenceRegion, candidate.displayName, candidate.displayName);
    };

    return;
  }

  // ── (준비 중) 작물 질문 ──
  if (step === 'crop-prep') {
    body.innerHTML = wizFrame('어떤 작물을 키워보고 싶나요?', '골라주시면 지역과 잘 맞는지 확인해 드릴게요.',
      `<div class="crop-grid">${cropCardsHTML(selectableCrops)}</div>`, '작물 확인');
    body.querySelectorAll('.crop-card').forEach((card) => {
      card.onclick = () => { a.cropId = card.dataset.crop; goWiz('check'); };
    });
    return;
  }

  // ── (준비 중) 적합성 확인 + 추천 지역 ──
  if (step === 'check') {
    const region = regionOf(a.regionId);
    const suit = assessSuitability(a.cropId, region.env);
    const cropName = CROP_NAMES[a.cropId] || a.cropId;
    const good = suit.score >= 60;

    // 다른 지역 점수를 계산해 더 좋은 곳 추천
    const better = REGIONS
      .filter((r) => r.id !== a.regionId)
      .map((r) => ({ ...r, score: assessSuitability(a.cropId, r.env).score }))
      .filter((r) => r.score > suit.score)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3);

    const devLines = suit.deviations.map((d) => {
      const nameMap = { temp: '기온', moisture: '토양 수분', ph: '산도(pH)' };
      return `${nameMap[d.factor]}이(가) 적정(${d.optimal.min}~${d.optimal.max}${d.unit})보다 ${d.status === 'high' ? '높아요' : '낮아요'}`;
    });

    body.innerHTML = wizFrame(`${region.name}에서 ${cropName}, 어떨까요?`, '',
      `<div class="score-hero">
        ${ringGauge(suit.score)}
        <div class="score-hero-text">
          <div class="score-grade">${suit.verdict}</div>
          <div class="score-name">${cropName} 재배 적합도</div>
        </div>
      </div>
      ${devLines.length ? `<p class="wiz-sub" style="text-align:center">${devLines.join(' · ')}</p>` : `<p class="wiz-sub" style="text-align:center">기온·수분·산도 모두 ${cropName}에게 알맞아요.</p>`}
      ${!good && better.length ? `
        <h3 class="section-label">주변 추천 지역</h3>
        <div class="wiz-recos">
          ${better.map((r) => `
            <div class="wiz-reco">
              <span class="wr-name">${r.name}</span>
              <span class="wr-score">${r.score}점</span>
              <button class="link-btn wr-move" data-r="${r.id}">여기로 변경</button>
            </div>`).join('')}
        </div>` : ''}
      <div class="wiz-actions">
        <button class="btn btn-primary btn-wide" id="wiz-check-go">
          ${good ? '이 지역에서 시작하기' : '그래도 여기서 시작하기'}
        </button>
      </div>`, '적합성 확인');

    body.querySelectorAll('.wr-move').forEach((btn) => {
      btn.onclick = () => {
        const region = regionOf(btn.dataset.r);
        a.regionId = region.id;
        a.regionLabel = region.name;
        renderWiz();
      };
    });
    $('#wiz-check-go').onclick = finishWiz;
    return;
  }

  // ── (이미 재배 중) 키우는 작물 등록 ──
  if (step === 'crops-grow') {
    body.innerHTML = wizFrame('어떤 작물을 키우고 있나요?', '여러 개를 골라도 좋아요.',
      `<div class="crop-grid">${cropCardsHTML(selectableCrops)}</div>
      <button class="btn btn-primary btn-wide" id="wiz-crops-done" disabled>등록하기</button>`, '작물 등록');
    const confirm = $('#wiz-crops-done');
    const picked = bindCropToggle(body, confirm, '등록하기');
    confirm.onclick = () => {
      if (!picked.size) return;
      a.cropIds = [...picked];
      finishWiz();
    };
    return;
  }
}

async function finishWiz() {
  const a = wiz.answers;
  if (a.name && a.name !== userName) {
    userName = a.name;
    localStorage.setItem('farm.name', userName);
  }
  if (a.regionId) localStorage.setItem('farm.regionId', a.regionId);
  if (a.regionLabel) {
    farmRegion = a.regionLabel;
    localStorage.setItem('farm.region', farmRegion);
    environmentCache.clear();
  }

  if (wiz.settingsOnly) {
    toast('재배지 설정을 저장했어요.');
    renderSettings();
    show('settings');
    return;
  }

  const ids = a.cropIds && a.cropIds.length ? a.cropIds : a.cropId ? [a.cropId] : [];
  const planted = ids.length ? await plantSeeds(ids) : 0;
  await refreshStatus();
  activeCropId = ids[0] || null;
  renderHome();
  show('home');
  if (planted > 0) popVignette();
  maybeOfferCheckin();
}

// 새 작물 추가 시트 (+ 아이콘): 아직 키우지 않는 작물만 보여줌
function openSeedOverlay() {
  const growing = new Set((status?.crops || []).map((c) => c.cropId));
  const available = selectableCrops.filter((c) => !growing.has(c.id));
  if (!available.length) { toast('이미 모든 작물을 키우고 있어요.'); return; }

  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.remove('detail'); // 상세 보기 시트 흔적 제거

  // ① 작물 선택
  panel.innerHTML = `
    <p class="eyebrow">새 씨앗 · 1/2</p>
    <h2 style="font-size:20px;font-weight:400;margin-bottom:4px">무엇을 더 키워볼까요?</h2>
    <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px">고르면 내 재배지와 잘 맞는지 확인해 드려요.</p>
    <div class="crop-grid">${cropCardsHTML(available)}</div>
    <button class="btn btn-primary btn-wide" id="overlay-confirm" disabled>다음</button>`;
  overlay.hidden = false;
  const confirm = panel.querySelector('#overlay-confirm');
  const picked = bindCropToggle(panel, confirm, '다음');

  // ② 적합성 확인 후 심기
  confirm.onclick = () => {
    if (!picked.size) return;
    const ids = [...picked];
    const region = myRegion();
    const rows = ids.map((id) => {
      const name = CROP_NAMES[id] || id;
      if (!region) return `<div class="wiz-reco"><span class="wr-name">${name}</span><span class="wr-score">지역 미설정</span></div>`;
      const s = assessSuitability(id, region.env);
      return `<div class="wiz-reco">
        <span class="wr-name">${name}</span>
        <span class="wr-score">${s.score}점</span>
        <span class="wf-flag ${s.score >= 60 ? 'good' : 'warn'}">${s.verdict}</span>
      </div>`;
    }).join('');
    panel.innerHTML = `
      <p class="eyebrow">새 씨앗 · 2/2</p>
      <h2 style="font-size:20px;font-weight:400;margin-bottom:4px">${region ? `${region.name} 기준 적합도예요` : '적합도 확인'}</h2>
      <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px">
        ${region ? '점수가 낮아도 심을 수는 있어요. 더 자주 돌봐주면 돼요.' : '설정에서 재배지를 등록하면 적합도를 확인할 수 있어요.'}
      </p>
      <div class="wiz-recos" style="margin-bottom:16px">${rows}</div>
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:13px;color:var(--ink-soft);margin-bottom:6px">
          이미 키우고 있는 작물이라면 며칠째인지 적어주세요 (처음 심는 거면 비워두세요)
        </label>
        <input id="overlay-days-ago" type="number" min="0" max="60" placeholder="예: 10"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:14px" />
      </div>
      <button class="btn btn-primary btn-wide" id="overlay-plant">씨앗 심기 (${ids.length}개)</button>`;
    panel.querySelector('#overlay-plant').onclick = async () => {
      panel.querySelector('#overlay-plant').disabled = true;
      const daysInput = panel.querySelector('#overlay-days-ago')?.value;
      const startedDaysAgo = daysInput !== '' && Number.isFinite(Number(daysInput)) ? Number(daysInput) : null;
      const planted = await plantSeeds(ids, startedDaysAgo);
      overlay.hidden = true;
      if (planted > 0) {
        await refreshStatus();
        activeCropId = ids[0];
        renderHome();
        popVignette();
      }
    };
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
}

/* ════════════════════════════════════════════
   5-2. 할 일
════════════════════════════════════════════ */

const TODO_SUGGESTS = ['물 주기', '잎 상태 보기', '환기하기', '오늘 사진 한 장'];

function todoCheckSvg(done) {
  return done
    ? `<svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#e6ead6" stroke="#aab98d" stroke-width="1.6"/>
        <path d="M7.5 12.4 l3 3 l6 -7" fill="none" stroke="#55663f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#fdfbf4" stroke="#d8cdb4" stroke-width="1.6"/>
      </svg>`;
}

async function addTodo(text) {
  const res = await api('/api/me/todos', { method: 'POST', body: JSON.stringify({ text }) });
  if (!res.ok) { toast(res.message || '추가하지 못했어요.'); return; }
  renderTodoList(res.todos);
}

function renderTodoList(todos) {
  const doneCount = todos.filter((t) => t.done).length;
  $('#todo-summary').textContent = todos.length
    ? `모두 ${todos.length}개 · 끝낸 일 ${doneCount}개`
    : '';

  $('#todo-list').innerHTML = todos.length
    ? todos.map((t) => `
      <div class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
        <button class="todo-check" aria-label="완료 표시">${todoCheckSvg(t.done)}</button>
        <span class="todo-text"></span>
        <span class="todo-date">${fmtKey(t.createdKey)}</span>
        <button class="todo-del" aria-label="삭제">✕</button>
      </div>`).join('')
    : `<p class="empty-note">아직 할 일이 없어요.<br/>아래에서 하나 골라 시작해볼까요?</p>`;

  // 사용자 입력 텍스트는 innerHTML 대신 textContent로 안전하게 채움
  document.querySelectorAll('.todo-item').forEach((el, i) => {
    el.querySelector('.todo-text').textContent = todos[i].text;
    el.querySelector('.todo-check').onclick = async () => {
      const res = await api('/api/me/todos/toggle', {
        method: 'POST', body: JSON.stringify({ id: el.dataset.id }),
      });
      if (res.ok) renderTodoList(res.todos);
    };
    el.querySelector('.todo-del').onclick = async () => {
      const res = await api('/api/me/todos/delete', {
        method: 'POST', body: JSON.stringify({ id: el.dataset.id }),
      });
      if (res.ok) renderTodoList(res.todos);
    };
  });

  // 목록이 비어 있을 때만 추천 칩 노출
  $('#todo-suggest').innerHTML = todos.length
    ? ''
    : TODO_SUGGESTS.map((s) => `<button class="suggest-chip">${s}</button>`).join('');
  document.querySelectorAll('.suggest-chip').forEach((chip) => {
    chip.onclick = () => addTodo(chip.textContent);
  });
}

// 할 일이 비어 있으면 오늘의 날씨·토양 API 데이터로 3~4개를 자동으로 채워 넣음
// (부족하면 일반 추천으로 채움). 실제 이유는 상세 보기에서 확인할 수 있음.
async function autoAssignTodayTodos() {
  const crop = getActiveCrop();
  if (!crop) return null;
  let detail;
  try {
    detail = await loadEnvironmentDetail(crop);
  } catch {
    return null;
  }
  const suggestions = todayActionSuggestions(detail, crop);
  const texts = suggestions.map((s) => `${s.text} (${CONDITIONS[s.code]?.label || '주의'} 대비)`);
  for (const generic of TODO_SUGGESTS) {
    if (texts.length >= 3) break;
    if (!texts.some((t) => t.startsWith(generic))) texts.push(generic);
  }
  let latest = null;
  for (const text of texts.slice(0, 4)) {
    const res = await api('/api/me/todos', { method: 'POST', body: JSON.stringify({ text }) });
    if (res.ok) latest = res.todos;
  }
  return latest;
}

async function renderTodos() {
  const data = await api('/api/me/todos');
  let todos = data.todos || [];
  if (!todos.length) {
    const autoFilled = await autoAssignTodayTodos();
    if (autoFilled) todos = autoFilled;
  }
  renderTodoList(todos);
}

/* ════════════════════════════════════════════
   6. 교환소
════════════════════════════════════════════ */

const ORDER_LABEL = {
  requested: '신청됨', approved: '승인', shipped: '발송', done: '완료', canceled: '취소',
};

async function renderRewards() {
  const data = await api('/api/me/rewards');

  $('#point-board').innerHTML = `
    <div>
      <div class="pb-label">모은 포인트</div>
      <div class="pb-value">${data.points.toLocaleString()}P</div>
    </div>
    <div class="pb-note">이번 달 교환 가능<br/><strong>${data.remainingMonthly}회</strong> 남음</div>`;

  $('#reward-list').innerHTML = data.catalog.map((r, i) => {
    const disabled = r.soldOut || !r.affordable || data.remainingMonthly < 1;
    const note = r.soldOut ? '품절'
      : !r.affordable ? `${(r.pointCost - data.points).toLocaleString()}P 더 모으면 돼요`
      : data.remainingMonthly < 1 ? '이번 달 한도 소진'
      : '';
    return `
    <div class="reward-card">
      ${sackIcon(i)}
      <div class="reward-info">
        <div class="r-name">${r.name}</div>
        <div class="r-real">${r.realItem} · 남은 수량 ${Number.isFinite(r.remainingStock) ? r.remainingStock : '∞'}</div>
        ${note ? `<div class="r-stock">${note}</div>` : ''}
      </div>
      <button class="reward-buy" data-reward="${r.id}" ${disabled ? 'disabled' : ''}>
        ${r.pointCost.toLocaleString()}P
      </button>
    </div>`;
  }).join('');

  document.querySelectorAll('.reward-buy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await api('/api/me/redeem', {
        method: 'POST',
        body: JSON.stringify({ rewardId: btn.dataset.reward }),
      });
      toast(res.message);
      await renderRewards();
      await refreshStatus();
    });
  });

  const orders = [...(data.redemptions || [])].reverse();
  $('#order-list').innerHTML = orders.length
    ? orders.map((o) => `
      <div class="order-item">
        <span class="o-name">${o.name}</span>
        <span class="o-date">${fmtKey(o.requestedKey)}</span>
        <span class="order-status ${o.status === 'canceled' ? 'canceled' : ''}">${ORDER_LABEL[o.status] || o.status}</span>
        ${(o.status === 'requested' || o.status === 'approved')
          ? `<button class="order-cancel" data-order="${o.orderId}">취소</button>` : ''}
      </div>`).join('')
    : `<p class="empty-note">아직 신청 내역이 없어요.<br/>꾸준히 모으면 2주쯤 뒤 첫 비료를 바꿀 수 있어요.</p>`;

  document.querySelectorAll('.order-cancel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api('/api/me/redeem/cancel', {
        method: 'POST',
        body: JSON.stringify({ orderId: btn.dataset.order }),
      });
      toast(res.ok ? '주문을 취소하고 포인트를 돌려드렸어요.' : res.message);
      await renderRewards();
      await refreshStatus();
    });
  });
}

/* ════════════════════════════════════════════
   7. 기록
════════════════════════════════════════════ */

const CROP_NAMES = { lettuce: '상추', cucumber: '오이', potato: '감자', apple: '사과', pear: '배' };
const STAGE_NAME_HINT = {
  seed: '씨앗', sprout: '새싹', seedling: '어린 모종', sapling: '묘목',
  young: '어린 나무', grown: '성목', leafing: '잎 자라는 중', bulking: '알 굵는 중',
  growing: '자라는 중', flower: '꽃', blossom: '꽃', fruit: '열매', mature: '다 자람',
};

function diaryDateLabel(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${DOW[date.getDay()]})`;
}

// '씨앗' → '씨앗이었던' / '새싹' → '새싹이었던' / '꽃' → '꽃이었던' / '열매' → '열매였던'
// (받침이 있으면 '이었던', 없으면 '였던')
function stageWas(word) {
  if (!word) return '';
  const code = word.charCodeAt(word.length - 1);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return word + (hasFinal ? '이었던' : '였던');
}

/* ── 사진 붙이기 ──────────────────────────────
   기기에서 고른(또는 찍은) 사진을 브라우저에서 작게 줄여 dataURL로 만듭니다.
   원본을 그대로 올리면 용량이 커서 저장이 거절되기 때문입니다. */
function fileToDataURL(file, max = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('read-fail')); };
    img.src = url;
  });
}

function cameraIcon(s = 17) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 7.4 Q3 6 4.4 6 H6 l1.2 -1.8 h5.6 L14 6 h1.6 Q17 6 17 7.4 V14 Q17 15.4 15.6 15.4 H4.4 Q3 15.4 3 14 Z"/>
    <circle cx="10" cy="10.5" r="3"/>
  </svg>`;
}
function albumIcon(s = 17) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.6" y="5.4" width="12" height="10" rx="1.8"/>
    <path d="M6.4 5.4 V4.2 Q6.4 3 7.6 3 H16 Q17.4 3 17.4 4.4 V12.4"/>
    <path d="M4.6 13.4 l2.6 -2.8 l2 2 l2 -2.4 l2.2 3.2"/>
    <circle cx="6.4" cy="8.4" r="1"/>
  </svg>`;
}

// 하루에 넣을 수 있는 사진 장수 (서버와 같은 값)
const PHOTO_MAX = 6;

// 오늘 일기에 붙일 사진들 (dataURL 배열) — 저장 전까지 화면에만 들고 있음
let diaryPhotos = [];
// 달력에서 날짜를 눌렀을 때 보여줄 기록들
let diaryEntries = [];

// 기록 한 건의 사진 목록 (예전 한 장짜리 형식도 함께 처리)
const photosOf = (entry) =>
  (entry && (entry.photos || (entry.photo ? [entry.photo] : []))) || [];

// 사진 미리보기 + 촬영/보관함 버튼 그리기
function renderPhotoPicker() {
  const full = diaryPhotos.length >= PHOTO_MAX;
  $('#photo-slot').innerHTML = diaryPhotos.length
    ? `<div class="photo-grid">
         ${diaryPhotos.map((p, i) => `
           <div class="photo-cell">
             <img src="${p}" alt="붙인 사진 ${i + 1}"/>
             <button class="photo-remove" data-i="${i}" aria-label="${i + 1}번째 사진 떼기">✕</button>
           </div>`).join('')}
         ${full ? '' : `<button class="photo-add" id="photo-add" aria-label="사진 더 넣기">+</button>`}
       </div>
       <p class="photo-count">사진 ${diaryPhotos.length}장 / 최대 ${PHOTO_MAX}장</p>`
    : `<button class="photo-empty" id="photo-empty">
         사진이 없어요<span>눌러서 사진을 넣어주세요 (최대 ${PHOTO_MAX}장)</span>
       </button>`;
  $('#photo-row').innerHTML = `
    <button class="photo-btn" id="photo-camera">${cameraIcon()}<span>사진 찍기</span></button>
    <button class="photo-btn" id="photo-pick">${albumIcon()}<span>보관함에서 고르기</span></button>`;

  const openPicker = () => {
    if (diaryPhotos.length >= PHOTO_MAX) { toast(`사진은 ${PHOTO_MAX}장까지 넣을 수 있어요.`); return; }
    $('#photo-pick-input').click();
  };
  $('#photo-camera').onclick = () => {
    if (diaryPhotos.length >= PHOTO_MAX) { toast(`사진은 ${PHOTO_MAX}장까지 넣을 수 있어요.`); return; }
    $('#photo-camera-input').click();
  };
  $('#photo-pick').onclick = openPicker;
  const add = $('#photo-add');
  if (add) add.onclick = openPicker;
  const empty = $('#photo-empty');
  if (empty) empty.onclick = openPicker; // 빈칸을 눌러도 보관함이 열림

  $('#photo-slot').querySelectorAll('.photo-remove').forEach((btn) => {
    btn.onclick = () => {
      diaryPhotos.splice(Number(btn.dataset.i), 1);
      renderPhotoPicker();
    };
  });
}

// 두 파일 입력(카메라/보관함)은 한 번만 연결해두고 재사용
function bindPhotoInputs() {
  for (const id of ['#photo-camera-input', '#photo-pick-input']) {
    $(id).addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = ''; // 같은 사진을 다시 골라도 이벤트가 오도록 초기화
      if (!files.length) return;

      const room = PHOTO_MAX - diaryPhotos.length;
      const picked = files.filter((f) => f.type.startsWith('image/')).slice(0, room);
      if (!picked.length) { toast('사진 파일만 붙일 수 있어요.'); return; }

      let failed = 0;
      for (const file of picked) {
        try {
          diaryPhotos.push(await fileToDataURL(file));
        } catch { failed++; }
      }
      renderPhotoPicker();
      if (failed) toast(`${failed}장은 읽지 못했어요. 다른 사진으로 해볼까요?`);
      else if (files.length > room) toast(`${picked.length}장만 붙였어요. (최대 ${PHOTO_MAX}장)`);
      else toast(`사진 ${picked.length}장을 붙였어요. 저장하면 그날 기록에 남아요.`);
    });
  }
}

async function renderDiary() {
  const data = await api('/api/me/diary');
  const entries = [...(data.entries || [])].sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  diaryEntries = entries;
  const tKey = todayKey();
  const todayEntry = entries.find((e) => e.dayKey === tKey);

  const titleInput = $('#diary-title');
  const textarea = $('#diary-text');
  const saveBtn = $('#diary-save');
  // 입력 중이면 값을 덮어쓰지 않음
  const editing = document.activeElement === textarea || document.activeElement === titleInput;
  if (!editing) {
    titleInput.value = (todayEntry && todayEntry.title) || '';
    textarea.value = todayEntry ? todayEntry.text : '';
    diaryPhotos = photosOf(todayEntry);
  }
  renderPhotoPicker();
  saveBtn.textContent = todayEntry ? '오늘 기록 고쳐 쓰기' : '오늘 기록 남기기';
  $('#diary-hint').textContent = todayEntry ? '비우고 저장하면 지워져요' : '한 줄이나 사진 한 장이면';

  saveBtn.onclick = async () => {
    const title = titleInput.value.trim();
    const text = textarea.value.trim();
    if (!title && !text && !diaryPhotos.length && !todayEntry) {
      toast('제목이나 내용을 적거나, 사진을 붙여주세요.');
      return;
    }
    saveBtn.disabled = true;
    const res = await api('/api/me/diary', {
      method: 'POST',
      body: JSON.stringify({ title, text, photos: diaryPhotos }),
    });
    saveBtn.disabled = false;
    if (!res.ok) { toast(res.message || '저장하지 못했어요.'); return; }
    toast(res.deleted ? '오늘 일기를 지웠어요.' : '오늘의 기록을 심어뒀어요.');
    if (res.deleted) diaryPhotos = [];
    await renderDiary();
    renderCalendar(); // 달력의 사진 표시도 갱신
  };

  const list = $('#diary-list');
  list.innerHTML = entries.length
    ? entries.map((e) => {
      const ph = photosOf(e);
      return `
      <div class="diary-item">
        ${ph.length
          ? `<div class="d-photo-wrap">
               <img class="d-photo" src="${ph[0]}" alt="${diaryDateLabel(e.dayKey)} 사진"/>
               ${ph.length > 1 ? `<span class="d-photo-more">+${ph.length - 1}</span>` : ''}
             </div>`
          : (e.cropId ? cropPortrait(e.cropId, e.stageKey || 'sprout') : cropPortrait('cucumber', 'sprout'))}
        <div class="d-body">
          <div class="d-date">${diaryDateLabel(e.dayKey)}${
            e.cropId ? ` · ${CROP_NAMES[e.cropId] || ''} ${STAGE_NAME_HINT[e.stageKey] || ''}` : ''}</div>
          ${e.title ? `<div class="d-title"></div>` : ''}
          <div class="d-text"></div>
        </div>
      </div>`;
    }).join('')
    : `<p class="empty-note">첫 일기가 아직 없어요.<br/>한 줄이나 사진 한 장이면 충분해요.</p>`;
  // 제목·본문은 사용자가 쓴 글이라 textContent로 넣습니다 (HTML로 해석되지 않게)
  list.querySelectorAll('.d-body').forEach((body, i) => {
    const t = body.querySelector('.d-title');
    if (t) t.textContent = entries[i].title;
    body.querySelector('.d-text').textContent = entries[i].text;
  });
}

/* ── 달력 ────────────────────────────────────
   날짜를 누르면 그날의 기록(사진·일기·작물 모습)을 시트로 띄웁니다. */
function renderCalendar() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  $('#calendar-title').textContent = `${y}년 ${m + 1}월`;
  const checked = new Set(status.attendanceHistory || []);
  const withPhoto = new Set(diaryEntries.filter((e) => photosOf(e).length).map((e) => e.dayKey));
  const withDiary = new Set(diaryEntries.map((e) => e.dayKey));
  const tKey = todayKey(now);
  const first = new Date(y, m, 1);
  const days = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 월요일 시작

  let html = ['월', '화', '수', '목', '금', '토', '일']
    .map((d) => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < lead; i++) html += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const key = todayKey(new Date(y, m, d));
    const cls = [
      'day',
      checked.has(key) ? 'checked' : '',
      key === tKey ? 'today' : '',
      withDiary.has(key) ? 'has-rec' : '',
      withPhoto.has(key) ? 'has-photo' : '',
    ].join(' ');
    html += `<button class="${cls}" data-key="${key}"
      aria-label="${m + 1}월 ${d}일 기록 보기">${d}</button>`;
  }
  $('#calendar').innerHTML = html;

  $('#calendar').querySelectorAll('.day').forEach((cell) => {
    cell.onclick = () => openDayRecord(cell.dataset.key);
  });
}

// 그날의 기록 시트
function openDayRecord(dayKey) {
  const entry = diaryEntries.find((e) => e.dayKey === dayKey);
  const attended = (status.attendanceHistory || []).includes(dayKey);
  if (!entry && !attended) {
    toast(`${diaryDateLabel(dayKey)}에는 남긴 기록이 없어요.`);
    return;
  }

  const photos = photosOf(entry);
  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.remove('detail');
  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <p class="eyebrow">${attended ? '출석한 날' : '기록'}</p>
    <h2 class="sheet-title">${diaryDateLabel(dayKey)}</h2>
    ${entry && entry.cropId
      ? `<p class="sheet-sub">${CROP_NAMES[entry.cropId] || ''} · ${stageWas(STAGE_NAME_HINT[entry.stageKey] || '')} 날${
          photos.length > 1 ? ` · 사진 ${photos.length}장` : ''}</p>`
      : ''}
    ${entry && entry.title ? `<p class="day-title"></p>` : ''}
    ${photos.length
      ? photos.map((p, i) => `
          <div class="day-photo">
            <img src="${p}" alt="${diaryDateLabel(dayKey)} 사진 ${i + 1}"/>
            ${photos.length > 1 ? `<span class="day-photo-no">${i + 1} / ${photos.length}</span>` : ''}
          </div>`).join('')
      : `<div class="photo-empty static">사진이 없어요<span>이 날은 사진을 남기지 않았어요</span></div>`}
    ${entry && entry.text ? `<p class="day-text"></p>` : ''}
    ${!entry ? `<p class="empty-note">출석은 했지만 일기는 없는 날이에요.</p>` : ''}`;

  if (entry && entry.title) panel.querySelector('.day-title').textContent = entry.title;
  if (entry && entry.text) panel.querySelector('.day-text').textContent = entry.text;
  overlay.hidden = false;
  $('#sheet-close').onclick = closeOverlay;
  overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };
}

async function renderRecords() {
  $('#stat-row').innerHTML = `
    <div class="stat-cell"><div class="s-value">${status.streak}</div><div class="s-label">연속 출석</div></div>
    <div class="stat-cell"><div class="s-value">${status.longestStreak}</div><div class="s-label">최고 연속</div></div>
    <div class="stat-cell"><div class="s-value">${status.totalCheckIns}</div><div class="s-label">누적 출석</div></div>`;

  const done = status.completedCrops || [];
  $('#harvest-list').innerHTML = done.length
    ? done.map((c) => `
      <div class="harvest-item">
        ${cropPortrait(c.cropId)}
        <span>듬직한 ${CROP_NAMES[c.cropId] || c.cropId}</span>
        <span class="h-date">${c.finishedKey ? fmtKey(c.finishedKey) + ' 수확' : ''}</span>
      </div>`).join('')
    : `<p class="empty-note">아직 다 키운 작물이 없어요.<br/>7일만 꾸준히 오면 첫 수확이에요.</p>`;

  await renderDiary();  // 일기·사진을 먼저 불러오고
  renderCalendar();     // 달력에 사진 표시를 붙임
}

/* ════════════════════════════════════════════
   7-1. 흙톡 — 재배 지식 챗봇 (규칙 기반)
   작물 5종 × 주제 7개 지식 베이스 + 키워드 매칭.
   Gemini(서버 중계)가 되면 그걸 우선 쓰고, 안 되면 이 규칙 기반으로 대체합니다.
════════════════════════════════════════════ */

const TOPIC_LABELS = {
  plant: '심는 시기', water: '물 주기', temp: '온도', pest: '병해충',
  harvest: '수확', soil: '흙·거름', tip: '초보 팁',
};

const CROP_KB = {
  lettuce: {
    plant: '상추는 서늘할 때 잘 자라서 봄(3~4월)과 가을(8~9월)에 심어요. 씨앗은 흙을 아주 얇게 덮고, 모종은 20cm 간격이면 충분해요.',
    water: '잎채소라 물을 좋아해요. 겉흙이 마르면 아침에 흠뻑 주세요. 다만 물이 고이면 뿌리가 상하니 배수는 꼭 챙겨요.',
    temp: '15~20℃의 서늘한 날씨를 가장 좋아해요. 25℃를 넘으면 쓴맛이 나고 꽃대가 올라와요(추대). 한여름엔 반그늘이 좋아요.',
    pest: '진딧물과 민달팽이를 조심하세요. 통풍을 좋게 하고, 보이는 즉시 잡아주는 게 최고예요. 진딧물엔 물을 세게 뿌려 떨어뜨리는 것도 도움돼요.',
    harvest: '심은 지 30~40일이면 겉잎부터 딸 수 있어요. 속잎을 남기고 겉잎만 따면 한 포기로 오래오래 수확할 수 있어요.',
    soil: '물 빠짐 좋은 흙에 심기 2주 전 퇴비를 섞어두세요. pH 6.0~6.8이 적당해요.',
    tip: '핵심은 "겉잎 수확"이에요. 한 번에 다 뽑지 말고 겉잎부터 따면 계속 자라요. 여름 직사광선은 피해주세요.',
  },
  cucumber: {
    plant: '오이는 추위에 약해서 늦서리가 지난 5월 초에 모종으로 심는 게 일반적이에요. 덩굴이 타고 오를 지주대를 꼭 세우고, 포기 사이는 40~50cm 띄워요.',
    water: '오이는 90%가 수분이라 물을 정말 많이 먹어요. 2~3일에 한 번 흠뻑, 한여름엔 매일 아침 주세요. 잎에 물이 닿으면 병이 생기기 쉬우니 뿌리 쪽에 주세요.',
    temp: '22~28℃가 최적이에요. 10℃ 아래로 내려가면 냉해를 입으니 초봄 밤 기온을 조심하세요.',
    pest: '잎에 노균병·흰가루병이 잘 와요. 아랫잎을 정리해 통풍시키고, 잎이 얼룩지면 그 잎은 바로 떼어내세요. 진딧물·응애도 잎 뒷면을 종종 확인해요.',
    harvest: '꽃 핀 지 7~10일, 20cm쯤 됐을 때 어린 오이를 따는 게 가장 맛있어요. 자주 딸수록 새 오이가 계속 열려요.',
    soil: '거름을 많이 먹는 작물이에요. 밑거름을 넉넉히 하고 자라는 동안 웃거름을 2~3번 더 줘요. pH 5.8~6.8.',
    tip: '지주대에 덩굴을 감아 유인해주고, 아래쪽 곁순(아들줄기)은 정리해주면 열매가 실해져요. 물 부족하면 오이가 쓴맛이 나요.',
  },
  potato: {
    plant: '봄감자는 3월 중하순에 씨감자를 심어요. 씨감자는 눈이 1~2개씩 붙게 잘라 2~3일 말린 뒤, 깊이 5~10cm·간격 25~30cm로 심어요.',
    water: '감자는 과습에 아주 약해요. 물 빠짐이 최우선이고, 물은 심하게 가물 때만 주면 돼요. 장마철 물 고임을 꼭 피해주세요.',
    temp: '14~23℃의 서늘한 기후를 좋아해요. 날이 너무 더우면 알이 굵어지지 않아요.',
    pest: '역병(잎이 검게 마름)과 진딧물, 땅속 굼벵이를 조심하세요. 같은 자리에 해마다 심으면(연작) 병이 심해지니 자리를 바꿔주세요.',
    harvest: '심은 지 90~100일, 잎과 줄기가 누렇게 마르면 캘 때예요. 맑은 날 캐서 그늘에서 말려 보관하세요.',
    soil: '물 빠짐 좋은 모래참흙이 최고예요. pH 5.0~6.5로 산성 흙에도 강해요. 자라는 동안 흙을 두 번쯤 북돋아주면(북주기) 감자가 초록으로 변하는 걸 막아요.',
    tip: '꽃이 피면 땅속에서 알이 굵고 있다는 신호예요. 초록빛으로 변한 감자는 독 성분(솔라닌)이 있으니 빛을 꼭 가려 보관하세요.',
  },
  apple: {
    plant: '사과 묘목은 봄(3~4월)에 해가 잘 들고 물 빠짐 좋은 곳에 심어요. 심고 2~4년쯤 지나야 첫 열매를 봐요 — 조급해하지 않아도 돼요.',
    water: '어린 나무는 일주일에 1~2번 흠뻑, 자리 잡은 나무는 가물 때만 주면 돼요. 물이 고이면 뿌리가 썩으니 주의하세요.',
    temp: '서늘한 기후를 좋아하고 추위에 강해요. 오히려 겨울 추위를 겪어야 봄에 꽃이 잘 펴요(휴면). 다만 꽃 필 무렵 늦서리는 조심.',
    pest: '탄저병·갈색무늬병, 진딧물·응애, 열매 속을 파는 심식나방이 대표적이에요. 열매에 봉지를 씌우면 병해충을 크게 줄일 수 있어요.',
    harvest: '품종에 따라 9~11월에 수확해요. 열매를 위로 들어 올리듯 살짝 돌리면 꼭지가 상하지 않게 따져요.',
    soil: '깊고 물 빠짐 좋은 흙, pH 5.5~6.5가 좋아요. 겨울 가지치기(전정)가 이듬해 열매 품질을 좌우해요.',
    tip: '열매가 너무 많이 달리면 다 작아져요. 한 자리에 1개만 남기고 솎아주면(적과) 크고 단 사과가 열려요.',
  },
  pear: {
    plant: '배 묘목도 봄에 심는데, 배는 혼자서는 열매를 잘 못 맺어요. 꽃가루를 주고받을 다른 품종 나무를 근처에 함께 심어야 해요(타가수분).',
    water: '물을 좋아하지만 고이는 건 싫어해요. 열매가 굵어지는 7~8월에 가물면 열매가 작아지니 이때는 챙겨서 주세요.',
    temp: '온화한 기후를 좋아해요. 4월 꽃 필 때 늦서리를 맞으면 그해 농사를 망칠 수 있으니 개화기 날씨를 잘 보세요.',
    pest: '검은별무늬병(흑성병)과 배나무이가 대표 병해충이에요. 어린 열매에 봉지를 씌우면 병도 막고 껍질도 고와져요.',
    harvest: '8월 말~10월, 봉지째 만져봐서 묵직하게 익은 것부터 따요.',
    soil: '뿌리가 깊게 뻗도록 깊고 비옥한 흙이 좋아요. pH 5.5~7.0.',
    tip: '배는 강풍에 열매가 잘 떨어져요(낙과). 지주를 세우고 태풍 예보가 있으면 익은 것부터 미리 수확하세요. 열매 솎기도 잊지 마세요.',
  },
};

// 작물을 안 정했을 때의 일반 답변
const GENERAL_KB = {
  plant: '작물마다 심는 시기가 달라요. 어떤 작물이 궁금하세요? 상추·오이·감자는 채소라 그해 수확하고, 사과·배는 나무라 몇 년을 함께해요.',
  water: '물 주기 기본 원칙: 겉흙이 말랐을 때, 아침에, 뿌리 쪽에 흠뻑! 잎에 물을 뿌리면 병이 생기기 쉬워요. 작물별로 물 먹는 양이 꽤 달라요 — 어떤 작물인가요?',
  temp: '작물마다 좋아하는 온도가 달라요. 상추·감자는 서늘한 걸(15~23℃), 오이는 따뜻한 걸(22~28℃) 좋아해요. 어떤 작물이 궁금하세요?',
  pest: '병해충의 기본 대응은 ①통풍 좋게 ②병든 잎 바로 제거 ③같은 자리 연작 피하기예요. 작물 이름을 알려주시면 대표 병해충을 짚어드릴게요.',
  harvest: '수확 시기는 작물마다 달라요. 상추 30~40일, 오이는 꽃 피고 일주일, 감자 90~100일, 사과·배는 가을이에요. 어떤 작물인가요?',
  soil: '좋은 흙의 기본은 물 빠짐이에요. 심기 2주 전 퇴비를 섞어 밑거름을 하고, 자라는 중엔 웃거름을 나눠 줘요. 작물별 적정 pH도 알려드릴 수 있어요.',
  tip: '초보라면 상추부터 시작하는 걸 추천해요 — 빨리 자라고 실패가 적거든요. 특정 작물 팁이 궁금하면 이름을 불러주세요!',
};

const CHAT_FAQ = [
  '오이는 언제 심어요?',
  '상추 물은 얼마나 줘요?',
  '감자는 언제 수확해요?',
  '사과 병해충 알려줘',
  '배 키우기 팁',
];

let chatStarted = false;
let chatLastCrop = null; // 직전 대화의 작물 기억 (예: "물은?" 만 물어도 이어짐)

function detectCrop(t) {
  if (t.includes('상추')) return 'lettuce';
  if (t.includes('오이')) return 'cucumber';
  if (t.includes('감자')) return 'potato';
  if (t.includes('사과')) return 'apple';
  if (/(?<!재)배(?!수|추|달|송)/.test(t)) return 'pear';
  return null;
}

function detectTopic(t) {
  if (/(수확|언제 따|따나|따요|따면|캐)/.test(t)) return 'harvest';
  if (/물/.test(t)) return 'water';
  if (/(병|벌레|해충|진딧물|응애|나방)/.test(t)) return 'pest';
  if (/(온도|기온|추위|더위|폭염|서리|냉해)/.test(t)) return 'temp';
  if (/(흙|토양|거름|비료|ph|산도|퇴비)/i.test(t)) return 'soil';
  if (/(팁|조언|잘 키|주의|초보|비결)/.test(t)) return 'tip';
  if (/(심|파종|모종|씨앗|시작|언제)/.test(t)) return 'plant';
  return null;
}

// 답변 생성 — 규칙 기반 대체 (Gemini 실패 시에만 씀)
function botReply(text) {
  const t = text.trim();
  if (/(안녕|하이|반가)/.test(t)) {
    return { text: `안녕하세요, ${userName}님! 흙톡이에요. 사과·배·오이·감자·상추 키우기라면 뭐든 물어보세요.`, chips: CHAT_FAQ };
  }
  if (/(고마|감사|땡큐)/.test(t)) {
    return { text: '도움이 됐다니 기뻐요! 또 궁금한 게 생기면 언제든 불러주세요.', chips: CHAT_FAQ.slice(0, 3) };
  }

  const crop = detectCrop(t) || chatLastCrop;
  const topic = detectTopic(t);
  if (detectCrop(t)) chatLastCrop = detectCrop(t);

  // 작물 + 주제 → 정답
  if (crop && topic) {
    const name = CROP_NAMES[crop];
    const others = Object.keys(TOPIC_LABELS).filter((k) => k !== topic).slice(0, 3);
    return {
      text: CROP_KB[crop][topic],
      chips: others.map((k) => `${name} ${TOPIC_LABELS[k]}`),
    };
  }
  // 작물만 → 작물 개요 + 주제 선택
  if (crop) {
    const name = CROP_NAMES[crop];
    return {
      text: `${name}에 대해 뭐가 궁금하세요? 아래에서 골라도 되고, 편하게 물어봐도 돼요.`,
      chips: Object.keys(TOPIC_LABELS).slice(0, 5).map((k) => `${name} ${TOPIC_LABELS[k]}`),
    };
  }
  // 주제만 → 일반 답변 + 작물 유도
  if (topic) {
    return {
      text: GENERAL_KB[topic],
      chips: ['상추', '오이', '감자', '사과', '배'].map((n) => `${n} ${TOPIC_LABELS[topic]}`),
    };
  }
  // 못 알아들음
  return {
    text: '아직 배우는 중이라 그건 잘 모르겠어요. 사과·배·오이·감자·상추의 심는 시기, 물 주기, 병해충, 수확 같은 걸 물어봐 주세요!',
    chips: CHAT_FAQ,
  };
}

function chatBubble(who, text) {
  const log = $('#chat-log');
  const el = document.createElement('div');
  el.className = `chat-msg ${who}`;
  if (who === 'bot') {
    el.innerHTML = `<span class="chat-avatar">${TAB_ICONS.chat}</span><div class="chat-bubble"></div>`;
    el.querySelector('.chat-bubble').textContent = text;
  } else {
    el.innerHTML = `<div class="chat-bubble"></div>`;
    el.querySelector('.chat-bubble').textContent = text;
  }
  log.appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function chatChips(chips) {
  $('#chat-chips').innerHTML = (chips || [])
    .map(() => `<button class="suggest-chip"></button>`).join('');
  const btns = document.querySelectorAll('#chat-chips .suggest-chip');
  btns.forEach((btn, i) => {
    btn.textContent = chips[i];
    btn.onclick = () => sendChat(chips[i]);
  });
}

const chatHistory = [];   // LLM에 넘길 대화 기록 {role:'user'|'bot', text}
let llmAvailable = null;  // null=모름, false=키 없음(규칙 기반만 사용)

function showTyping() {
  const log = $('#chat-log');
  const el = document.createElement('div');
  el.className = 'chat-msg bot';
  el.id = 'chat-typing';
  el.innerHTML = `<span class="chat-avatar">${TAB_ICONS.chat}</span>
    <div class="chat-bubble chat-typing"><i></i><i></i><i></i></div>`;
  log.appendChild(el);
  el.scrollIntoView({ block: 'end' });
}
function hideTyping() { $('#chat-typing')?.remove(); }

async function sendChat(text) {
  if (!text.trim()) return;
  chatBubble('user', text);
  chatHistory.push({ role: 'user', text });
  chatChips([]);
  showTyping();

  // ① Gemini(서버 중계) 먼저 시도 — 키가 없거나 실패하면 ② 내장 지식으로
  if (llmAvailable !== false) {
    try {
      const context = {
        name: userName,
        region: myRegion() ? myRegion().name : null,
        crops: (status?.crops || []).map((c) => CROP_NAMES[c.cropId] || c.cropId),
      };
      const r = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: chatHistory.slice(-12), context }),
      });
      if (r.ok && r.text) {
        llmAvailable = true;
        hideTyping();
        chatBubble('bot', r.text);
        chatHistory.push({ role: 'bot', text: r.text });
        chatChips(CHAT_FAQ.slice(0, 3));
        return;
      }
      if (r.reason === 'no-key') llmAvailable = false; // 이후엔 바로 내장 지식 사용
    } catch { /* 서버 오류 → 내장 지식으로 */ }
  }

  // ② 내장 지식 (규칙 기반) 대체
  hideTyping();
  const reply = botReply(text);
  chatBubble('bot', reply.text);
  chatHistory.push({ role: 'bot', text: reply.text });
  chatChips(reply.chips);
}

function renderChat() {
  if (chatStarted) return;
  chatStarted = true;
  chatBubble('bot', `안녕하세요, ${userName}님! 밭일 도우미 흙톡이에요. 사과·배·오이·감자·상추 키우는 법이 궁금하면 뭐든 물어보세요.`);
  chatChips(CHAT_FAQ);
}

/* ════════════════════════════════════════════
   8. 설정
════════════════════════════════════════════ */

function renderSettings() {
  $('#settings-profile').innerHTML = `
    <div class="sc-row">
      <div>
        <div class="sc-label">로그인 계정</div>
        <div class="sc-value" style="font-size:13.5px">${sbEmail || '알 수 없음'}</div>
      </div>
      <button class="link-btn" id="logout-btn">로그아웃</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">밭 주인</div>
        <div class="sc-value">${userName}</div>
      </div>
      <button class="link-btn" id="rename-btn">이름 바꾸기</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">농장 지역</div>
        <div class="sc-value farm-region-value">${farmRegion}</div>
      </div>
      <button class="link-btn" id="region-btn">지역 바꾸기</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">교환소</div>
        <div class="sc-value" style="font-size:13.5px;color:var(--ink-soft)">모은 포인트로 비료 신청하기</div>
      </div>
      <button class="link-btn" id="open-rewards-settings">열기</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">밭 꾸미기</div>
        <div class="sc-value" style="font-size:13.5px;color:var(--ink-soft)">작물 테두리 상점 · 지금 ${currentFrameName()}</div>
      </div>
      <button class="link-btn" id="open-frames-settings">열기</button>
    </div>`;
  $('#region-btn').onclick = () => startWizard({ settingsOnly: true });
  $('#open-rewards-settings').onclick = async () => {
    await renderRewards();
    show('rewards');
  };
  $('#open-frames-settings').onclick = openFrameShop;
  $('#rename-btn').onclick = () => {
    const next = prompt('새 이름을 입력해 주세요.\n(이름이 바뀌면 새 밭에서 다시 시작해요)', userName);
    if (!next || !next.trim() || next.trim() === userName) return;
    userName = next.trim();
    localStorage.setItem('farm.name', userName);
    location.reload();
  };
  $('#logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setSession(null, null);
    toast('로그아웃했어요.');
    loginMode = 'login';
    renderLogin();
    show('login', { tabbar: false });
  };
}

/* ════════════════════════════════════════════
   9. 시작 흐름
════════════════════════════════════════════ */

async function refreshStatus() {
  status = await api('/api/me/status');
}

async function boot() {
  document.getElementById('app').classList.add(`time-${currentDayPeriod()}`);

  // 탭 구성
  document.querySelectorAll('.tab').forEach((t) => {
    const v = t.dataset.view;
    t.innerHTML = `${TAB_ICONS[v]}<span>${TAB_LABELS[v]}</span><span class="tab-underline"></span>`;
    t.addEventListener('click', async () => {
      if (v === 'home') { await refreshStatus(); renderHome(); }
      if (v === 'todos') renderTodos();
      if (v === 'chat') renderChat();
      if (v === 'records') { await refreshStatus(); await renderRecords(); }
      if (v === 'settings') renderSettings();
      show(v);
    });
  });

  // 할 일 추가 폼
  $('#todo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#todo-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await addTodo(text);
  });

  // 흙톡 채팅 입력
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChat(text);
  });

  // 다이어리 사진 입력(카메라/보관함)은 한 번만 연결
  bindPhotoInputs();

  // 해·달의 위치와 시간대 분위기를 주기적으로 갱신 — 홈이 보일 때만 10분마다 다시 그림
  setInterval(() => {
    if (status && !$('#view-home').hidden) renderHome();
  }, 10 * 60 * 1000);

  // 교환소 → 대시보드 돌아가기
  $('#rewards-back').addEventListener('click', async () => {
    await refreshStatus();
    renderHome();
    show('home');
  });

  if (!sbToken) {
    loginMode = 'login';
    renderLogin();
    show('login', { tabbar: false });
    return;
  }
  await enterApp();
}

async function enter() {
  try {
    const ob = await api('/api/me/onboarding');
    selectableCrops = ob.characters || [];
    if (ob.isFirstTime) {
      startWizard({ skipName: true }); // 이름은 있으니 상태 질문부터
      return;
    }
    await refreshStatus();
    renderHome();
    show('home');
    maybeOfferCheckin();
  } catch {
    toast('서버에 연결할 수 없어요. 터미널에서 npm start를 실행해 주세요.', 4000);
  }
}

// 앱 화면(index.html)에서만 부팅 — 미리보기 페이지 등이 이 모듈을
// import 해서 그림 함수만 쓸 수 있게 함
if (document.querySelector('#view-home')) boot();

// 다른 페이지(미리보기 등)에서 쓰는 그림 함수들
export { plantScene, cropPortrait, conditionScene };
