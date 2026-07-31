/**
 * 생육 사진 기록과 초록 피복률.
 *
 * 사진으로 진단하지 않는다. 잎 색을 보고 "질소가 부족합니다" 같은 말을
 * 만드는 순간, 검증되지 않은 것은 단정하지 않는다는 이 제품의 기준이
 * 무너진다. 사전점검이 `freeFormLlm: false`를 공개하고 있다.
 *
 * 대신 사진은 기록으로 두고, 비교는 자료가 한다.
 *   - 사진을 남길 때 그날의 적합도 점수·기상·완료한 일을 함께 적는다
 *   - 사진에서 뽑는 값은 초록 피복률 하나뿐이며 픽셀을 세서 구한다
 *
 * 초록 피복률은 ExG(Excess Green) 지표를 쓴다.
 *
 *   exg = 2·G − R − B        (각 채널을 0~1로 정규화한 값)
 *
 * 학습 모델이 아니라 정해진 산식이다. 같은 사진이면 언제나 같은 값이 나오고
 * 왜 그 값인지 설명할 수 있다. 다만 이것은 "화면에서 초록으로 보이는 면적의
 * 비율"이며 생육량·수확량이 아니다. 촬영 거리·각도·햇빛이 바뀌면 값도 바뀐다.
 * 그래서 같은 자리에서 같은 각도로 찍은 사진끼리만 비교하도록 안내한다.
 */

// 이 값을 넘는 픽셀을 초록으로 센다. 0이면 회색·흙까지 들어오고, 너무 높이면
// 그늘 속 잎이 빠진다. 농경지 사진에서 흙과 잎을 가르는 통상값을 쓴다.
const EXG_THRESHOLD = 0.05;
// 긴 변을 이 크기로 줄여서 센다. 원본을 다 훑으면 휴대폰에서 느리고,
// 비율만 필요하므로 축소해도 결과가 거의 같다.
const SAMPLE_MAX_EDGE = 320;

export function excessGreen({ red, green, blue }) {
  const total = red + green + blue;
  if (total === 0) return 0;
  // 밝기를 나눠 없앤다. 그늘과 햇빛에서 같은 잎이 다른 값이 되지 않게 한다.
  return (2 * green - red - blue) / total;
}

/**
 * 이미지에서 초록 피복률을 센다. 캔버스만 쓰고 외부 요청은 없다.
 * 사진은 화면 밖으로 나가지 않는다.
 */
export function measureGreenCover(imageData) {
  const { data, width, height } = imageData;
  let counted = 0;
  let green = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    // 투명 픽셀은 사진이 아니다. 분모에 넣으면 비율이 낮아진다.
    if (alpha < 250) continue;
    counted += 1;
    const value = excessGreen({
      red: data[index],
      green: data[index + 1],
      blue: data[index + 2],
    });
    if (value > EXG_THRESHOLD) green += 1;
  }
  if (counted === 0) {
    return { ratio: null, sampledPixels: 0, threshold: EXG_THRESHOLD };
  }
  return {
    ratio: Math.round((green / counted) * 1000) / 1000,
    sampledPixels: counted,
    threshold: EXG_THRESHOLD,
    sampledSize: { width, height },
  };
}

/** 파일을 축소해 픽셀을 읽는다. 브라우저에서만 동작한다. */
export async function readGreenCoverFromFile(file, { createBitmap, createCanvas } = {}) {
  const toBitmap = createBitmap ?? globalThis.createImageBitmap;
  if (typeof toBitmap !== "function") return null;
  let bitmap;
  try {
    bitmap = await toBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(
    1,
    SAMPLE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas =
    createCanvas?.(width, height) ??
    (typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height }));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return measureGreenCover(context.getImageData(0, 0, width, height));
}

/**
 * 사진과 함께 남길 그날의 상태. 사진에서 읽은 값과 자료에서 온 값을
 * 섞지 않고 나눠서 적는다.
 */
export function buildPhotoSnapshot({
  analysis,
  greenCover = null,
  now,
  completedToday = 0,
}) {
  const suitability = analysis?.suitability ?? null;
  const risks = analysis?.forecast?.result?.risks ?? [];
  return {
    takenAt: new Date(now).toISOString(),
    takenOn: new Date(now + 9 * 3_600_000).toISOString().slice(0, 10),
    crop: analysis?.inputSummary?.crop ?? null,
    regionLabel: analysis?.inputSummary?.regionLabel ?? null,
    // 자료에서 온 값
    suitabilityScore: suitability?.scored === true ? suitability.score : null,
    suitabilityGrade: suitability?.grade ?? null,
    riskCount: risks.length,
    completedTaskCount: completedToday,
    // 사진에서 픽셀을 세어 구한 값. 진단이 아니다.
    greenCover: greenCover?.ratio ?? null,
    greenCoverMethod: greenCover
      ? {
          index: "ExG = (2G − R − B) / (R + G + B)",
          threshold: greenCover.threshold,
          sampledPixels: greenCover.sampledPixels,
          note: "초록으로 보이는 면적의 비율입니다. 생육량이나 수확량이 아닙니다.",
        }
      : null,
  };
}

/**
 * 시즌 정리. 기록에 있는 것만 세고 추세를 단정하지 않는다.
 *
 * 점수가 내려갔다는 사실과 "악화됐다"는 판단은 다르다. 촬영 조건이
 * 바뀌었을 수도, 자료 출처가 바뀌었을 수도 있다. 그래서 변화량은 그대로
 * 보여 주고 원인은 쓰지 않는다.
 */
export function summarizeSeason(snapshots, { completions = [] } = {}) {
  const list = [...(snapshots ?? [])]
    .filter((item) => item?.takenOn)
    .sort((a, b) => a.takenOn.localeCompare(b.takenOn));
  if (list.length === 0) {
    return {
      state: "EMPTY",
      photoCount: 0,
      dayCount: 0,
      firstOn: null,
      lastOn: null,
      completedTaskCount: completions.length,
      suitability: null,
      greenCover: null,
    };
  }

  const scored = list.filter((item) => Number.isFinite(item.suitabilityScore));
  const covered = list.filter((item) => Number.isFinite(item.greenCover));
  return {
    // 두 장 미만이면 비교할 대상이 없다. 그 사실을 상태로 남긴다.
    state: list.length < 2 ? "SINGLE_RECORD" : "READY",
    photoCount: list.length,
    dayCount: new Set(list.map((item) => item.takenOn)).size,
    firstOn: list[0].takenOn,
    lastOn: list.at(-1).takenOn,
    crop: list.at(-1).crop ?? null,
    regionLabel: list.at(-1).regionLabel ?? null,
    completedTaskCount: completions.length,
    totalRiskEvents: list.reduce(
      (sum, item) => sum + (Number.isFinite(item.riskCount) ? item.riskCount : 0),
      0,
    ),
    suitability: change(scored, "suitabilityScore"),
    greenCover: change(covered, "greenCover"),
  };
}

function change(list, field) {
  if (list.length === 0) return null;
  const first = list[0][field];
  const last = list.at(-1)[field];
  return {
    sampleCount: list.length,
    first,
    last,
    // 두 장 미만이면 변화가 없는 것이 아니라 알 수 없는 것이다.
    delta: list.length < 2 ? null : Math.round((last - first) * 1000) / 1000,
    min: Math.min(...list.map((item) => item[field])),
    max: Math.max(...list.map((item) => item[field])),
  };
}

export const growthPhotoDefaults = Object.freeze({
  exgThreshold: EXG_THRESHOLD,
  sampleMaxEdge: SAMPLE_MAX_EDGE,
});
