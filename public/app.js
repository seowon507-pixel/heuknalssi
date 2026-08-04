// app.js — 청년농부 프론트엔드
// 그림은 전부 아래 "일러스트 라이브러리"에서 코드로 그립니다.
// (외부 이미지 없음 → 어떤 화면에서도 스타일이 어긋나지 않음)

import { CONDITIONS, conditionIcon, conditionBadge } from './conditions.js';
import { assessSuitability } from './analysis.js';

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
  return `<g>
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
    air: `${fx('fx-pulse', sunArt(178, 72, 15))}${fx('fx-shimmer', heatWavesArt(66, 118))}`,
  },
  heatwave: {
    sev: 'danger',
    sky: '#faeddc',
    air: `${fx('fx-pulse', sunArt(178, 70, 17), 0, 2.2)}
      ${fx('fx-shimmer', heatWavesArt(60, 110))}${fx('fx-shimmer', heatWavesArt(96, 152, 0.9), 0.7)}`,
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
    air: `${fx('fx-bob', phDropArt(74, 140, 1))}${fx('fx-bob', dew(190, 162, 0.8), 1.4)}`,
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
 * @param {string} code - conditions.js의 상태 코드 (예: 'rain', 'heatwave', 'flood')
 */
function conditionScene(cropId, stageKey = 'mature', code = 'stable') {
  const fxDef = CONDITION_FX[code] || {};
  const sev = fxDef.sev || 'good';
  const faceMood = sev === 'danger' ? 'danger' : sev === 'warn' ? 'sad' : 'happy';
  // 등급별 움직임: 양호=통통 튀는 리듬 / 주의=축 처진 흔들림 / 위험=덜덜 떨림
  const swayClass = sev === 'danger' ? 'sway-danger' : sev === 'warn' ? 'sway-sad' : 'sway-happy';
  const id = `vg${++uid}`;
  const s = STAGE_SCALE[stageKey] || 1.2;
  return `<svg viewBox="0 0 260 288" role="img" aria-label="${cropId} · ${code}">
    <defs><clipPath id="${id}"><ellipse cx="130" cy="144" rx="112" ry="130"/></clipPath></defs>
    <ellipse cx="130" cy="144" rx="112" ry="130" fill="${fxDef.sky || '#fbf8ef'}"/>
    <g clip-path="url(#${id})">
      <path d="M10,216 Q130,197 250,216" fill="none" stroke="#e3dbc4" stroke-width="1.6"/>
      ${fxDef.air || ''}
      ${ground()}
      ${fxDef.soilFx || ''}
      <g class="${swayClass}"><g transform="translate(130 227) scale(${s}) translate(-130 -227)">
        ${plantArt(cropId, stageKey, faceMood)}
      </g></g>
      ${fxDef.overlay || ''}
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // HTTP 헤더에는 한글을 담을 수 없어 인코딩해서 보냄 (서버에서 디코딩)
      'x-user-id': encodeURIComponent(userName),
      ...(options.headers || {}),
    },
  });
  return res.json();
}

/* ════════════════════════════════════════════
   3. 화면 전환 & 공용 UI
════════════════════════════════════════════ */

const $ = (sel) => document.querySelector(sel);
const views = ['wizard', 'home', 'todos', 'rewards', 'records', 'settings'];
const TAB_LABELS = { home: '대시보드', todos: 'TO-DO', records: '기록', settings: '설정' };

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
    crops.map((c) => `
      <button class="crop-badge ${active && c.cropId === active.cropId ? 'active' : ''}"
        data-crop="${c.cropId}" title="${CROP_NAMES[c.cropId] || ''} 보기"
        aria-label="${CROP_NAMES[c.cropId] || ''} 상황 보기">
        ${cropPortrait(c.cropId)}
      </button>`).join('')
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
}

function renderHome() {
  $('#home-greet').textContent = `${userName}의 작은 밭`;
  $('#home-date').textContent = fmtDate();

  const crop = getActiveCrop();
  activeCropId = crop ? crop.cropId : null;
  renderCropIcons(crop);

  const mood = crop && crop.matured ? 'harvest' : status.checkedInToday ? 'done' : 'wait';

  // 장면
  if (crop) {
    $('#vignette').innerHTML = plantScene(crop.cropId, crop.stageKey, mood === 'harvest' ? 'done' : mood);
  }

  // 상태 문구
  const title = $('#status-title');
  const sub = $('#status-sub');
  if (mood === 'harvest') {
    title.textContent = '수확 · 완료';
    sub.textContent = `${crop.cropName}가 다 자랐어요! 수확해 주세요.`;
  } else if (mood === 'done') {
    title.textContent = '양호 · 촉촉';
    sub.textContent = '';
  } else {
    title.textContent = '기다림 · 마른 흙';
    sub.textContent = '아직 오늘의 물을 주지 않았어요.';
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
   ※ 백엔드 준비 중 — 아래 MOCK_DETAIL을 API 응답으로 교체하면 됨.
   (기상 점수 / 토지 점수 / 종합 점수 + 일주일 기상정보) */

const MOCK_DETAIL = {
  weatherScore: 78,      // 기상 점수 (0~100)
  soilScore: 84,         // 토지 점수 (0~100)
  weatherCode: 'clear',  // conditions.js 상태 코드
  soilCode: 'soilStable',
  // 내 땅 분석 (농촌진흥청 흙토람 등 연동 예정)
  land: {
    moisture: 45,        // 토양 수분 % (적정 20~80)
    ph: 6.5,             // 산도 (적정 5.5~7.5)
    ec: 1.2,             // 염류 dS/m (기준 2 이하)
    drainage: '좋음',     // 물 빠짐
    texture: '양토',      // 토성
    textureOk: true,
  },
  // 오늘부터 7일 예보 (기상청 단기예보 연동 예정)
  week: [
    { code: 'clear',    tMax: 31, tMin: 24 },
    { code: 'clear',    tMax: 32, tMin: 25 },
    { code: 'rain',     tMax: 28, tMin: 23 },
    { code: 'downpour', tMax: 26, tMin: 22 },
    { code: 'rain',     tMax: 27, tMin: 22 },
    { code: 'stable',   tMax: 29, tMin: 23 },
    { code: 'heat',     tMax: 33, tMin: 25 },
  ],
};

function scoreGrade(n) {
  return n >= 80 ? '아주 좋음' : n >= 60 ? '좋음' : n >= 40 ? '보통' : '주의';
}

// 예보 상태 → 왜 주의·위험인지 설명 (판정 기준 + 작물에 미치는 영향)
const CONDITION_REASONS = {
  heat: '최고기온이 30℃를 넘어요. 잎이 시들고 흙의 수분이 빨리 마를 수 있어요.',
  heatwave: '33℃ 이상의 심한 더위가 이어져요. 강한 볕에 잎이 타고 생육이 멈출 수 있어요.',
  cold: '최저기온이 5℃ 아래로 떨어져요. 생육이 느려지고 냉해를 입을 수 있어요.',
  frost: '기온이 영하로 내려가 서리가 앉을 수 있어요. 어린잎이 얼면 회복이 어려워요.',
  rain: '비가 예보돼 있어요. 흙이 계속 젖어 있으면 뿌리가 약해지고 병이 생기기 쉬워요.',
  downpour: '하루 80mm가 넘는 많은 비가 예상돼요. 밭이 잠기거나 뿌리가 썩을 수 있어요.',
  wind: '초속 14m 이상의 강한 바람이 불어요. 줄기가 꺾이거나 지지대가 넘어갈 수 있어요.',
  typhoon: '태풍 영향권에 들어요. 강한 비바람으로 작물이 쓰러지거나 크게 상할 수 있어요.',
  drought: '비가 오랫동안 오지 않았어요. 흙이 말라 뿌리가 물을 빨아들이지 못할 수 있어요.',
};

// 예보 아이콘에 입힐 기존 fx 애니메이션
const ICON_ANIM = {
  clear: 'fx-pulse', stable: 'fx-pulse', drought: 'fx-pulse',
  heat: 'fx-shimmer', heatwave: 'fx-shimmer',
  rain: 'fx-bob', downpour: 'fx-bob', overwet: 'fx-bob',
  cold: 'fx-twinkle', frost: 'fx-twinkle',
  wind: 'fx-drift', typhoon: 'fx-drift',
};

// 일주일 예보에서 주의·위험 날씨를 모아 "왜 위험한지" 설명 목록 생성
function weekRiskReasons(week) {
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
    reason: CONDITION_REASONS[t.code] || CONDITIONS[t.code].condition,
  }));
}

// 종합 점수 링 게이지
function ringGauge(score) {
  const r = 46, circ = 2 * Math.PI * r;
  const filled = (circ * Math.max(0, Math.min(score, 100))) / 100;
  const color = score >= 60 ? '#6f815a' : score >= 40 ? '#c9825b' : '#b04a35';
  return `<svg width="116" height="116" viewBox="0 0 116 116" role="img" aria-label="종합 점수 ${score}점">
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="#e6ead6" stroke-width="10"/>
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="${color}" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${filled} ${circ}" transform="rotate(-90 58 58)"/>
    <text x="58" y="56" text-anchor="middle" font-size="27" fill="#4b4237"
      font-family="'Gowun Dodum', sans-serif">${score}</text>
    <text x="58" y="76" text-anchor="middle" font-size="12" fill="#8a7d6a"
      font-family="'Gowun Dodum', sans-serif">점</text>
  </svg>`;
}

// 값이 적정 범위 어디에 있는지 보여주는 가로 게이지 (연초록 = 적정 구간, 점 = 현재 값)
function rangeBar(value, min, max, okMin, okMax) {
  const pct = Math.max(0, Math.min(((value - min) / (max - min)) * 100, 100));
  const okLeft = ((okMin - min) / (max - min)) * 100;
  const okWidth = ((okMax - okMin) / (max - min)) * 100;
  return `<div class="range-bar">
    <i class="rb-ok" style="left:${okLeft}%;width:${okWidth}%"></i>
    <i class="rb-dot" style="left:${pct}%"></i>
  </div>`;
}

// 내 땅 분석 한 줄 (이름 · 게이지 · 값 · 적정/주의)
function landRow(name, value, unit, min, max, okMin, okMax) {
  const ok = value >= okMin && value <= okMax;
  return `<div class="land-row">
    <span class="lr-name">${name}</span>
    ${rangeBar(value, min, max, okMin, okMax)}
    <span class="lr-value">${value}${unit}</span>
    <span class="wf-flag ${ok ? 'ok' : 'warn'}">${ok ? '적정' : '주의'}</span>
  </div>`;
}

function closeOverlay() {
  const overlay = $('#overlay');
  overlay.hidden = true;
  $('#overlay-panel').classList.remove('detail');
}

function openDetailSheet(crop) {
  const d = MOCK_DETAIL;
  const total = Math.round((d.weatherScore + d.soilScore) / 2);
  const born = crop.startedKey ? diffDaysKey(crop.startedKey, todayKey()) + 1 : null;
  const today = new Date();
  const week = d.week.map((w, i) => {
    const dt = new Date(today);
    dt.setDate(today.getDate() + i);
    return { ...w, label: i === 0 ? '오늘' : DOW[dt.getDay()] };
  });

  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.add('detail');
  panel.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="닫기">✕</button>
    <p class="eyebrow">상세 보기</p>
    <h2 class="sheet-title">${crop.stageName}</h2>
    <p class="sheet-sub">${born ? `태어난 지 ${born}일째 · ` : ''}예시 데이터 (백엔드 연동 예정)</p>

    <div class="score-hero">
      ${ringGauge(total)}
      <div class="score-hero-text">
        <div class="score-grade">${scoreGrade(total)}</div>
        <div class="score-name">종합 점수</div>
      </div>
    </div>

    <div class="score-row">
      <div class="score-cell">
        <div class="sc-head">기상 점수 <strong>${d.weatherScore}</strong></div>
        <div class="score-bar"><i style="width:${d.weatherScore}%"></i></div>
        ${conditionBadge(d.weatherCode)}
      </div>
      <div class="score-cell">
        <div class="sc-head">토지 점수 <strong>${d.soilScore}</strong></div>
        <div class="score-bar"><i style="width:${d.soilScore}%"></i></div>
        ${conditionBadge(d.soilCode)}
      </div>
    </div>

    <h3 class="section-label">내 땅 분석</h3>
    <div class="land-card">
      ${landRow('토양 수분', d.land.moisture, '%', 0, 100, 20, 80)}
      ${landRow('산도 (pH)', d.land.ph, '', 4, 9, 5.5, 7.5)}
      ${landRow('염류 (EC)', d.land.ec, '', 0, 4, 0, 2)}
      <div class="land-row plain">
        <span class="lr-name">물 빠짐</span>
        <span class="lr-text">${d.land.drainage}</span>
        <span class="wf-flag ${d.land.drainage === '좋음' ? 'ok' : 'warn'}">${d.land.drainage === '좋음' ? '적정' : '주의'}</span>
      </div>
      <div class="land-row plain">
        <span class="lr-name">토성</span>
        <span class="lr-text">${d.land.texture}</span>
        <span class="wf-flag ${d.land.textureOk ? 'ok' : 'warn'}">${d.land.textureOk ? '적합' : '주의'}</span>
      </div>
    </div>

    <h3 class="section-label">일주일 기상정보</h3>
    <div class="week-forecast">
      ${week.map((w, i) => {
        const sev = CONDITIONS[w.code]?.severity || 'good';
        const flag = sev === 'danger' ? '<span class="wf-flag danger">위험</span>'
          : sev === 'warn' ? '<span class="wf-flag warn">주의</span>'
          : '<span class="wf-flag none">·</span>';
        return `
        <div class="wf-day ${i === 0 ? 'today' : ''} ${sev === 'danger' ? 'risky' : ''}">
          <span class="wf-dow">${w.label}</span>
          <span class="fx ${ICON_ANIM[w.code] || 'fx-pulse'}" style="animation-delay:${i * 0.25}s">
            ${conditionIcon(w.code, 28)}
          </span>
          <span class="wf-hi">${w.tMax}°</span>
          <span class="wf-lo">${w.tMin}°</span>
          ${flag}
        </div>`;
      }).join('')}
    </div>

    <h3 class="section-label">왜 주의·위험인가요?</h3>
    <div class="sheet-reasons" id="sheet-reasons"></div>`;

  // 주의·위험 예보 → 이유 설명 (판정 기준 + 작물에 미치는 영향)
  const risks = weekRiskReasons(week);
  $('#sheet-reasons').innerHTML = risks.length
    ? risks.map((t) => `
      <div class="sheet-reason">
        ${conditionIcon(t.code, 34)}
        <div class="sr-body">
          <div class="sr-title">
            ${t.days.join('·')} · ${t.label}
            <span class="wf-flag ${t.sev === 'danger' ? 'danger' : 'warn'}">${t.sev === 'danger' ? '위험' : '주의'}</span>
          </div>
          <div class="sr-text">${t.reason}</div>
        </div>
      </div>`).join('')
    : `<p class="empty-note">이번 주는 주의할 날씨가 없어요. 평소처럼 돌봐주세요.</p>`;

  overlay.hidden = false;
  $('#sheet-close').onclick = closeOverlay;
  overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };
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

/* ════════════════════════════════════════════
   5-0. 시작 마법사 — 질문식 온보딩
   틀: 상태 질문 → (준비 중이면) 지역 → 작물 → 적합성 확인/추천 → 필지 경계
       (이미 재배 중이면) 지역 → 필지 경계 → 작물 등록
   지역 환경값은 예시 데이터 — 백엔드(기상·토양 API) 연동 시 교체
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
const myRegion = () => regionOf(localStorage.getItem('farm.region'));

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
      const r = await fetch('/api/characters');
      selectableCrops = (await r.json()).characters || [];
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
    body.innerHTML = wizFrame(title, '현재 위치를 쓰거나 주소를 입력하면, 그 지역 기후·토양 기준으로 분석해요.',
      `<button class="option-card" id="wiz-geo">
        <b>📍 현재 위치로 찾기</b>
        <span>브라우저 위치 권한을 한 번 허용해 주세요.</span>
      </button>
      <form id="wiz-addr-form" class="addr-form">
        <input id="wiz-addr" type="text" placeholder="주소로 찾기 (예: 강원 평창군, 전남 해남군)"
          autocomplete="off" value="${a.address || ''}"/>
        <button type="submit" class="addr-find">찾기</button>
      </form>
      <div id="wiz-loc-result"></div>
      <p class="wiz-sub" style="text-align:center;margin-top:14px">
        <button class="link-btn" id="wiz-region-list-toggle">목록에서 직접 고르기</button>
      </p>
      <div class="region-grid" id="wiz-region-list" hidden>
        ${REGIONS.map((r) => `<button class="region-btn" data-r="${r.id}">${r.name}</button>`).join('')}
      </div>`, '위치 확인');

    const goNext = () => {
      if (wiz.settingsOnly) finishWiz();
      else if (a.mode === 'preparing') goWiz('crop-prep');
      else goWiz('crops-grow');
    };

    // 찾은 위치를 확인 카드로 보여주고, 확정 시 다음 단계로
    const showResult = (region, detail) => {
      a.regionId = region.id;
      a.address = detail;
      $('#wiz-loc-result').innerHTML = `
        <div class="loc-card">
          <div class="loc-info">
            <div class="loc-name">${region.name}</div>
            <div class="loc-detail">${detail}</div>
          </div>
          <button class="btn btn-primary loc-ok" id="wiz-loc-ok">이 위치로 확인</button>
        </div>`;
      $('#wiz-loc-ok').onclick = goNext;
    };

    // 현재 위치 (역지오코딩 → 지도 API 연동 지점)
    $('#wiz-geo').onclick = () => {
      if (!navigator.geolocation) { toast('이 브라우저는 위치를 지원하지 않아요. 주소로 입력해 주세요.'); return; }
      toast('위치를 확인하는 중...');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          const region = nearestRegion(latitude, longitude);
          showResult(region, `현재 위치 (위도 ${latitude.toFixed(3)}, 경도 ${longitude.toFixed(3)}) 부근`);
        },
        () => toast('위치를 가져오지 못했어요. 주소로 입력해 주세요.', 3200),
        { timeout: 8000 },
      );
    };

    // 주소 입력 (지오코딩 → 지도 API 연동 지점)
    $('#wiz-addr-form').onsubmit = (e) => {
      e.preventDefault();
      const text = $('#wiz-addr').value.trim();
      if (!text) { toast('주소를 입력해 주세요.'); return; }
      const region = resolveAddress(text);
      if (region) showResult(region, text);
      else toast('주소에서 지역을 찾지 못했어요. 시/도나 시/군 이름을 넣어보세요.', 3200);
    };

    // 폴백: 목록에서 직접 선택
    $('#wiz-region-list-toggle').onclick = () => {
      const list = $('#wiz-region-list');
      list.hidden = !list.hidden;
    };
    body.querySelectorAll('#wiz-region-list .region-btn').forEach((btn) => {
      btn.onclick = () => showResult(regionOf(btn.dataset.r), '목록에서 직접 선택');
    });
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
      btn.onclick = () => { a.regionId = btn.dataset.r; renderWiz(); };
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
  if (a.regionId) localStorage.setItem('farm.region', a.regionId);
  if (a.address) localStorage.setItem('farm.address', a.address);

  if (wiz.settingsOnly) {
    toast('재배지 설정을 저장했어요.');
    renderSettings();
    show('settings');
    return;
  }

  const ids = a.cropIds && a.cropIds.length ? a.cropIds : a.cropId ? [a.cropId] : [];
  if (ids.length) await plantSeeds(ids);
  await refreshStatus();
  activeCropId = ids[0] || null;
  renderHome();
  show('home');
}

// 새 작물 추가 시트 (+ 아이콘) — 시작 마법사처럼 질문식 2단계:
// ① 무엇을 심을까요? → ② 내 지역과 잘 맞는지 확인 → 심기
function openSeedOverlay() {
  const growing = new Set((status?.crops || []).map((c) => c.cropId));
  const available = selectableCrops.filter((c) => !growing.has(c.id));
  if (!available.length) { toast('이미 모든 작물을 키우고 있어요.'); return; }

  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.classList.remove('detail');

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
        <span class="wf-flag ${s.score >= 60 ? 'ok' : 'warn'}">${s.verdict}</span>
      </div>`;
    }).join('');
    panel.innerHTML = `
      <p class="eyebrow">새 씨앗 · 2/2</p>
      <h2 style="font-size:20px;font-weight:400;margin-bottom:4px">${region ? `${region.name} 기준 적합도예요` : '적합도 확인'}</h2>
      <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px">
        ${region ? '점수가 낮아도 심을 수는 있어요. 더 자주 돌봐주면 돼요.' : '설정에서 재배지를 등록하면 적합도를 확인할 수 있어요.'}
      </p>
      <div class="wiz-recos" style="margin-bottom:16px">${rows}</div>
      <button class="btn btn-primary btn-wide" id="overlay-plant">씨앗 심기 (${ids.length}개)</button>`;
    panel.querySelector('#overlay-plant').onclick = async () => {
      panel.querySelector('#overlay-plant').disabled = true;
      const planted = await plantSeeds(ids);
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

async function renderTodos() {
  const data = await api('/api/me/todos');
  renderTodoList(data.todos || []);
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

async function renderDiary() {
  const data = await api('/api/me/diary');
  const entries = [...(data.entries || [])].sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  const tKey = todayKey();
  const todayEntry = entries.find((e) => e.dayKey === tKey);

  const textarea = $('#diary-text');
  const saveBtn = $('#diary-save');
  if (document.activeElement !== textarea) {
    textarea.value = todayEntry ? todayEntry.text : '';
  }
  saveBtn.textContent = todayEntry ? '오늘 기록 고쳐 쓰기' : '오늘 기록 남기기';
  $('#diary-hint').textContent = todayEntry ? '비우고 저장하면 지워져요' : '하루에 한 편이면 충분해요';

  saveBtn.onclick = async () => {
    const text = textarea.value.trim();
    if (!text && !todayEntry) { toast('내용을 적어주세요.'); return; }
    saveBtn.disabled = true;
    const res = await api('/api/me/diary', { method: 'POST', body: JSON.stringify({ text }) });
    saveBtn.disabled = false;
    if (!res.ok) { toast(res.message || '저장하지 못했어요.'); return; }
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
        <div class="sc-value">${userName}</div>
      </div>
      <button class="link-btn" id="rename-btn">이름 바꾸기</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">재배지</div>
        <div class="sc-value" style="font-size:13.5px">
          ${myRegion() ? myRegion().name : '아직 설정 안 함'}
        </div>
      </div>
      <button class="link-btn" id="edit-region-btn">변경</button>
    </div>
    <div class="sc-row" style="margin-top:14px">
      <div>
        <div class="sc-label">교환소</div>
        <div class="sc-value" style="font-size:13.5px;color:var(--ink-soft)">모은 포인트로 비료 신청하기</div>
      </div>
      <button class="link-btn" id="open-rewards-settings">열기</button>
    </div>`;
  $('#edit-region-btn').onclick = () => startWizard({ settingsOnly: true });
  $('#open-rewards-settings').onclick = async () => {
    await renderRewards();
    show('rewards');
  };
  $('#rename-btn').onclick = () => {
    const next = prompt('새 이름을 입력해 주세요.\n(이름이 바뀌면 새 밭에서 다시 시작해요)', userName);
    if (!next || !next.trim() || next.trim() === userName) return;
    userName = next.trim();
    localStorage.setItem('farm.name', userName);
    location.reload();
  };
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
      if (v === 'records') { await refreshStatus(); renderRecords(); }
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

  // 교환소 → 대시보드 돌아가기
  $('#rewards-back').addEventListener('click', async () => {
    await refreshStatus();
    renderHome();
    show('home');
  });

  if (!userName) {
    startWizard(); // 이름부터 묻는 질문식 시작 마법사
    return;
  }
  await enter();
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
  } catch {
    toast('서버에 연결할 수 없어요. 터미널에서 npm start를 실행해 주세요.', 4000);
  }
}

// 앱 화면(index.html)에서만 부팅 — 미리보기 페이지 등이 이 모듈을
// import 해서 그림 함수만 쓸 수 있게 함
if (document.querySelector('#view-home')) boot();

// 다른 페이지(미리보기 등)에서 쓰는 그림 함수들
export { plantScene, cropPortrait, conditionScene };
