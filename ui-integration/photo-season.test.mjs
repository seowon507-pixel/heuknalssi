import assert from "node:assert/strict";
import test from "node:test";

import {
  presentPhotoComparison,
  presentPhotoRecord,
  presentSeasonSummary,
  renderPhotoSeasonPanel,
} from "./photo-season.mjs";

test("사진 표시는 촬영일과 등록일을 구분하고 비공개 Storage 경로를 노출하지 않는다", () => {
  const view = presentPhotoRecord({
    photoId: "photo-1",
    farmId: "farm-1",
    cropId: "crop-1",
    seasonId: "season-1",
    objectPath: "private/original.jpg",
    thumbnailPath: "private/thumb.jpg",
    observedAt: "2026-07-20T01:00:00.000Z",
    createdAt: "2026-07-22T03:00:00.000Z",
    growthStage: "착과기",
    note: "동쪽 줄",
    consentState: "GRANTED",
  });

  assert.equal(view.observedAtLabel, "촬영 2026. 7. 20.");
  assert.equal(view.createdAtLabel, "등록 2026. 7. 22.");
  assert.equal("objectPath" in view, false);
  assert.equal("thumbnailPath" in view, false);
});

test("사진이 없는 시즌은 사진 추가를 선택으로 안내하고 전체 기능을 HOLD하지 않는다", () => {
  const view = presentSeasonSummary({
    seasonId: "season-1",
    farmId: "farm-1",
    cropId: "crop-1",
    status: "COMPLETED",
    completedActionCount: 2,
    skippedActionCount: 1,
    actionTimeline: [],
    riskTimeline: [],
    photoTimeline: [],
    photoEvidence: { state: "UNAVAILABLE", blocksProduct: false },
    limitations: ["PHOTO_HISTORY_ABSENT"],
  });

  assert.equal(view.blocked, false);
  assert.equal(view.photoState, "사진 기록 없음");
  assert.match(view.photoGuidance, /선택/);
  assert.equal("limitations" in view, false);
  assert.deepEqual(view.limitationMessages, [
    "이 시즌에는 저장된 사진 기록이 없습니다.",
  ]);
  assert.doesNotMatch(JSON.stringify(view), /HOLD/);
});

test("비교 표시는 구조화된 관찰값의 고정 문구만 사용한다", () => {
  const view = presentPhotoComparison({
    comparisonId: "comparison-1",
    baselinePhotoId: "photo-1",
    currentPhotoId: "photo-2",
    baselineObservedAt: "2026-07-01T00:00:00.000Z",
    currentObservedAt: "2026-07-08T00:00:00.000Z",
    observableChanges: [
      {
        aspect: "COLOR",
        change: "MORE_YELLOW",
        label: "임의 해석 문구",
      },
      { aspect: "DIAGNOSIS", change: "BLIGHT", label: "병해 확정" },
    ],
  });

  assert.deepEqual(view.observableChanges, [
    {
      aspect: "COLOR",
      change: "MORE_YELLOW",
      label: "노란색으로 보이는 부분이 늘어남",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(view), /병해|진단|원인/u);
});

test("여러 농장과 작물의 사진·시즌 카드를 각 범위별로 렌더링한다", () => {
  const markup = renderPhotoSeasonPanel({
    scopes: [
      {
        farm: { farmId: "farm-1", name: "언덕 사과밭" },
        crop: { cropId: "crop-apple", name: "사과" },
        summary: {
          seasonId: "season-apple",
          farmId: "farm-1",
          cropId: "crop-apple",
          status: "ACTIVE",
          completedActionCount: 1,
          skippedActionCount: 0,
          actionTimeline: [],
          riskTimeline: [],
          photoTimeline: [],
          photoEvidence: { state: "UNAVAILABLE", blocksProduct: false },
          limitations: ["PHOTO_HISTORY_ABSENT"],
        },
      },
      {
        farm: { farmId: "farm-2", name: "강가 밭" },
        crop: { cropId: "crop-potato", name: "감자" },
        summary: {
          seasonId: "season-potato",
          farmId: "farm-2",
          cropId: "crop-potato",
          status: "ACTIVE",
          completedActionCount: 0,
          skippedActionCount: 0,
          actionTimeline: [],
          riskTimeline: [],
          photoTimeline: [],
          photoEvidence: { state: "UNAVAILABLE", blocksProduct: false },
          limitations: ["PHOTO_HISTORY_ABSENT"],
        },
      },
    ],
  });

  assert.match(markup, /data-farm-id="farm-1"/);
  assert.match(markup, /data-crop-id="crop-apple"/);
  assert.match(markup, /언덕 사과밭/);
  assert.match(markup, /data-farm-id="farm-2"/);
  assert.match(markup, /data-crop-id="crop-potato"/);
  assert.match(markup, /강가 밭/);
  assert.doesNotMatch(markup, /병해|진단|원인/u);
});

test("저장 동의된 사진은 명시적 확인이 필요한 삭제 동작을 표시한다", () => {
  const markup = renderPhotoSeasonPanel({
    scopes: [
      {
        farm: { farmId: "farm-1", name: "언덕 밭" },
        crop: { cropId: "crop-1", name: "사과" },
        summary: {
          seasonId: "season-1",
          farmId: "farm-1",
          cropId: "crop-1",
          status: "ACTIVE",
          completedActionCount: 0,
          skippedActionCount: 0,
          actionTimeline: [],
          riskTimeline: [],
          photoTimeline: [
            {
              photoId: "photo-1",
              farmId: "farm-1",
              cropId: "crop-1",
              seasonId: "season-1",
              observedAt: "2026-07-20T01:00:00.000Z",
              createdAt: "2026-07-22T03:00:00.000Z",
              growthStage: "착과기",
              note: null,
              consentState: "GRANTED",
            },
          ],
          photoEvidence: { state: "READY", blocksProduct: false },
          limitations: [],
        },
      },
    ],
  });

  assert.match(markup, /저장 동의됨/);
  assert.match(markup, /data-photo-delete="photo-1"/);
  assert.match(markup, /data-confirm-required="true"/);
});

test("렌더링 문자열은 사용자 메모를 이스케이프한다", () => {
  const markup = renderPhotoSeasonPanel({
    scopes: [
      {
        farm: { farmId: "farm-1", name: "<script>alert(1)</script>" },
        crop: { cropId: "crop-1", name: "사과" },
        summary: {
          seasonId: "season-1",
          farmId: "farm-1",
          cropId: "crop-1",
          status: "ACTIVE",
          completedActionCount: 0,
          skippedActionCount: 0,
          actionTimeline: [],
          riskTimeline: [],
          photoTimeline: [
            {
              photoId: "photo-1",
              farmId: "farm-1",
              cropId: "crop-1",
              seasonId: "season-1",
              observedAt: "2026-07-20T01:00:00.000Z",
              createdAt: "2026-07-22T03:00:00.000Z",
              growthStage: "착과기",
              note: '<img src=x onerror="alert(2)">',
              consentState: "GRANTED",
            },
          ],
          photoEvidence: { state: "READY", blocksProduct: false },
          limitations: [],
        },
      },
    ],
  });

  assert.doesNotMatch(markup, /<script>|<img/u);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
});
