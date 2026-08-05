// app.js — 청년농부 프론트엔드
// 그림은 전부 아래 "일러스트 라이브러리"에서 코드로 그립니다.
// (외부 이미지 없음 → 어떤 화면에서도 스타일이 어긋나지 않음)

import { CONDITIONS, conditionIcon, conditionBadge } from './conditions.js';
import { buildAnalysisViewModel } from './analysis-model.js';
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

function sunArt(x, y, r = 13) {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * 45 * Math.PI) / 180;
    rays += `<line x1="${x + Math.cos(a) * (r + 4)}" y1="${y + Math.sin(a) * (r + 4)}"
      x2="${x + Math.cos(a) * (r + 9)}" y2="${y + Math.sin(a) * (r + 9)}"/>`;
  }
  return `<g class="scene-sun">
    <circle cx="${x}" cy="${y}" r="${r}" fill="#f2dfa0" stroke="#d8b856" stroke-width="1.6"/>
    <g stroke="#d8b856" stroke-width="1.6" stroke-linecap="round">${rays}</g>
  </g>`;
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
  const ambient =
    mood === 'wait' ? cloudArt(78, 78, 1)
    : mood === 'done' ? `${sunArt(186, 70, 12)}${sparkle(70, 110, 0.8, '#c9b98a')}`
    : '';
  const sway = stageKey === 'seed' ? '' : 'class="sway"';
  const s = STAGE_SCALE[stageKey] || 1.2;
  return `<svg viewBox="0 0 260 288" role="img" aria-label="키우는 작물">
    <defs><clipPath id="${id}"><ellipse cx="130" cy="144" rx="112" ry="130"/></clipPath></defs>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="#fbf8ef"/>
    <g clip-path="url(#${id})">
      <path d="M10,216 Q130,197 250,216" fill="none" stroke="#e3dbc4" stroke-width="1.6"/>
      ${ambient}
      ${ground()}
      <g ${sway}><g transform="translate(130 227) scale(${s}) translate(-130 -227)">
        ${plantArt(cropId, stageKey)}
      </g></g>
    </g>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="none" stroke="${INK}" stroke-width="1.6" opacity=".7"/>
    <ellipse cx="130" cy="144" rx="103" ry="121" fill="none" stroke="#c9825b" stroke-width="1.3"
      stroke-dasharray="0.5 8" stroke-linecap="round" opacity=".55"/>
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

// 상태 코드 → 장면 연출
// sev: 등급(good=웃음 / warn=시무룩 / danger=빈사+덜덜)
// sky: 하늘색 / air: 공중 효과 / soilFx: 흙 위 효과 / overlay: 식물 위 덮개
const CONDITION_FX = {
  // ── 날씨 ──
  stable: {
    sev: 'good',
    air: `${fx('fx-pulse', sunArt(80, 84, 9))}${fx('fx-drift', cloudArt(176, 72, 0.9, { rain: false }))}`,
  },
  clear: {
    sev: 'good',
    sky: '#fdfaf0',
    air: `${fx('fx-pulse', sunArt(178, 70, 13))}
      ${fx('fx-twinkle', sparkle(76, 112, 0.9))}${fx('fx-twinkle', sparkle(58, 152, 0.7, '#c9b98a'), 0.9)}`,
  },
  heat: {
    sev: 'warn',
    sky: '#fdf5e5',
    air: `${fx('fx-pulse', sunArt(178, 72, 15))}
      ${fx('fx-pulse', thermometerArt(62, 88, 0.9), 0.35, 2.8)}
      ${fx('fx-shimmer', heatWavesArt(78, 132))}`,
  },
  heatwave: {
    sev: 'danger',
    sky: '#faeddc',
    air: `${fx('fx-pulse', sunArt(178, 70, 17), 0, 2.2)}
      ${fx('fx-pulse', thermometerArt(58, 88, 1, true), 0.25, 1.9)}
      ${fx('fx-shimmer', heatWavesArt(82, 122))}${fx('fx-shimmer', heatWavesArt(96, 158, 0.9), 0.7)}`,
  },
  cold: {
    sev: 'warn',
    sky: '#f2f6f6',
    air: `${fx('fx-drift', cloudArt(90, 76, 0.9, { rain: false }))}${sunArt(184, 66, 9)}
      ${fx('fx-snow', snowflakeSceneArt(70, 132, 6))}${fx('fx-snow', snowflakeSceneArt(180, 122, 5), 1.8)}`,
  },
  frost: {
    sev: 'danger',
    sky: '#eef4f6',
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
    air: `${fx('fx-drift', cloudArt(96, 74, 1.05))}${fx('fx-drift', cloudArt(178, 60, 0.75, { rain: false }), 2)}
      ${fx('fx-fall', dew(72, 138, 1))}${fx('fx-fall', dew(120, 118, 0.9), 0.6)}
      ${fx('fx-fall', dew(160, 142, 1), 1.1)}${fx('fx-fall', dew(196, 168, 0.85), 0.3)}`,
    soilFx: `${fx('fx-twinkle', rippleArt(84, 252), 0, 2.6)}${fx('fx-twinkle', rippleArt(182, 258), 1.2, 2.6)}`,
  },
  downpour: {
    sev: 'danger',
    sky: '#e9ece8',
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
    air: `${fx('fx-pulse', sunArt(178, 72, 16))}${fx('fx-shimmer', heatWavesArt(62, 116, 0.9))}`,
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
  const sky = fxDefs.find((definition) => definition.sky)?.sky || '#fbf8ef';
  const air = fxDefs.map((definition) => definition.air || '').join('');
  const soilFx = fxDefs.map((definition) => definition.soilFx || '').join('');
  const overlay = fxDefs.map((definition) => definition.overlay || '').join('');
  const faceMood = sev === 'danger' ? 'danger' : sev === 'warn' ? 'sad' : 'happy';
  // 등급별 움직임: 양호=통통 튀는 리듬 / 주의=축 처진 흔들림 / 위험=덜덜 떨림
  const swayClass = sev === 'danger' ? 'sway-danger' : sev === 'warn' ? 'sway-sad' : 'sway-happy';
  const id = `vg${++uid}`;
  const s = STAGE_SCALE[stageKey] || 1.2;
  const sceneLabel = codeList.map((code) => CONDITIONS[code]?.label || code).join(' · ');
  return `<svg viewBox="0 0 260 288" role="img" aria-label="${CROP_NAMES[cropId] || cropId} · ${sceneLabel}">
    <defs><clipPath id="${id}"><ellipse cx="130" cy="144" rx="112" ry="130"/></clipPath></defs>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="${sky}"/>
    <g clip-path="url(#${id})">
      <g class="scene-night-sky" aria-hidden="true">
        <circle cx="47" cy="50" r="1.4"/><circle cx="83" cy="82" r="1"/>
        <circle cx="125" cy="44" r="1.2"/><circle cx="205" cy="78" r="1.3"/>
        <path d="M199 42a15 15 0 1 1-12-23a17 17 0 0 0 12 23Z"/>
      </g>
      <g class="scene-dawn-glow" aria-hidden="true"><ellipse cx="130" cy="205" rx="120" ry="54"/></g>
      <path d="M10,216 Q130,197 250,216" fill="none" stroke="#e3dbc4" stroke-width="1.6"/>
      ${air}
      ${ground()}
      ${soilFx}
      <g class="${swayClass}"><g transform="translate(130 227) scale(${s}) translate(-130 -227)">
        ${plantArt(cropId, stageKey, faceMood)}
      </g></g>
      ${overlay}
    </g>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="none" stroke="${INK}" stroke-width="1.6" opacity=".7"/>
    <ellipse cx="130" cy="144" rx="103" ry="121" fill="none" stroke="#c9825b" stroke-width="1.3"
      stroke-dasharray="0.5 8" stroke-linecap="round" opacity=".55"/>
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
  chat: `<svg width="23" height="23" viewBox="0 0 23 23" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 5.5A3 3 0 0 1 7 2.5h9A3 3 0 0 1 19 5.5v7a3 3 0 0 1-3 3h-5l-4.5 4v-4A2.5 2.5 0 0 1 4 13z"/>
    <path d="M8 8.8h.1M11.5 8.8h.1M15 8.8h.1" stroke-width="2.2"/>
  </svg>`,
  records: `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 5 Q4 3.5 5.5 3.5 H16.5 Q18 3.5 18 5 V17 Q18 18.5 16.5 18.5 H5.5 Q4 18.5 4 17 Z"/>
    <path d="M7.5 3.5 V18.5"/>
    <path d="M10.5 8 H15 M10.5 11 H15 M10.5 14 H13.5"/>
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
const existingUserId = localStorage.getItem('farm.userId');
const userId = existingUserId || userName || crypto.randomUUID();
localStorage.setItem('farm.userId', userId);
const DEFAULT_FARM_REGION = '인천광역시 남동구';
let farmRegion = localStorage.getItem('farm.region') || DEFAULT_FARM_REGION;
const environmentCache = new Map();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // HTTP 헤더에는 한글을 담을 수 없어 인코딩해서 보냄 (서버에서 디코딩)
      'x-user-id': encodeURIComponent(userId),
      ...(options.headers || {}),
    },
  });
  return res.json();
}

/* ════════════════════════════════════════════
   3. 화면 전환 & 공용 UI
════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const views = ['setup', 'hello', 'select', 'home', 'todos', 'chat', 'rewards', 'records', 'settings'];
const TAB_LABELS = { home: '대시보드', todos: 'TO-DO', chat: '상담', records: '기록', settings: '설정' };

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
let profile = null;       // GET /api/me/profile 캐시
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
function stepLabel(cropId, key) {
  return (CROP_STEP_LABELS[cropId] && CROP_STEP_LABELS[cropId][key]) || STEP_LABELS[key] || key;
}

// 지금 대시보드에 보여줄 작물 (없어졌으면 첫 작물로)
function getActiveCrop() {
  const crops = status.crops || [];
  if (!crops.length) return null;
  return crops.find((c) => c.cropId === activeCropId) || crops[0];
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
  applyTimeTheme();
  applySelectedBorder();
  $('#home-greet').textContent = `${userName}의 작은 밭`;
  $('#home-date').textContent = fmtDate();
  const selectedTitle = status?.titles?.unlocked?.find(
    (title) => title.key === status?.titles?.selectedKey,
  ) || status?.titles?.current;
  $('#home-title-badge').textContent = selectedTitle?.name
    ? `칭호 · ${selectedTitle.name}`
    : '';
  updateTodoAlert();

  const crop = getActiveCrop();
  activeCropId = crop ? crop.cropId : null;
  renderCropIcons(crop);

  const mood = crop && crop.matured ? 'harvest' : status.checkedInToday ? 'done' : 'wait';

  // 장면
  if (crop) {
    $('#vignette').innerHTML = plantScene(crop.cropId, crop.stageKey, mood === 'harvest' ? 'done' : mood);
  }

  // 출석 여부는 환경 상태가 아닙니다. 실제 분석이 도착하기 전에는
  // 양호로 추정하지 않고 중립 상태를 유지합니다.
  const sub = $('#status-sub');
  if (mood === 'harvest') {
    renderStatusTitle('분석 중', '환경 확인 중', 'HOLD');
    sub.textContent = `${crop.cropName}가 다 자랐어요! 수확해 주세요.`;
  } else if (mood === 'done') {
    renderStatusTitle('분석 중', '환경 확인 중', 'HOLD');
    sub.textContent = `${farmRegion} 환경 자료를 불러오고 있어요.`;
  } else {
    renderStatusTitle('분석 중', '환경 확인 중', 'HOLD');
    sub.textContent = `${farmRegion} 환경 자료를 불러오고 있어요.`;
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
  }

  // 버튼: 다 자란 작물은 수확, 출석 전에는 출석, 그 외에는 상세 보기
  const btn = $('#checkin-btn');
  btn.className = 'btn btn-wide btn-primary';
  btn.disabled = false;
  if (mood === 'harvest') {
    btn.textContent = `${crop.cropName} 수확하기`;
    btn.onclick = () => doHarvest(crop.cropId);
  } else if (status.checkedInToday) {
    btn.textContent = '상세 보기';
    btn.onclick = () => openDetailSheet(crop);
  } else {
    btn.textContent = '오늘도 출석하기';
    btn.onclick = doCheckIn;
  }

  if (crop) refreshHomeEnvironment(crop);
}

function applyTimeTheme() {
  const app = $('#app');
  app.classList.remove('time-dawn', 'time-day', 'time-dusk', 'time-night');
  app.classList.add(`time-${currentDayPeriod()}`);
}

function applySelectedBorder() {
  const app = $('#app');
  [...app.classList].filter((name) => name.startsWith('border-')).forEach((name) => app.classList.remove(name));
  const key = status?.titles?.selectedBorderKey;
  if (key && key !== 'seed') app.classList.add(`border-${key}`);
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
    if (getActiveCrop()?.cropId !== crop.cropId) return;
    applyCropBadgeState(crop.cropId, null);
    renderStatusTitle('연결 확인', '환경 자료 대기', 'HOLD');
    $('#status-sub').textContent = '환경 자료를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.';
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
    `/api/me/environment?crop=${encodeURIComponent(crop.cropId)}&region=${encodeURIComponent(farmRegion)}&cultivationMode=OPEN_FIELD`,
  );
  if (!response?.ok || !response.analysis) {
    throw new Error(response?.message || '농장 환경 분석을 불러오지 못했습니다.');
  }
  const detail = buildAnalysisViewModel(response.analysis);
  environmentCache.set(cacheKey, detail);
  if (response.preventive?.added?.length) notifyPreventive(response.preventive);
  return detail;
}

function updateTodoAlert(count = status?.unreadNotifications || 0) {
  const tab = document.querySelector('.tab[data-view="todos"]');
  if (!tab) return;
  let badge = tab.querySelector('.tab-alert');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'tab-alert';
    tab.append(badge);
  }
  badge.hidden = !count;
  badge.textContent = count > 9 ? '9+' : String(count);
}

function notifyPreventive(preventive) {
  const addedCount = preventive?.added?.length || 0;
  if (!addedCount) return;
  if (status) status.unreadNotifications = (status.unreadNotifications || 0) + 1;
  updateTodoAlert();
  const notification = preventive.notifications?.[0];
  toast(`${addedCount}개의 예방 할 일을 준비했어요.`, 3600);
  if (
    profile?.notificationsEnabled &&
    'Notification' in window &&
    Notification.permission === 'granted' &&
    notification
  ) {
    new Notification(notification.title, { body: notification.message, tag: notification.analysisId });
  }
}

async function doCheckIn() {
  const btn = $('#checkin-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/me/checkin', { method: 'POST' });
    if (!res.ok) {
      toast(res.message || '출석에 실패했어요.');
      btn.disabled = false;
      return;
    }
    status = res.status;
    renderHome();
    popVignette();
    toast(res.message);
  } catch {
    toast('서버에 연결할 수 없어요. (npm start 확인)');
    btn.disabled = false;
  }
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

// 예보 아이콘에 입힐 기존 fx 애니메이션
const ICON_ANIM = {
  clear: 'fx-pulse', stable: 'fx-pulse', drought: 'fx-pulse',
  heat: 'fx-shimmer', heatwave: 'fx-shimmer',
  rain: 'fx-bob', downpour: 'fx-bob', overwet: 'fx-bob',
  cold: 'fx-twinkle', frost: 'fx-twinkle',
  wind: 'fx-drift', typhoon: 'fx-drift',
};

// 일주일 예보에서 주의·위험 날씨를 모아 추천 할 일 목록 생성
function weekTodoSuggestions(week) {
  const byCode = new Map();
  for (const day of week) {
    const sev = CONDITIONS[day.code]?.severity;
    if (sev !== 'warn' && sev !== 'danger') continue;
    if (!byCode.has(day.code)) byCode.set(day.code, { code: day.code, sev, days: [] });
    byCode.get(day.code).days.push(day.label);
  }
  return [...byCode.values()].map((t) => ({
    ...t,
    label: CONDITIONS[t.code].label,
    text: `(${t.days.join('·')}) ${CONDITIONS[t.code].label} 대비 — ${CONDITION_TODOS[t.code] || '밭 상태 살펴보기'}`,
  }));
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
        <button class="soil-test-open" id="soil-test-guide-open" type="button">
          무료 토양검정 안내 <span aria-hidden="true">›</span>
        </button>
      </div>` : ''}

    <h3 class="section-label">일주일 기상정보</h3>
    ${week.length ? `<div class="week-forecast">
      ${week.map((day, index) => weatherDayMarkup(day, index)).join('')}
    </div>
    <div class="score-explanation weather-day-explanation" id="weather-day-explanation" hidden>
      <strong></strong>
      <div class="score-explanation-lines"></div>
    </div>` : '<p class="empty-note forecast-empty">표시할 단·중기 예보가 없어요.</p>'}

    <h3 class="section-label">예보 기반 추천 할 일</h3>
    <div class="sheet-todos" id="sheet-todos"></div>`;

  const suggestions = weekTodoSuggestions(week);
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
  $('#sheet-todos').innerHTML = suggestions.length
    ? suggestions.map((suggestion, index) => `
      <div class="sheet-todo">
        <span class="wf-flag ${suggestion.sev === 'danger' ? 'danger' : 'warn'}">${suggestion.sev === 'danger' ? '위험' : '주의'}</span>
        <span class="st-text"></span>
        <button class="st-add" data-idx="${index}">담기</button>
      </div>`).join('')
    : '<p class="empty-note">이번 주는 작물 기준을 벗어난 예보가 없어요.</p>';
  document.querySelectorAll('.sheet-todo .st-text').forEach((element, index) => {
    element.textContent = suggestions[index].text;
  });
  document.querySelectorAll('.st-add').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const response = await api('/api/me/todos', {
        method: 'POST',
        body: JSON.stringify({ text: suggestions[Number(button.dataset.idx)].text }),
      });
      if (response.ok) {
        button.textContent = '담김 ✓';
        toast('TO-DO에 담았어요.');
      } else {
        button.disabled = false;
        toast(response.message || '담지 못했어요.');
      }
    };
  });
  const soilTestButton = $('#soil-test-guide-open');
  if (soilTestButton) {
    soilTestButton.onclick = () => renderSoilTestGuide(panel, crop, detail);
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
let setupState = null;
let locationSearchTimer = null;

const SETUP_STEP_PROGRESS = Object.freeze({
  mode: 12,
  location: 28,
  crop: 46,
  analyzing: 62,
  result: 70,
  stage: 84,
  name: 94,
  complete: 100,
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function beginSetup(kind = 'initial') {
  const growing = new Set((status?.crops || []).map((crop) => crop.cropId));
  setupState = {
    kind,
    step: 'mode',
    history: [],
    usageMode: null,
    region: profile?.region || farmRegion || '',
    addressLabel: '',
    candidateToken: '',
    locationCandidates: [],
    cropId: null,
    stageKey: null,
    startedKey: todayKey(),
    cultivationMode: 'OPEN_FIELD',
    analysis: null,
    suitability: null,
    availableCrops: selectableCrops.filter((crop) => !growing.has(crop.id)),
  };
  if (!setupState.availableCrops.length) {
    toast('이미 지원 작물 다섯 가지를 모두 키우고 있어요.');
    return;
  }
  renderSetupStep('mode', { remember: false });
  show('setup', { tabbar: false });
}

function renderSetupStep(step, { remember = true } = {}) {
  if (!setupState) return;
  if (remember && setupState.step && setupState.step !== step) {
    setupState.history.push(setupState.step);
  }
  setupState.step = step;
  $('#setup-progress-bar').style.width = `${SETUP_STEP_PROGRESS[step] || 10}%`;
  $('#setup-back').hidden = setupState.history.length === 0 || step === 'analyzing';
  $('#setup-close').hidden = setupState.kind !== 'add';
  const body = $('#setup-body');
  body.innerHTML = '';
  if (step === 'mode') renderSetupMode(body);
  if (step === 'location') renderSetupLocation(body);
  if (step === 'crop') renderSetupCrop(body);
  if (step === 'analyzing') renderSetupAnalyzing(body);
  if (step === 'result') renderSetupResult(body);
  if (step === 'stage') renderSetupStage(body);
  if (step === 'name') renderSetupName(body);
}

function previousSetupStep() {
  if (!setupState?.history?.length) return;
  const previous = setupState.history.pop();
  renderSetupStep(previous, { remember: false });
}

function setupHeading(kicker, title, copy = '') {
  return `<p class="setup-kicker">${escapeHtml(kicker)}</p>
    <h1 class="setup-title">${escapeHtml(title)}</h1>
    ${copy ? `<p class="setup-copy">${escapeHtml(copy)}</p>` : ''}`;
}

function renderSetupMode(body) {
  body.innerHTML = `${setupHeading(
    setupState.kind === 'add' ? '작물 추가' : '첫 질문',
    '지금 어떤 상태인가요?',
    '현재 상황에 맞춰 필요한 질문만 이어갈게요.',
  )}
    <div class="setup-options">
      <button class="setup-option" type="button" data-usage="ACTIVE_GROWING">
        <strong>이미 재배하고 있어요</strong>
        <span>현재 단계와 농장 환경을 함께 살펴봐요.</span>
      </button>
      <button class="setup-option" type="button" data-usage="LAND_SEARCH">
        <strong>재배를 시작하려고 해요</strong>
        <span>이 지역이 작물과 잘 맞는지 먼저 확인해요.</span>
      </button>
    </div>`;
  body.querySelectorAll('[data-usage]').forEach((button) => {
    button.onclick = () => {
      setupState.usageMode = button.dataset.usage;
      renderSetupStep('location');
    };
  });
}

function renderSetupLocation(body) {
  body.innerHTML = `${setupHeading(
    '재배지 확인',
    '어느 밭을 살펴볼까요?',
    '정확한 위치일수록 가까운 관측소와 토양 자료를 더 잘 찾을 수 있어요.',
  )}
    <div class="setup-location-methods">
      <button class="setup-option setup-location" id="setup-current-location" type="button">
        <strong>현재 위치 사용</strong><span>GPS로 주소 후보 찾기</span>
      </button>
      <button class="setup-option setup-location" id="setup-manual-location" type="button">
        <strong>주소 직접 입력</strong><span>도로명·읍면동 검색</span>
      </button>
    </div>
    <p class="setup-privacy">현재 위치와 상세 주소는 주소 후보 확인을 위해 흙날씨 위치 확인 서버에 일시 전송되며 저장하지 않습니다. 앱에는 시·군·구만 남겨요.</p>
    <div class="setup-form" id="setup-address-form" hidden>
      <label class="sr-only" for="setup-address">농장 주소</label>
      <input class="setup-input" id="setup-address" autocomplete="street-address" placeholder="예: 인천광역시 남동구 구월동" />
      <button class="btn btn-primary" id="setup-address-search" type="button">주소 후보 찾기</button>
      <div class="setup-location-results" id="setup-location-results" aria-live="polite"></div>
    </div>
    <div class="setup-actions">
      <button class="setup-secondary" id="setup-region-only" type="button">정확한 주소를 모르면 시·군·구로 계속하기</button>
    </div>`;

  const form = $('#setup-address-form');
  const input = $('#setup-address');
  $('#setup-manual-location').onclick = () => {
    form.hidden = false;
    input.focus();
  };
  $('#setup-current-location').onclick = useCurrentSetupLocation;
  $('#setup-address-search').onclick = () => searchSetupLocation(input.value);
  input.oninput = () => {
    clearTimeout(locationSearchTimer);
    if (input.value.trim().length < 2) return;
    locationSearchTimer = setTimeout(() => searchSetupLocation(input.value), 450);
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchSetupLocation(input.value);
    }
  };
  $('#setup-region-only').onclick = () => {
    form.hidden = false;
    const region = input.value.trim() || setupState.region;
    if (!region) return toast('시·군·구를 입력해 주세요.');
    chooseSetupLocation({ displayName: region, candidateToken: '' });
  };
}

async function useCurrentSetupLocation() {
  const button = $('#setup-current-location');
  if (!navigator.geolocation) return toast('이 기기에서는 현재 위치를 사용할 수 없어요.');
  button.disabled = true;
  button.querySelector('span').textContent = '위치를 확인하고 있어요';
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    try {
      const result = await api('/api/me/locations/current', {
        method: 'POST',
        body: JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude }),
      });
      if (!result.ok || !result.candidates?.length) throw new Error(result.message || '주소 후보가 없어요.');
      setupState.locationCandidates = result.candidates;
      chooseSetupLocation(result.candidates[0]);
    } catch (error) {
      toast(error.message || '현재 위치를 주소로 바꾸지 못했어요.');
      button.disabled = false;
      button.querySelector('span').textContent = 'GPS로 주소 후보 찾기';
    }
  }, () => {
    toast('위치 권한을 허용하지 않았어요. 주소를 직접 입력해 주세요.');
    button.disabled = false;
    button.querySelector('span').textContent = 'GPS로 주소 후보 찾기';
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

async function searchSetupLocation(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (query.length < 2) return toast('주소를 두 글자 이상 입력해 주세요.');
  const root = $('#setup-location-results');
  if (!root) return;
  root.innerHTML = '<p class="setup-copy">주소 후보를 찾고 있어요.</p>';
  try {
    const result = await api(`/api/me/locations?q=${encodeURIComponent(query)}`);
    if (!result.ok) throw new Error(result.message || '주소 후보를 찾지 못했어요.');
    setupState.locationCandidates = result.candidates || [];
    renderLocationCandidates(root, setupState.locationCandidates);
  } catch (error) {
    root.innerHTML = `<p class="setup-error">${escapeHtml(error.message || '주소 후보를 찾지 못했어요.')}</p>`;
  }
}

function renderLocationCandidates(root, candidates) {
  root.innerHTML = '';
  if (!candidates.length) {
    root.innerHTML = '<p class="setup-error">주소 후보가 없어요. 시·군·구까지 다시 입력해 주세요.</p>';
    return;
  }
  candidates.forEach((candidate) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'setup-location-candidate';
    button.textContent = candidate.displayName;
    button.onclick = () => chooseSetupLocation(candidate);
    root.append(button);
  });
}

function generalizedRegion(displayName) {
  const parts = String(displayName || '').trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].includes('세종')) return parts[0];
  if (/도$/u.test(parts[0]) && /시$/u.test(parts[1] || '') && /구$/u.test(parts[2] || '')) {
    return parts.slice(0, 3).join(' ');
  }
  return parts.slice(0, Math.min(2, parts.length)).join(' ');
}

function chooseSetupLocation(candidate) {
  setupState.addressLabel = String(candidate.displayName || '').trim();
  setupState.region = generalizedRegion(setupState.addressLabel);
  setupState.candidateToken = String(candidate.candidateToken || '');
  renderSetupStep('crop');
}

function renderSetupCrop(body) {
  body.innerHTML = `${setupHeading(
    '작물 선택',
    '어떤 작물을 살펴볼까요?',
    `${setupState.region}의 날씨와 토양을 작물 기준에 맞춰 비교해요.`,
  )}
    <div class="setup-crops">${setupState.availableCrops.map((crop) => `
      <button class="setup-option setup-crop" type="button" data-setup-crop="${crop.id}">
        ${cropPortrait(crop.id)}<strong>${escapeHtml(crop.name)}</strong>
      </button>`).join('')}</div>`;
  body.querySelectorAll('[data-setup-crop]').forEach((button) => {
    button.onclick = () => {
      setupState.cropId = button.dataset.setupCrop;
      analyzeSetupSelection();
    };
  });
}

async function analyzeSetupSelection() {
  renderSetupStep('analyzing');
  const payload = {
    crop: setupState.cropId,
    region: setupState.region,
    candidateToken: setupState.candidateToken,
    cultivationMode: setupState.cultivationMode,
    usageMode: setupState.usageMode,
  };
  try {
    const result = await api('/api/me/environment', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!result.ok) throw new Error(result.message || '환경 분석을 완료하지 못했어요.');
    setupState.analysis = result.analysis;
    setupState.suitability = result.suitability;
    setupState.preventive = result.preventive;
    renderSetupStep('result');
  } catch (error) {
    setupState.analysis = null;
    setupState.suitability = { isSuitable: false, score: null, label: '분석을 마치지 못했어요', reason: error.message };
    renderSetupStep('result');
  }
}

function renderSetupAnalyzing(body) {
  const cropName = CROP_NAMES[setupState.cropId] || '작물';
  body.innerHTML = `<div class="setup-loading" role="status">
    <div class="setup-loading-art">${cropPortrait(setupState.cropId || 'lettuce')}</div>
    <p class="setup-kicker">환경 분석 중</p>
    <h1 class="setup-title">${escapeHtml(setupState.region)}와 ${escapeHtml(cropName)}를<br/>함께 살펴보고 있어요</h1>
    <p class="setup-copy">기상청 예보와 토양 자료를 작물 기준에 맞춰 비교합니다.</p>
  </div>`;
}

function setupAlternativeCandidates() {
  return (setupState.locationCandidates || [])
    .filter((candidate) => candidate.candidateToken !== setupState.candidateToken)
    .slice(0, 3);
}

function renderSetupResult(body) {
  const result = setupState.suitability || {};
  const cropName = CROP_NAMES[setupState.cropId] || '작물';
  const score = Number.isFinite(result.score) ? `${Math.round(result.score)}점` : '확인 중';
  const isPlanningConcern = setupState.usageMode === 'LAND_SEARCH' && !result.isSuitable;
  const alternatives = setupAlternativeCandidates();
  body.innerHTML = `${setupHeading(
    '재배지 분석',
    isPlanningConcern ? '먼저 살펴볼 조건이 있어요' : `${cropName}와 잘 맞는지 확인했어요`,
    setupState.addressLabel || setupState.region,
  )}
    <div class="setup-result ${isPlanningConcern ? 'caution' : 'good'}">
      <span class="setup-result-score">${escapeHtml(score)}</span>
      <strong>${escapeHtml(result.label || '환경 분석 결과')}</strong>
      <p>${escapeHtml(result.reason || '작물 기준과 비교한 결과예요.')}</p>
    </div>
    ${isPlanningConcern ? `<div class="setup-alternatives">
      <p class="setup-copy">인근 주소 후보를 다시 비교할 수 있어요.</p>
      ${alternatives.map((candidate, index) => `<button type="button" class="setup-location-candidate" data-alternative="${index}">${escapeHtml(candidate.displayName)}</button>`).join('')}
    </div>` : ''}
    <div class="setup-actions">
      <button class="btn btn-primary" id="setup-result-next" type="button">${isPlanningConcern ? '이 지역에서 준비 계속하기' : '현재 작물 상태 알려주기'}</button>
      ${isPlanningConcern ? '<button class="setup-secondary" id="setup-find-other" type="button">다른 지역 다시 찾기</button>' : ''}
      ${!setupState.analysis ? '<button class="setup-secondary" id="setup-retry-analysis" type="button">분석 다시 시도</button>' : ''}
    </div>`;
  body.querySelectorAll('[data-alternative]').forEach((button) => {
    button.onclick = () => {
      const candidate = alternatives[Number(button.dataset.alternative)];
      setupState.addressLabel = candidate.displayName;
      setupState.region = generalizedRegion(candidate.displayName);
      setupState.candidateToken = candidate.candidateToken;
      analyzeSetupSelection();
    };
  });
  $('#setup-result-next').onclick = () => renderSetupStep('stage');
  const other = $('#setup-find-other');
  if (other) other.onclick = () => renderSetupStep('location');
  const retry = $('#setup-retry-analysis');
  if (retry) retry.onclick = analyzeSetupSelection;
}

function renderSetupStage(body) {
  const crop = setupState.availableCrops.find((item) => item.id === setupState.cropId);
  const stages = crop?.stages || [];
  const question = setupState.usageMode === 'ACTIVE_GROWING'
    ? '지금 어느 단계인가요?'
    : '어느 단계부터 시작할까요?';
  body.innerHTML = `${setupHeading('작물 상태', question, '잘 모르겠다면 가장 비슷한 모습을 골라도 괜찮아요.')}
    <div class="setup-stages">${stages.map((stage) => `
      <button class="setup-option setup-stage" type="button" data-stage="${stage.key}">
        <span class="setup-stage-art">${cropPortrait(setupState.cropId, stage.key)}</span>
        <strong>${escapeHtml(stepLabel(setupState.cropId, stage.key))}</strong>
      </button>`).join('')}</div>
    <div class="setup-form setup-stage-meta">
      <label for="setup-cultivation">재배 환경</label>
      <select class="setup-select" id="setup-cultivation">
        <option value="OPEN_FIELD">노지</option>
        <option value="FACILITY_SOIL">시설 흙재배</option>
        <option value="FACILITY_HYDRO">시설 수경재배</option>
      </select>
      <label for="setup-started">${setupState.usageMode === 'ACTIVE_GROWING' ? '심거나 옮겨 심은 날짜' : '시작 예정일'}</label>
      <input class="setup-input" id="setup-started" type="date" value="${setupState.startedKey}" max="${setupState.usageMode === 'ACTIVE_GROWING' ? todayKey() : ''}" />
    </div>
    <div class="setup-actions"><button class="btn btn-primary" id="setup-stage-next" type="button" disabled>이 상태로 시작하기</button></div>`;
  const next = $('#setup-stage-next');
  body.querySelectorAll('[data-stage]').forEach((button) => {
    button.onclick = () => {
      body.querySelectorAll('[data-stage]').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      setupState.stageKey = button.dataset.stage;
      next.disabled = false;
    };
  });
  next.onclick = () => {
    setupState.cultivationMode = $('#setup-cultivation').value;
    setupState.startedKey = $('#setup-started').value || todayKey();
    if (!setupState.stageKey) return;
    if (!userName) renderSetupStep('name');
    else completeSetup();
  };
}

function renderSetupName(body) {
  body.innerHTML = `${setupHeading('마지막 질문', '어떻게 불러드릴까요?', '밭 이름과 기록에 사용할 이름이에요.')}
    <form class="setup-form" id="setup-name-form">
      <input class="setup-input" id="setup-name" maxlength="10" autocomplete="nickname" placeholder="이름 또는 별명" />
      <button class="btn btn-primary" type="submit">내 밭 시작하기</button>
    </form>`;
  $('#setup-name-form').onsubmit = (event) => {
    event.preventDefault();
    const value = $('#setup-name').value.trim();
    if (!value) return toast('이름이나 별명을 입력해 주세요.');
    userName = value;
    localStorage.setItem('farm.name', userName);
    completeSetup();
  };
}

async function completeSetup() {
  const body = $('#setup-body');
  body.innerHTML = `<div class="setup-loading" role="status">${cropPortrait(setupState.cropId)}<h1 class="setup-title">작은 밭을 준비하고 있어요</h1></div>`;
  const cropResult = await api('/api/me/character', {
    method: 'POST',
    body: JSON.stringify({
      characterId: setupState.cropId,
      cropContext: {
        usageMode: setupState.usageMode,
        region: setupState.region,
        cultivationMode: setupState.cultivationMode,
        stageKey: setupState.stageKey,
        startedKey: setupState.startedKey,
        analysisId: setupState.analysis?.analysisId || null,
      },
    }),
  });
  if (!cropResult.ok) {
    toast(cropResult.message || '작물을 추가하지 못했어요.');
    renderSetupStep('stage', { remember: false });
    return;
  }
  const profileResult = await api('/api/me/profile', {
    method: 'POST',
    body: JSON.stringify({
      displayName: userName,
      onboardingComplete: true,
      usageMode: setupState.usageMode,
      region: setupState.region,
      cultivationMode: setupState.cultivationMode,
    }),
  });
  profile = profileResult.profile || profile;
  farmRegion = setupState.region || farmRegion;
  localStorage.setItem('farm.region', farmRegion);
  environmentCache.clear();
  await refreshStatus();
  activeCropId = setupState.cropId;
  renderHome();
  show('home');
  if (setupState.preventive?.added?.length) {
    notifyPreventive(setupState.preventive);
  } else {
    toast(setupState.kind === 'add' ? '새 작물을 밭에 더했어요.' : '내 밭을 시작했어요.');
  }
  setupState = null;
}

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
async function plantSeeds(cropIds) {
  let planted = 0;
  let lastMessage = '';
  for (const id of cropIds) {
    const res = await api('/api/me/character', {
      method: 'POST',
      body: JSON.stringify({ characterId: id }),
    });
    if (res.ok) { planted += 1; lastMessage = res.message; }
    else toast(res.message || '씨앗을 심지 못했어요.');
  }
  if (planted === 1) toast(lastMessage);
  else if (planted > 1) toast(`씨앗 ${planted}개를 심었어요! 매일 돌봐주세요.`);
  return planted;
}

function renderSelectView() {
  $('#select-eyebrow').textContent = '첫 씨앗';
  $('#select-title').textContent = '무엇을 키워볼까요?';
  const grid = $('#crop-grid');
  grid.innerHTML = cropCardsHTML(selectableCrops);
  const confirm = $('#select-confirm');
  confirm.disabled = true;
  confirm.textContent = '씨앗 심기';
  const picked = bindCropToggle(grid, confirm, '씨앗 심기');
  confirm.onclick = async () => {
    if (!picked.size) return;
    confirm.disabled = true;
    const planted = await plantSeeds([...picked]);
    if (planted > 0) {
      await refreshStatus();
      activeCropId = [...picked][0];
      renderHome();
      show('home');
    } else {
      confirm.disabled = false;
    }
  };
}

// 새 작물 추가 시트 (+ 아이콘): 아직 키우지 않는 작물만 보여줌
function openSeedOverlay() {
  beginSetup('add');
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

const todoEvidenceCache = new Map();

function todoSourceContext(todo) {
  const match = String(todo?.sourceKey || '').match(/^environment:(\d{4}-\d{2}-\d{2}):([^:]+):/);
  return {
    dateKey: match?.[1] || null,
    cropId: todo?.cropId || match?.[2] || null,
  };
}

function normalizedTodoText(value) {
  return String(value || '').replace(/[.!?。]|\s/g, '').toLowerCase();
}

function todoDateLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? fmtKey(value) : '';
}

function todoLooksSoilRelated(text) {
  return /토양|흙|pH|산도|EC|염류|배수|관수|수분|고인 물|침수|토성/.test(String(text || ''));
}

async function recoverTodoEvidence(todo) {
  if (todo?.evidence) return todo.evidence;
  if (todo?.source !== 'ENVIRONMENT_ANALYSIS') return null;
  const source = todoSourceContext(todo);
  const crop = (status?.crops || []).find((item) => item.cropId === source.cropId);
  if (!crop) return null;

  try {
    const detail = await loadEnvironmentDetail(crop);
    const target = normalizedTodoText(todo.text);
    const actionDay = detail.week.find((day) =>
      day.guidance?.actions?.some((action) => normalizedTodoText(action) === target));
    const datedDay = detail.week.find((day) => day.date === source.dateKey);
    const riskyDay = detail.week.find((day) => day.status === 'DANGER' || day.status === 'CAUTION');
    const day = actionDay || datedDay || riskyDay || null;
    const soilRelated = todoLooksSoilRelated(todo.text) && !actionDay;
    const cropContext = { cropName: CROP_NAMES[crop.cropId] || crop.cropName || crop.cropId };
    const soilCopy = soilRelated ? soilScoreExplanation(detail, cropContext) : null;
    const weatherCopy = !soilRelated && day
      ? weatherDayExplanation(day, cropContext, detail)
      : null;
    return {
      cropId: crop.cropId,
      cropName: cropContext.cropName,
      dateKey: day?.date || source.dateKey || detail.updatedAt?.slice(0, 10) || null,
      status: soilRelated ? detail.soil.status : day?.status || detail.status,
      statusLabel: soilRelated
        ? (detail.soil.status === 'DANGER' ? '위험' : detail.soil.status === 'GOOD' ? '양호' : '주의')
        : day?.statusLabel || detail.statusLabel,
      axis: soilRelated ? 'soil' : 'weather',
      causeLabel: soilRelated ? detail.soil.label : day?.causeLabel || detail.weather.label,
      reason: soilCopy?.lines?.[0] || weatherCopy?.lines?.slice(0, 2).join(' ') || null,
      recheck: day?.guidance?.recheck || null,
      recovered: true,
    };
  } catch {
    return null;
  }
}

async function loadTodoEvidence(todos) {
  // 같은 작물의 자동 할 일이 여러 개여도 환경 분석은 한 번만 불러옵니다.
  // 기존 20개 할 일이 동일 API를 동시에 호출하던 지연을 막습니다.
  const cropIds = new Set(
    todos
      .map((todo) => todoSourceContext(todo).cropId)
      .filter(Boolean),
  );
  await Promise.allSettled([...cropIds].map((cropId) => {
    const crop = status?.crops?.find((item) => item.cropId === cropId);
    return crop ? loadEnvironmentDetail(crop) : Promise.resolve();
  }));
  const pairs = await Promise.all(todos.map(async (todo) => [todo.id, await recoverTodoEvidence(todo)]));
  todoEvidenceCache.clear();
  for (const [id, evidence] of pairs) {
    if (evidence) todoEvidenceCache.set(id, evidence);
  }
}

function todoEvidenceCopy(todo) {
  const evidence = todo.evidence || todoEvidenceCache.get(todo.id);
  if (!evidence) return null;
  const dateLabel = todoDateLabel(evidence.dateKey) || '최근 분석';
  const untilLabel = evidence.untilKey && evidence.untilKey !== evidence.dateKey
    ? `~${todoDateLabel(evidence.untilKey)}`
    : '';
  const cropName = evidence.cropName || CROP_NAMES[evidence.cropId] || CROP_NAMES[todo.cropId] || '작물';
  const statusLabel = evidence.statusLabel || (todo.priority === 'DANGER' ? '위험' : '주의');
  const causeLabel = evidence.causeLabel || '환경 변화';
  const reason = evidence.reason
    || `${causeLabel} 신호가 ${cropName}의 생육에 영향을 줄 수 있어 예방 행동으로 추가했어요.`;
  const timing = evidence.axis === 'soil'
    ? `${dateLabel}${untilLabel} 토양 분석에서 확인된 신호예요. 오늘 밭 상태를 확인하고 행동한 뒤 다시 살펴보세요.`
    : `${dateLabel}${untilLabel} 예보와 연결된 일이에요. 가능하면 예보 전에, 늦어도 해당 날짜 오전에 확인하세요.`;
  const statusParticle = statusLabel === '위험' ? '과' : '와';
  return {
    preview: `${cropName} · ${dateLabel} ${causeLabel} ${statusLabel}${statusParticle} 연결`,
    signal: `${dateLabel}${untilLabel} · ${cropName} · ${statusLabel} · ${causeLabel}`,
    reason,
    timing: evidence.recheck ? `${timing} ${evidence.recheck}` : timing,
    recovered: evidence.recovered === true,
  };
}

function renderTodoList(todos) {
  const doneCount = todos.filter((t) => t.done).length;
  $('#todo-summary').textContent = todos.length
    ? `모두 ${todos.length}개 · 끝낸 일 ${doneCount}개`
    : '';

  $('#todo-list').innerHTML = todos.length
    ? todos.map((t) => `
      <article class="todo-item ${t.done ? 'done' : ''} ${t.priority ? `priority-${t.priority.toLowerCase()}` : ''}" data-id="${t.id}">
        <button class="todo-check" aria-label="완료 표시">${todoCheckSvg(t.done)}</button>
        <button class="todo-main" type="button" aria-expanded="false">
          <span class="todo-copy">${t.priority ? `<small class="todo-priority">${t.priority === 'DANGER' ? '위험 예방' : '주의 예방'}</small>` : ''}<span class="todo-text"></span><small class="todo-link-preview"></small></span>
        </button>
        <span class="todo-date"></span>
        <button class="todo-del" aria-label="삭제">✕</button>
        <div class="todo-evidence" hidden>
          <p class="todo-signal"></p>
          <div><strong>왜 필요한가요?</strong><p class="todo-reason"></p></div>
          <div><strong>언제 확인하나요?</strong><p class="todo-timing"></p></div>
          <small class="todo-evidence-note" hidden>기존 할 일은 저장된 분석 날짜와 현재 연결된 같은 작물 자료를 기준으로 정리했어요.</small>
        </div>
      </article>`).join('')
    : `<p class="empty-note">아직 할 일이 없어요.<br/>아래에서 하나 골라 시작해볼까요?</p>`;

  // 사용자 입력 텍스트는 innerHTML 대신 textContent로 안전하게 채움
  document.querySelectorAll('.todo-item').forEach((el, i) => {
    const todo = todos[i];
    const copy = todoEvidenceCopy(todo);
    el.querySelector('.todo-text').textContent = todo.text;
    const dateKey = copy
      ? (todo.evidence || todoEvidenceCache.get(todo.id)).dateKey
      : todo.createdKey;
    el.querySelector('.todo-date').textContent = todoDateLabel(dateKey);
    const main = el.querySelector('.todo-main');
    const evidencePanel = el.querySelector('.todo-evidence');
    if (copy) {
      el.querySelector('.todo-link-preview').textContent = copy.preview;
      el.querySelector('.todo-signal').textContent = copy.signal;
      el.querySelector('.todo-reason').textContent = copy.reason;
      el.querySelector('.todo-timing').textContent = copy.timing;
      el.querySelector('.todo-evidence-note').hidden = !copy.recovered;
      const toggleEvidence = () => {
        const willOpen = evidencePanel.hidden;
        evidencePanel.hidden = !willOpen;
        main.setAttribute('aria-expanded', String(willOpen));
        el.classList.toggle('is-open', willOpen);
      };
      main.onclick = toggleEvidence;
      el.onclick = (event) => {
        if (event.target.closest('.todo-main, .todo-check, .todo-del, .todo-evidence')) return;
        toggleEvidence();
      };
    } else {
      el.querySelector('.todo-link-preview').textContent = '직접 적은 할 일';
      main.disabled = true;
    }
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

async function renderTodos() {
  const data = await api('/api/me/todos');
  const todos = data.todos || [];
  await loadTodoEvidence(todos);
  renderTodoList(todos);
  await api('/api/me/notifications/read', { method: 'POST', body: '{}' });
  if (status) status.unreadNotifications = 0;
  updateTodoAlert(0);
}

/* ════════════════════════════════════════════
   6. 농장 상담 (현재 분석 근거 기반 로컬 상담)
════════════════════════════════════════════ */

const CHAT_SUGGESTIONS = ['오늘 무엇부터 할까?', '왜 주의 상태야?', '토양은 어떤 상태야?'];

function chatStorageKey() { return `farm.chat.${userId}`; }
function chatHistory() {
  try { return JSON.parse(localStorage.getItem(chatStorageKey()) || '[]'); } catch { return []; }
}
function saveChatHistory(messages) {
  localStorage.setItem(chatStorageKey(), JSON.stringify(messages.slice(-30)));
}

async function renderChat() {
  $('#chat-suggestions').innerHTML = CHAT_SUGGESTIONS.map((text, index) => `<button type="button" data-chat-suggest="${index}">${text}</button>`).join('');
  document.querySelectorAll('[data-chat-suggest]').forEach((button) => {
    button.onclick = () => sendChatQuestion(CHAT_SUGGESTIONS[Number(button.dataset.chatSuggest)]);
  });
  renderChatMessages(chatHistory());
}

function renderChatMessages(messages) {
  const root = $('#chat-messages');
  root.innerHTML = '';
  if (!messages.length) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-message assistant';
    welcome.textContent = '지금 보고 있는 작물의 환경 분석을 바탕으로 오늘 할 일과 주의 이유를 정리해 드릴게요.';
    root.append(welcome);
    return;
  }
  for (const message of messages) {
    const item = document.createElement('div');
    item.className = `chat-message ${message.role === 'user' ? 'user' : 'assistant'}`;
    item.textContent = message.text;
    root.append(item);
  }
  root.lastElementChild?.scrollIntoView({ block: 'end' });
}

async function sendChatQuestion(rawQuestion) {
  const question = String(rawQuestion || '').trim();
  if (!question) return;
  const messages = chatHistory();
  messages.push({ role: 'user', text: question, at: new Date().toISOString() });
  renderChatMessages(messages);
  const crop = getActiveCrop();
  let answer;
  try {
    if (!crop) throw new Error('먼저 작물을 설정해 주세요.');
    const detail = await loadEnvironmentDetail(crop);
    answer = localGroundedAnswer(question, crop, detail);
  } catch (error) {
    answer = error.message || '현재 분석을 불러오지 못했어요.';
  }
  messages.push({ role: 'assistant', text: answer, at: new Date().toISOString() });
  saveChatHistory(messages);
  renderChatMessages(messages);
}

function localGroundedAnswer(question, crop, detail) {
  const name = crop.cropName || CROP_NAMES[crop.cropId] || '작물';
  const riskyDay = detail.week.find((day) => day.status === 'DANGER' || day.status === 'CAUTION');
  const firstAction = riskyDay?.guidance?.actions?.[0];
  if (/토양|흙|산도|pH|EC/iu.test(question)) {
    const observed = Number.isFinite(detail.soil.observedValue) ? `현재 참고값은 ${detail.soil.observedValue}예요. ` : '';
    const range = detail.soil.optimalRange?.length === 2 ? `${name}의 적정 범위는 ${detail.soil.optimalRange[0]}~${detail.soil.optimalRange[1]}예요. ` : '';
    return `${detail.soil.label}으로 판단했어요. ${observed}${range}${detail.soil.referenceOnly ? '지역 통계라서 내 밭 토양검정을 연결하면 더 정확해져요.' : ''}`.trim();
  }
  if (/점수|왜|주의|위험/iu.test(question)) {
    return `${name}의 환경 점수는 ${Number.isFinite(detail.totalScore) ? `${detail.totalScore}점` : '산정 중'}이고, 가장 큰 원인은 ${detail.causeLabel}이에요. ${firstAction || '상세 보기에서 기준값과 현장 확인 항목을 함께 확인해 주세요.'}`;
  }
  return `${name}는 현재 ${detail.statusLabel} 상태예요. ${riskyDay ? `${fmtKey(riskyDay.date)}에는 ${riskyDay.causeLabel}을 확인해야 해요. ` : ''}${firstAction || '오늘은 잎과 토양 수분을 먼저 살펴보세요.'}`;
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

let diaryPhotoData = null;

function photoDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('young-farmer-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('diaryPhotos');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localPhoto(action, dayKey, value) {
  const db = await photoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('diaryPhotos', 'readwrite');
    const store = transaction.objectStore('diaryPhotos');
    const key = `${userId}:${dayKey}`;
    const request = action === 'get' ? store.get(key) : action === 'delete' ? store.delete(key) : store.put(value, key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

function resizeDiaryPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/u.test(file.type) || file.size > 12 * 1024 * 1024) {
      reject(new Error('12MB 이하 JPG·PNG·WEBP 사진을 골라 주세요.'));
      return;
    }
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어요.')); };
    image.src = url;
  });
}

function diaryDateLabel(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${DOW[date.getDay()]})`;
}

async function renderDiary() {
  const data = await api('/api/me/diary');
  const entries = [...(data.entries || [])].sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  const tKey = todayKey();
  const todayEntry = entries.find((e) => e.dayKey === tKey);

  diaryPhotoData = await localPhoto('get', tKey).catch(() => null);
  const preview = $('#diary-photo-preview');
  preview.hidden = !diaryPhotoData;
  preview.src = diaryPhotoData || '';
  $('#diary-photo-remove').hidden = !diaryPhotoData;

  $('#diary-photo').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      diaryPhotoData = await resizeDiaryPhoto(file);
      preview.src = diaryPhotoData;
      preview.hidden = false;
      $('#diary-photo-remove').hidden = false;
    } catch (error) {
      toast(error.message);
      event.target.value = '';
    }
  };
  $('#diary-photo-remove').onclick = () => {
    diaryPhotoData = null;
    preview.src = '';
    preview.hidden = true;
    $('#diary-photo-remove').hidden = true;
    $('#diary-photo').value = '';
  };

  const textarea = $('#diary-text');
  const saveBtn = $('#diary-save');
  if (document.activeElement !== textarea) {
    textarea.value = todayEntry ? todayEntry.text : '';
  }
  saveBtn.textContent = todayEntry ? '오늘 기록 고쳐 쓰기' : '오늘 기록 남기기';
  $('#diary-hint').textContent = todayEntry ? '비우고 저장하면 지워져요' : '하루에 한 편이면 충분해요';

  saveBtn.onclick = async () => {
    const text = textarea.value.trim();
    if (!text && !diaryPhotoData && !todayEntry) {
      toast('한 줄이나 사진 한 장을 남겨 주세요.');
      return;
    }
    const savedText = text || (diaryPhotoData ? '사진으로 오늘 밭을 기록했어요.' : '');
    saveBtn.disabled = true;
    const res = await api('/api/me/diary', {
      method: 'POST',
      body: JSON.stringify({ text: savedText }),
    });
    saveBtn.disabled = false;
    if (!res.ok) { toast(res.message || '저장하지 못했어요.'); return; }
    if (res.deleted) await localPhoto('delete', tKey).catch(() => {});
    else if (diaryPhotoData) await localPhoto('put', tKey, diaryPhotoData).catch(() => {});
    else await localPhoto('delete', tKey).catch(() => {});
    toast(res.deleted ? '오늘 일기를 지웠어요.' : '오늘의 기록을 심어뒀어요.');
    renderDiary();
  };

  const list = $('#diary-list');
  list.innerHTML = entries.length
    ? entries.map((e) => `
      <div class="diary-item">
        ${e.cropId ? cropPortrait(e.cropId, e.stageKey || 'sprout') : cropPortrait('cucumber', 'sprout')}
        <div>
          <div class="d-date">${diaryDateLabel(e.dayKey)}${
            e.cropId ? ` · ${CROP_NAMES[e.cropId] || ''} ${STAGE_NAME_HINT[e.stageKey] || ''}` : ''}</div>
          <div class="d-text"></div>
        </div>
      </div>`).join('')
    : `<p class="empty-note">첫 일기가 아직 없어요.<br/>한 줄이면 충분해요.</p>`;
  list.querySelectorAll('.d-text').forEach((el, i) => { el.textContent = entries[i].text; });
  await Promise.all(entries.map(async (entry, index) => {
    const photo = await localPhoto('get', entry.dayKey).catch(() => null);
    if (!photo) return;
    const image = document.createElement('img');
    image.className = 'd-photo';
    image.src = photo;
    image.alt = `${diaryDateLabel(entry.dayKey)} 밭 사진`;
    list.children[index]?.append(image);
  }));
}

function renderRecords() {
  renderDiary();
  $('#stat-row').innerHTML = `
    <div class="stat-cell"><div class="s-value">${status.streak}</div><div class="s-label">연속 출석</div></div>
    <div class="stat-cell"><div class="s-value">${status.longestStreak}</div><div class="s-label">최고 연속</div></div>
    <div class="stat-cell"><div class="s-value">${status.totalCheckIns}</div><div class="s-label">누적 출석</div></div>`;

  // 이번 달 달력
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  $('#calendar-title').textContent = `${y}년 ${m + 1}월`;
  const checked = new Set(status.attendanceHistory || []);
  const tKey = todayKey(now);
  const first = new Date(y, m, 1);
  const days = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 월요일 시작

  let html = ['월', '화', '수', '목', '금', '토', '일']
    .map((d) => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < lead; i++) html += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const key = todayKey(new Date(y, m, d));
    const cls = ['day', checked.has(key) ? 'checked' : '', key === tKey ? 'today' : ''].join(' ');
    html += `<span class="${cls}">${d}</span>`;
  }
  $('#calendar').innerHTML = html;

  const done = status.completedCrops || [];
  $('#harvest-list').innerHTML = done.length
    ? done.map((c) => `
      <div class="harvest-item">
        ${cropPortrait(c.cropId)}
        <span>듬직한 ${CROP_NAMES[c.cropId] || c.cropId}</span>
        <span class="h-date">${c.finishedKey ? fmtKey(c.finishedKey) + ' 수확' : ''}</span>
      </div>`).join('')
    : `<p class="empty-note">아직 다 키운 작물이 없어요.<br/>7일만 꾸준히 오면 첫 수확이에요.</p>`;
}

/* ════════════════════════════════════════════
   8. 설정
════════════════════════════════════════════ */

function renderSettings() {
  $('#settings-profile').innerHTML = `
    <div class="sc-row">
      <div>
        <div class="sc-label">밭 주인</div>
        <div class="sc-value">${escapeHtml(userName)}</div>
      </div>
      <button class="link-btn" id="rename-btn">이름 바꾸기</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">농장 지역</div>
        <div class="sc-value farm-region-value">${escapeHtml(farmRegion)}</div>
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
        <div class="sc-label">예방 알림</div>
        <div class="sc-value" style="font-size:13.5px;color:var(--ink-soft)">${profile?.notificationsEnabled ? '주의·위험 알림 켜짐' : '필요할 때만 켤 수 있어요'}</div>
      </div>
      <button class="link-btn" id="notification-setting">${profile?.notificationsEnabled ? '끄기' : '켜기'}</button>
    </div>`;
  $('#region-btn').onclick = () => {
    const next = prompt('농장 지역을 시·군·구까지 입력해 주세요.', farmRegion);
    if (!next || !next.trim() || next.trim() === farmRegion) return;
    farmRegion = next.trim();
    localStorage.setItem('farm.region', farmRegion);
    environmentCache.clear();
    renderSettings();
    toast('농장 지역을 바꿨어요.');
  };
  $('#open-rewards-settings').onclick = async () => {
    await renderRewards();
    show('rewards');
  };
  $('#notification-setting').onclick = async () => {
    let enabled = !profile?.notificationsEnabled;
    if (enabled && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      enabled = permission === 'granted';
      if (!enabled) toast('기기 알림 권한이 꺼져 있어 앱 안에서만 알려드릴게요.');
    }
    const result = await api('/api/me/profile', {
      method: 'POST',
      body: JSON.stringify({ notificationsEnabled: enabled }),
    });
    if (!result.ok) return toast('알림 설정을 바꾸지 못했어요.');
    profile = result.profile;
    renderSettings();
    toast(enabled ? '주의·위험 예방 알림을 켰어요.' : '기기 알림을 껐어요.');
  };
  $('#rename-btn').onclick = () => {
    const next = prompt('새 이름을 입력해 주세요.\n(이름이 바뀌면 새 밭에서 다시 시작해요)', userName);
    if (!next || !next.trim() || next.trim() === userName) return;
    userName = next.trim();
    localStorage.setItem('farm.name', userName);
    location.reload();
  };

  renderTitleSettings();
}

function renderTitleSettings() {
  const titles = status?.titles;
  if (!titles) {
    $('#settings-titles').innerHTML = '<p class="empty-note">출석 기록을 불러오면 칭호가 보여요.</p>';
    return;
  }
  const unlocked = new Set(titles.unlocked.map((title) => title.key));
  const allTitles = [
    ['seed', '씨앗', 0], ['sprout', '새싹', 3], ['sapling', '어린 나무', 7],
    ['tree', '튼튼한 나무', 14], ['grove', '작은 숲', 30], ['worldtree', '세계수', 60],
  ];
  $('#settings-titles').innerHTML = `
    <div class="sc-label">나의 칭호와 밭 테두리</div>
    <div class="sc-value">${titles.current.name}</div>
    <p class="reference-note">${titles.next ? `${titles.next.name}까지 출석 ${titles.next.remaining}번` : '모든 칭호를 모았어요'}</p>
    <div class="title-grid">${allTitles.map(([key, name, count]) => `
      <button class="title-choice ${titles.selectedBorderKey === key ? 'selected' : ''}" data-title="${key}" ${unlocked.has(key) ? '' : 'disabled'}>
        <strong>${name}</strong><span>${unlocked.has(key) ? '테두리 선택 가능' : `출석 ${count}회에 열림`}</span>
      </button>`).join('')}</div>`;
  document.querySelectorAll('[data-title]:not(:disabled)').forEach((button) => {
    button.onclick = async () => {
      const result = await api('/api/me/profile', {
        method: 'POST',
        body: JSON.stringify({ selectedTitleKey: button.dataset.title, selectedBorderKey: button.dataset.title }),
      });
      if (!result.ok) return toast('칭호를 바꾸지 못했어요.');
      profile = result.profile;
      await refreshStatus();
      renderTitleSettings();
      applySelectedBorder();
      toast('칭호와 밭 테두리를 바꿨어요.');
    };
  });
}

/* ════════════════════════════════════════════
   9. 시작 흐름
════════════════════════════════════════════ */

async function refreshStatus() {
  status = await api('/api/me/status');
}

async function boot() {
  // 탭 구성
  document.querySelectorAll('.tab').forEach((t) => {
    const v = t.dataset.view;
    t.innerHTML = `${TAB_ICONS[v]}<span>${TAB_LABELS[v]}</span><span class="tab-underline"></span>`;
    t.addEventListener('click', async () => {
      if (v === 'home') { await refreshStatus(); renderHome(); }
      if (v === 'todos') renderTodos();
      if (v === 'chat') renderChat();
      if (v === 'records') { await refreshStatus(); renderRecords(); }
      if (v === 'settings') { await refreshStatus(); renderSettings(); }
      show(v);
    });
  });

  $('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    await sendChatQuestion(question);
  });

  $('#setup-back').onclick = previousSetupStep;
  $('#setup-close').onclick = () => { renderHome(); show('home'); };

  // 할 일 추가 폼
  $('#todo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#todo-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await addTodo(text);
  });

  // 교환소 → 대시보드 돌아가기
  $('#rewards-back').addEventListener('click', async () => {
    await refreshStatus();
    renderHome();
    show('home');
  });

  await enter();
}

async function enter() {
  try {
    const profileResult = await api('/api/me/profile');
    profile = profileResult.profile || null;
    if (!userName && profile?.displayName) {
      userName = profile.displayName;
      localStorage.setItem('farm.name', userName);
    }
    if (profile?.region) {
      farmRegion = profile.region;
      localStorage.setItem('farm.region', farmRegion);
    }
    const ob = await api('/api/me/onboarding');
    selectableCrops = ob.characters || [];
    if (ob.isFirstTime) {
      await refreshStatus();
      beginSetup('initial');
      return;
    }
    if (!userName) {
      userName = profile?.displayName || '농부';
      localStorage.setItem('farm.name', userName);
    }
    await refreshStatus();
    renderHome();
    show('home');
  } catch {
    toast('서버에 연결할 수 없어요. 터미널에서 npm start를 실행해 주세요.', 4000);
  }
}

setInterval(() => {
  if (!$('#view-home')?.hidden) applyTimeTheme();
}, 15 * 60 * 1000);

// 앱 화면(index.html)에서만 부팅 — 미리보기 페이지 등이 이 모듈을
// import 해서 그림 함수만 쓸 수 있게 함
if (document.querySelector('#view-home')) boot();

// 다른 페이지(미리보기 등)에서 쓰는 그림 함수들
export { plantScene, cropPortrait, conditionScene };
