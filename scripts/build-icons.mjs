// 홈 화면 아이콘을 만든다.
//
// 안드로이드는 maskable 아이콘의 바깥쪽을 잘라내고 자기 모양(원·둥근사각형)을
// 다시 씌운다. 원본처럼 모서리가 투명한 둥근 사각형을 그대로 maskable로 쓰면
// 초록 사각형의 모서리가 잘려 나가 아이콘이 깨져 보인다.
// iOS도 apple-touch-icon에 자기 모양을 씌우므로 투명한 모서리는 검게 나온다.
//
// 그래서 배경을 모서리까지 꽉 채운(full-bleed) 아이콘을 따로 만든다.
// 로고 자체는 원본 캔버스의 62%만 차지해 안전 영역(안쪽 80%) 안에 이미 들어온다.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodePng, encodePng } from "./png.mjs";

const iconsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "ui-integration", "icons");

// ── 합성 ─────────────────────────────────────────────────────────
// 투명한 모서리를 같은 초록으로 메워 모서리까지 꽉 찬 아이콘을 만든다.
function flattenOnto(source, background) {
  const out = Buffer.alloc(source.rgba.length);
  for (let i = 0; i < source.rgba.length; i += 4) {
    const alpha = source.rgba[i + 3] / 255;
    for (let ch = 0; ch < 3; ch += 1) {
      out[i + ch] = Math.round(source.rgba[i + ch] * alpha + background[ch] * (1 - alpha));
    }
    out[i + 3] = 255;
  }
  return { width: source.width, height: source.height, rgba: out };
}

function resize(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const ratio = image.width / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 원본에서 대응하는 사각형을 평균 내 계단 현상을 줄인다.
      const x0 = Math.floor(x * ratio);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * ratio));
      const y0 = Math.floor(y * ratio);
      const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * ratio));
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let sy = y0; sy < Math.min(y1, image.height); sy += 1) {
        for (let sx = x0; sx < Math.min(x1, image.width); sx += 1) {
          const i = (sy * image.width + sx) * 4;
          for (let ch = 0; ch < 4; ch += 1) sums[ch] += image.rgba[i + ch];
          count += 1;
        }
      }
      const o = (y * size + x) * 4;
      for (let ch = 0; ch < 4; ch += 1) out[o + ch] = Math.round(sums[ch] / count);
    }
  }
  return { width: size, height: size, rgba: out };
}

// ── 생성 ─────────────────────────────────────────────────────────
const source = decodePng(readFileSync(join(iconsDirectory, "icon-512.png")));
const MASKABLE_SCALE = 0.86;

// 배경색은 원본 왼쪽 가운데(도형 안쪽)에서 그대로 가져와 색이 어긋나지 않게 한다.
const probe = (Math.floor(source.height / 2) * source.width + 12) * 4;
const green = [source.rgba[probe], source.rgba[probe + 1], source.rgba[probe + 2]];
if (source.rgba[probe + 3] !== 255) throw new Error("배경색 표본이 투명하다");

const fullBleed = flattenOnto(source, green);

// 로고를 조금 줄여 안전 영역에 여유를 둔다. 런처마다 마스크 모양이 달라
// 딱 맞게 채우면 원형 마스크에서 획 끝이 스칠 수 있다.
function shrink(image, scale) {
  const inner = resize(image, Math.round(image.width * scale));
  const out = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = green[0];
    out[i + 1] = green[1];
    out[i + 2] = green[2];
    out[i + 3] = 255;
  }
  const offset = Math.round((image.width - inner.width) / 2);
  for (let y = 0; y < inner.height; y += 1) {
    inner.rgba.copy(
      out,
      ((y + offset) * image.width + offset) * 4,
      y * inner.width * 4,
      (y + 1) * inner.width * 4,
    );
  }
  return { width: image.width, height: image.height, rgba: out };
}

const maskable = shrink(fullBleed, MASKABLE_SCALE);
writeFileSync(join(iconsDirectory, "icon-maskable-512.png"), encodePng(maskable));
writeFileSync(join(iconsDirectory, "icon-fullbleed-512.png"), encodePng(fullBleed));
writeFileSync(join(iconsDirectory, "icon-fullbleed-192.png"), encodePng(resize(fullBleed, 192)));
writeFileSync(join(iconsDirectory, "icon-apple-180.png"), encodePng(resize(fullBleed, 180)));

const hex = `#${green.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
console.log(`아이콘 배경색 ${hex}`);
console.log("icon-maskable-512.png · icon-fullbleed-{512,192}.png · icon-apple-180.png 생성");

// 로고가 maskable 안전 영역(가운데 지름 80% 원) 안에 들어오는지 확인한다.
let minX = source.width;
let maxX = 0;
let minY = source.height;
let maxY = 0;
for (let y = 0; y < source.height; y += 1) {
  for (let x = 0; x < source.width; x += 1) {
    const i = (y * source.width + x) * 4;
    // 흰 로고 획만 골라낸다
    if (source.rgba[i + 3] > 128 && source.rgba[i] > 200 && source.rgba[i + 1] > 200) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const cx = source.width / 2;
const cy = source.height / 2;
const reach = MASKABLE_SCALE * Math.max(
  Math.hypot(minX - cx, minY - cy), Math.hypot(maxX - cx, minY - cy),
  Math.hypot(minX - cx, maxY - cy), Math.hypot(maxX - cx, maxY - cy),
);
const safeRadius = source.width * 0.4;
console.log(
  `로고 범위 x ${minX}~${maxX} · y ${minY}~${maxY} · maskable 중심에서 최대 ${Math.round(reach)}px ` +
  `/ 안전 반지름 ${safeRadius}px → ${reach <= safeRadius ? "안전 영역 안" : "❌ 안전 영역 밖"}`,
);
if (reach > safeRadius) throw new Error("로고가 maskable 안전 영역을 벗어난다");
