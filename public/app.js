// app.js — 청년농부 프론트엔드
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
    lines.push(`필지 토양검정 결과를 연결하면 '내 밭 pH 측정값 ↔ ${crop.cropName} 적정 pH${range ? ` ${range}` : ''}'로 바로 비교해 드려요.`);
  }
  return { title: `${soil.label}으로 판단한 이유`, lines };
}
