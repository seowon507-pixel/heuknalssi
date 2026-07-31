import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_PHOTO_MAX_BYTES,
  analyzePhotoPixels,
  assertLocalPhotoFile,
  assessPhotoQuality,
  compareVisualSignals,
  reviewPhotoComparison,
} from "./local-photo-journal.mjs";

test("사진의 관찰 가능한 색 신호만 비교한다", () => {
  const result = compareVisualSignals(
    { brightness: 0.4, greenRatio: 0.32, yellowRatio: 0.12 },
    { brightness: 0.46, greenRatio: 0.22, yellowRatio: 0.2 },
  );
  assert.deepEqual(
    result.map(({ label, direction }) => [label, direction]),
    [
      ["평균 밝기", "INCREASED"],
      ["초록색 비율", "DECREASED"],
      ["노란색 비율", "INCREASED"],
    ],
  );
});

test("사진 신호가 없으면 비교 결과를 만들지 않는다", () => {
  assert.deepEqual(compareVisualSignals(null, { brightness: 0.3 }), []);
});

test("브라우저 픽셀에서 노출·선명도·선택 피사체 비율을 결정적으로 계산한다", () => {
  const pixels = checkerboardPixels(8, 8);
  const result = analyzePhotoPixels(
    { width: 8, height: 8, data: pixels },
    { subjectBounds: { x: 2, y: 1, width: 4, height: 6 } },
  );

  assert.equal(result.brightness, 0.5);
  assert.equal(result.subjectRatio, 0.375);
  assert.equal(result.subjectRatioSource, "USER_BOUNDS");
  assert.ok(result.sharpness > 0.1);
  assert.equal(result.shadowClipRatio, 0.5);
  assert.equal(result.highlightClipRatio, 0.5);
});

test("선택 영역이 없으면 어떤 색도 작물 객체 면적으로 추정하지 않는다", () => {
  for (const [scene, colors] of Object.entries({
    redApple: [[190, 35, 40], [105, 25, 30]],
    brownLeaf: [[145, 85, 50], [75, 40, 25]],
    potatoAndSoil: [[125, 90, 70], [70, 48, 38]],
    stemAndFruit: [[145, 45, 110], [75, 25, 55]],
  })) {
    const result = analyzePhotoPixels({
      width: 8,
      height: 8,
      data: coloredCheckerboardPixels(8, 8, colors),
    });
    assert.equal(result.subjectRatio, null, scene);
    assert.equal(result.subjectRatioSource, null, scene);
    assert.equal(
      assessPhotoQuality({ ...result, subjectConfirmed: true }).ready,
      true,
      scene,
    );
  }
});

test("출처 없는 과거 subjectRatio는 작물 객체 면적으로 신뢰하지 않는다", () => {
  const quality = assessPhotoQuality({
    ...completeSignals(),
    subjectRatio: 0.02,
    subjectRatioSource: null,
    subjectConfirmed: true,
  });

  assert.equal(quality.ready, true);
  assert.doesNotMatch(JSON.stringify(quality), /SUBJECT_TOO_SMALL/);
});

test("선택 영역이 없을 때는 색상 추정 대신 중앙 배치 사용자 확인을 요구한다", () => {
  const signals = analyzePhotoPixels({
    width: 8,
    height: 8,
    data: coloredCheckerboardPixels(8, 8, [[190, 35, 40], [105, 25, 30]]),
  });

  const withoutConfirmation = assessPhotoQuality(signals);
  assert.equal(withoutConfirmation.ready, false);
  assert.deepEqual(
    withoutConfirmation.issues.map(({ code }) => code),
    ["SUBJECT_CONFIRMATION_REQUIRED"],
  );
  assert.match(withoutConfirmation.message, /화면 중앙/);
});

test("로컬 사진은 이미지 형식과 10MB 크기 상한을 저장 전에 검증한다", () => {
  const allowed = new Blob([new Uint8Array(LOCAL_PHOTO_MAX_BYTES)], {
    type: "image/jpeg",
  });
  const oversized = new Blob([new Uint8Array(LOCAL_PHOTO_MAX_BYTES + 1)], {
    type: "image/jpeg",
  });

  assert.doesNotThrow(() => assertLocalPhotoFile(allowed));
  assert.throws(
    () => assertLocalPhotoFile(oversized),
    /10MB 이하/u,
  );
});

test("너무 어둡거나 흔들린 사진은 비교 전에 재촬영 문구를 제공한다", () => {
  const quality = assessPhotoQuality({
    brightness: 0.08,
    shadowClipRatio: 0.82,
    highlightClipRatio: 0,
    sharpness: 0.0002,
    subjectRatio: 0.42,
    subjectRatioSource: "USER_BOUNDS",
  });

  assert.equal(quality.ready, false);
  assert.deepEqual(
    quality.issues.map(({ code }) => code),
    ["TOO_DARK", "POSSIBLE_SHAKE"],
  );
  assert.match(quality.message, /밝은 곳|흔들/u);
  assert.doesNotMatch(JSON.stringify(quality), /병해|진단|원인/u);
});

test("피사체가 너무 작으면 화면을 더 채우도록 안내하고 비교값을 만들지 않는다", () => {
  const good = completeSignals({ brightness: 0.45, subjectRatio: 0.48 });
  const tooSmall = completeSignals({ brightness: 0.46, subjectRatio: 0.08 });
  const review = reviewPhotoComparison(good, tooSmall);

  assert.equal(review.ready, false);
  assert.deepEqual(review.changes, []);
  assert.deepEqual(
    review.issues.map(({ photo, code }) => [photo, code]),
    [["CURRENT", "SUBJECT_TOO_SMALL"]],
  );
  assert.match(review.message, /대상이 화면의 4분의 1 이상/);
});

test("두 사진 품질이 충분할 때만 기존의 관찰 가능한 색 비교를 반환한다", () => {
  const review = reviewPhotoComparison(
    completeSignals({ brightness: 0.4, greenRatio: 0.32, yellowRatio: 0.12 }),
    completeSignals({ brightness: 0.46, greenRatio: 0.22, yellowRatio: 0.2 }),
  );

  assert.equal(review.ready, true);
  assert.equal(review.issues.length, 0);
  assert.deepEqual(
    review.changes.map(({ label, direction }) => [label, direction]),
    [
      ["평균 밝기", "INCREASED"],
      ["초록색 비율", "DECREASED"],
      ["노란색 비율", "INCREASED"],
    ],
  );
});

function completeSignals(overrides = {}) {
  return {
    brightness: 0.45,
    greenRatio: 0.3,
    yellowRatio: 0.12,
    shadowClipRatio: 0.08,
    highlightClipRatio: 0.06,
    sharpness: 0.02,
    subjectRatio: 0.45,
    subjectRatioSource: "USER_BOUNDS",
    ...overrides,
  };
}

function checkerboardPixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = (x + y) % 2 === 0 ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

function coloredCheckerboardPixels(width, height, colors) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = colors[(x + y) % colors.length];
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  return data;
}
