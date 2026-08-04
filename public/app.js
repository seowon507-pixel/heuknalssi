// app.js — 청년농부 프론트엔드
// 그림은 전부 아래 "일러스트 라이브러리"에서 코드로 그립니다.
// (외부 이미지 없음 → 어떤 화면에서도 스타일이 어긋나지 않음)

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
  pear:     { leaf: '#93af72', deep: '#6d884d', light: '#b3c692', fruit: '#c5b768', fruitDeep: '#9a8d43', trunk: '#8a6b4d', trunkDeep: '#6b5138', blossom: '#f8f3e3' },
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

// 얼굴: 점 눈 + 작은 미소 + 발그레
function face(x, y, s = 1) {
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

function cloudArt(x, y, s = 1) {
  return `<g transform="translate(${x} ${y}) scale(${s})" opacity=".9">
    <path d="M-20 8 q-8 0 -8 -7 q0 -8 8 -8 q2 -8 11 -8 q8 0 11 6 q9 -1 11 6 q2 8 -6 11 Z"
      fill="#eef0e6" stroke="#a9b0a0" stroke-width="1.6" stroke-linejoin="round"/>
    <g stroke="#90a9ba" stroke-width="1.6" stroke-linecap="round" opacity=".8">
      <line x1="-12" y1="16" x2="-14" y2="22"/>
      <line x1="0" y1="18" x2="-2" y2="24"/>
      <line x1="12" y1="16" x2="10" y2="22"/>
    </g>
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

function seedArt(cropId) {
  const c = CP[cropId];
  let seed;
  if (cropId === 'potato') {
    seed = `<path d="M118 214 q-6 8 -1 14 q6 7 16 4 q9 -3 8 -11 q-1 -9 -11 -11 q-8 -1 -12 4 Z"
      fill="${c.tuber}" stroke="${c.tuberDeep}" stroke-width="2"/>
      <circle cx="124" cy="220" r="1.4" fill="${c.tuberDeep}"/>
      <circle cx="133" cy="224" r="1.4" fill="${c.tuberDeep}"/>
      ${stem('M136 214 q3 -5 1 -8', c.deep, 2)}`;
  } else if (cropId === 'apple' || cropId === 'pear') {
    seed = `<path d="M130 210 C137 216 136 226 130 229 C124 226 123 216 130 210 Z"
      fill="#6b5138" stroke="#503b27" stroke-width="2"/>`;
  } else {
    const fill = cropId === 'cucumber' ? '#e3d9b4' : '#7c6347';
    const line = cropId === 'cucumber' ? '#a99a6d' : '#503b27';
    seed = `<ellipse cx="130" cy="219" rx="7" ry="11" fill="${fill}" stroke="${line}"
      stroke-width="2" transform="rotate(14 130 219)"/>`;
  }
  return `
    <ellipse cx="130" cy="229" rx="17" ry="5.5" fill="#5f4c36" opacity=".3"/>
    ${seed}
    ${sparkle(100, 198, 0.9)}
    ${sparkle(163, 190, 0.75)}`;
}

function sproutArt(cropId) {
  const c = CP[cropId];
  return `
    ${stem('M130 228 q -2 -12 1 -24', c.deep)}
    ${leaf(131, 203, 27, 9.5, -152, c.leaf, c.deep)}
    ${leaf(131, 203, 27, 9.5, -28, c.leaf, c.deep)}
    <circle cx="131" cy="201" r="3" fill="${c.light}" stroke="${c.deep}" stroke-width="1.6"/>`;
}

function seedlingArt(cropId) {
  const c = CP[cropId];
  return `
    ${stem('M130 228 q -3 -18 0 -40', c.deep)}
    ${leaf(130, 213, 31, 11, -158, c.leaf, c.deep)}
    ${leaf(130, 213, 31, 11, -22, c.leaf, c.deep)}
    ${leaf(130, 197, 25, 9, -128, c.leaf, c.deep)}
    ${leaf(130, 197, 25, 9, -52, c.leaf, c.deep)}
    ${leaf(130, 188, 19, 7.5, -90, c.light, c.deep)}
    ${dew(154, 206, 0.9)}`;
}

// 상추: 잎이 부챗살로 모이는 로제트
function rosetteArt(big) {
  const c = CP.lettuce;
  const L = big ? 55 : 44, w = big ? 19 : 15;
  const outer = [-162, -126, -90, -54, -18]
    .map((a) => leaf(130, 227, L, w, a, c.leaf, c.deep)).join('');
  const inner = [-138, -90, -42]
    .map((a) => leaf(130, 227, L * 0.68, w * 0.78, a, c.light, c.deep)).join('');
  const head = big
    ? `<circle cx="130" cy="197" r="19" fill="${c.light}" stroke="${c.deep}" stroke-width="2"/>
       <path d="M117 190 q6 -7 13 -7 q7 0 13 7" fill="none" stroke="${c.deep}" stroke-width="1.4" opacity=".5"/>
       ${face(130, 198, 1)}`
    : '';
  return outer + inner + head + (big ? sparkle(172, 168, 0.9) : '');
}

// 감자: 덤불 (mature면 흙 위로 감자 두 알)
function potatoBushArt(mature) {
  const c = CP.potato;
  const s = mature ? 1.15 : 1;
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
        ${face(157, 233, 0.82)}
      </g>`
    : '';
  return stems + leaves + flowers + tubers;
}

// 오이: 덩굴+꽃 (flower 단계) / 듬직한 오이 (mature)
function cucumberFlowerArt() {
  const c = CP.cucumber;
  return `
    ${stem('M130 228 C 126 202 140 186 134 164', c.deep)}
    ${leaf(128, 202, 40, 15, -162, c.leaf, c.deep)}
    ${leaf(133, 184, 29, 11, -26, c.leaf, c.deep)}
    ${stem('M134 172 q 15 -4 14 -14 q -1 -9 -9 -7 q -7 2 -4 8', c.deep, 1.8)}
    <ellipse cx="121" cy="170" rx="3.4" ry="5" fill="#dcbc5f" stroke="#b3903a" stroke-width="1.3" transform="rotate(-24 121 170)"/>
    ${flower5(134, 158, 9.5, '#e8ce74', '#b3903a')}
    ${dew(106, 190, 0.9)}`;
}

function cucumberMatureArt() {
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
      ${face(129, 172, 1.05)}
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

function appleFruit(x, y, c) {
  return `<g>
    <circle cx="${x}" cy="${y}" r="7" fill="${c.fruit}" stroke="${c.fruitDeep}" stroke-width="1.8"/>
    <line x1="${x}" y1="${y - 7}" x2="${x}" y2="${y - 10}" stroke="${c.trunkDeep}" stroke-width="1.6" stroke-linecap="round"/>
  </g>`;
}

function pearFruit(x, y, c) {
  return `<g transform="translate(${x} ${y})">
    <path d="M0,-10 C3,-10 2.5,-5 5,-2 C8.5,2 6.5,8.5 0,8.5 C-6.5,8.5 -8.5,2 -5,-2 C-2.5,-5 -3,-10 0,-10 Z"
      fill="${c.fruit}" stroke="${c.fruitDeep}" stroke-width="1.8"/>
    <line x1="0" y1="-10" x2="0" y2="-13" stroke="${c.trunkDeep}" stroke-width="1.6" stroke-linecap="round"/>
  </g>`;
}

function treeArt(cropId, stageKey) {
  const c = CP[cropId];
  if (stageKey === 'sapling') {
    return `
      ${stem('M130 228 q -2 -16 1 -32', c.trunk, 4.5)}
      ${stem('M130 212 q -8 -4 -12 -10', c.trunk, 3)}
      ${leaf(118, 202, 17, 7, -145, c.leaf, c.deep)}
      ${leaf(131, 196, 18, 7.5, -80, c.light, c.deep)}
      ${leaf(131, 199, 17, 7, -25, c.leaf, c.deep)}`;
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
  if (stageKey === 'blossom') {
    deco = `${flower5(112, 174, 6, c.blossom, '#dcbc5f')}
      ${flower5(147, 170, 6, c.blossom, '#dcbc5f')}
      ${flower5(130, 158, 6.5, c.blossom, '#dcbc5f')}
      ${flower5(140, 184, 5.5, c.blossom, '#dcbc5f')}`;
  } else if (stageKey === 'fruit' || mature) {
    const F = cropId === 'apple' ? appleFruit : pearFruit;
    deco = mature
      ? `${F(110, 172, c)}${F(150, 168, c)}${F(130, 188, c)}
         ${flower5(142, 150, 5.5, c.blossom, '#dcbc5f')}
         ${face(130, 152, 0.9)}
         ${sparkle(172, 148, 0.9)}`
      : `${F(114, 176, c)}${F(146, 172, c)}`;
  }
  return trunk + canopy + deco;
}

// 작물+단계 → 그림 조각
function plantArt(cropId, stageKey) {
  if (stageKey === 'seed') return seedArt(cropId);
  if (stageKey === 'sprout') return sproutArt(cropId);
  if (stageKey === 'seedling') return seedlingArt(cropId);
  switch (cropId) {
    case 'lettuce':  return rosetteArt(stageKey === 'mature');
    case 'potato':   return potatoBushArt(stageKey === 'mature');
    case 'cucumber': return stageKey === 'mature' ? cucumberMatureArt() : cucumberFlowerArt();
    case 'apple':
    case 'pear':     return treeArt(cropId, stageKey);
  }
  return sproutArt(cropId);
}

let uid = 0;
// 단계가 오를수록 화면을 채우도록 그림 배율을 키움 (기준점: 지면 (130,227))
const STAGE_SCALE = {
  seed: 1, sprout: 1.15, seedling: 1.22, sapling: 1.24,
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
const views = ['hello', 'select', 'home', 'todos', 'rewards', 'records', 'settings'];
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
  growing: '성장', flower: '꽃', blossom: '꽃', fruit: '열매', mature: '수확',
};

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
        <span class="step-label">${STEP_LABELS[s.key] || s.name}</span>
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
    btn.onclick = () => toast('상세 보기는 준비 중이에요.');
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
  const growing = new Set((status?.crops || []).map((c) => c.cropId));
  const available = selectableCrops.filter((c) => !growing.has(c.id));
  if (!available.length) { toast('이미 모든 작물을 키우고 있어요.'); return; }

  const overlay = $('#overlay');
  const panel = $('#overlay-panel');
  panel.innerHTML = `
    <p class="eyebrow">새 씨앗</p>
    <h2 style="font-size:20px;font-weight:400;margin-bottom:4px">무엇을 더 키워볼까요?</h2>
    <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px">심은 작물은 상단 아이콘으로 오가며 볼 수 있어요.</p>
    <div class="crop-grid">${cropCardsHTML(available)}</div>
    <button class="btn btn-primary btn-wide" id="overlay-confirm" disabled>씨앗 심기</button>`;
  overlay.hidden = false;
  const confirm = panel.querySelector('#overlay-confirm');
  const picked = bindCropToggle(panel, confirm, '씨앗 심기');
  confirm.onclick = async () => {
    if (!picked.size) return;
    confirm.disabled = true;
    const planted = await plantSeeds([...picked]);
    overlay.hidden = true;
    if (planted > 0) {
      await refreshStatus();
      activeCropId = [...picked][0];
      renderHome();
      popVignette();
    }
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
        <div class="sc-label">교환소</div>
        <div class="sc-value" style="font-size:13.5px;color:var(--ink-soft)">모은 포인트로 비료 신청하기</div>
      </div>
      <button class="link-btn" id="open-rewards-settings">열기</button>
    </div>`;
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
    $('#hello-art').innerHTML = plantScene('cucumber', 'sprout', 'none');
    show('hello', { tabbar: false });
    $('#hello-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#hello-name').value.trim();
      if (!name) { toast('이름을 입력해 주세요.'); return; }
      userName = name;
      localStorage.setItem('farm.name', name);
      await enter();
    });
    return;
  }
  await enter();
}

async function enter() {
  try {
    const ob = await api('/api/me/onboarding');
    selectableCrops = ob.characters || [];
    if (ob.isFirstTime) {
      renderSelectView();
      show('select', { tabbar: false });
      return;
    }
    await refreshStatus();
    renderHome();
    show('home');
  } catch {
    toast('서버에 연결할 수 없어요. 터미널에서 npm start를 실행해 주세요.', 4000);
  }
}

boot();
