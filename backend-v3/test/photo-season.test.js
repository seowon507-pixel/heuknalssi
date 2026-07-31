import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeasonSummary,
  createObservablePhotoComparison,
  createPhotoMetadata,
} from "../src/domain/photo-season.js";
import {
  PHOTO_SEASON_PORT_METHODS,
  createPhotoSeasonService,
} from "../src/application/photo-season.js";

const SCOPE = {
  farmId: "farm-1",
  cropId: "crop-apple-1",
  seasonId: "season-2026-1",
};

const PHOTO_A = {
  photoId: "photo-a",
  ...SCOPE,
  objectPath: "private/farm-1/photo-a/original.jpg",
  thumbnailPath: "private/farm-1/photo-a/thumbnail.jpg",
  observedAt: "2026-06-01T01:00:00.000Z",
  growthStage: "착과기",
  note: "동쪽 줄 첫 번째 나무",
  consentState: "GRANTED",
  createdAt: "2026-06-01T03:00:00.000Z",
  deletedAt: null,
};

const PHOTO_B = {
  ...PHOTO_A,
  photoId: "photo-b",
  objectPath: "private/farm-1/photo-b/original.jpg",
  thumbnailPath: null,
  observedAt: "2026-06-08T01:00:00.000Z",
  createdAt: "2026-06-08T04:00:00.000Z",
};

test("사진 메타데이터는 촬영 시각과 수신 시각을 분리하고 비교 결과를 포함하지 않는다", () => {
  const metadata = createPhotoMetadata(PHOTO_A);

  assert.equal(metadata.observedAt, "2026-06-01T01:00:00.000Z");
  assert.equal(metadata.createdAt, "2026-06-01T03:00:00.000Z");
  assert.equal(metadata.objectPath, PHOTO_A.objectPath);
  assert.equal("comparison" in metadata, false);
  assert.equal("analysis" in metadata, false);

  assert.throws(
    () => createPhotoMetadata({ ...PHOTO_A, consentState: "DECLINED" }),
    (error) => error?.code === "PHOTO_CONSENT_REQUIRED",
  );
});

test("과거 사진 비교는 같은 농장·작물·시즌의 관찰 가능한 변화만 허용한다", () => {
  const comparison = createObservablePhotoComparison({
    comparisonId: "comparison-1",
    baselinePhoto: PHOTO_A,
    currentPhoto: PHOTO_B,
    observations: [
      { aspect: "COLOR", change: "MORE_YELLOW" },
      { aspect: "AREA", change: "INCREASED" },
      { aspect: "SHAPE", change: "MORE_CURLED" },
    ],
    createdAt: "2026-06-08T04:05:00.000Z",
  });

  assert.deepEqual(comparison.scope, SCOPE);
  assert.equal(comparison.baselineObservedAt, PHOTO_A.observedAt);
  assert.equal(comparison.currentObservedAt, PHOTO_B.observedAt);
  assert.deepEqual(
    comparison.observableChanges.map(({ aspect, change }) => ({ aspect, change })),
    [
      { aspect: "COLOR", change: "MORE_YELLOW" },
      { aspect: "AREA", change: "INCREASED" },
      { aspect: "SHAPE", change: "MORE_CURLED" },
    ],
  );
  assert.ok(
    comparison.evidenceRefs.every(({ spatialLevel }) => spatialLevel === "FIELD"),
  );
  assert.doesNotMatch(JSON.stringify(comparison), /병|진단|원인/u);

  assert.throws(
    () =>
      createObservablePhotoComparison({
        comparisonId: "comparison-cross-crop",
        baselinePhoto: PHOTO_A,
        currentPhoto: { ...PHOTO_B, cropId: "crop-pear-1" },
        observations: [{ aspect: "COLOR", change: "DARKER" }],
        createdAt: "2026-06-08T04:05:00.000Z",
      }),
    (error) => error?.code === "PHOTO_SCOPE_MISMATCH",
  );
  assert.throws(
    () =>
      createObservablePhotoComparison({
        comparisonId: "comparison-diagnosis",
        baselinePhoto: PHOTO_A,
        currentPhoto: PHOTO_B,
        observations: [{ aspect: "DIAGNOSIS", change: "BLIGHT" }],
        createdAt: "2026-06-08T04:05:00.000Z",
      }),
    (error) => error?.code === "UNOBSERVABLE_PHOTO_CHANGE",
  );
});

test("시즌 회고는 저장된 같은 범위 사건만 투영하고 사진 부재는 제품을 차단하지 않는다", () => {
  const season = {
    ...SCOPE,
    startedAt: "2026-03-01T00:00:00.000Z",
    endedAt: null,
    status: "ACTIVE",
    estimatedYieldKg: 9_999,
  };
  const summary = buildSeasonSummary({
    season,
    actions: [
      {
        actionId: "action-1",
        ...SCOPE,
        title: "배수로 확인",
        status: "DONE",
        completedAt: "2026-06-10T01:00:00.000Z",
        createdAt: "2026-06-09T01:00:00.000Z",
        modelSuggestion: "저장되지 않은 추정",
      },
      {
        actionId: "action-2",
        ...SCOPE,
        title: "잎 뒷면 살피기",
        status: "SKIPPED",
        completedAt: null,
        createdAt: "2026-06-11T01:00:00.000Z",
      },
    ],
    risks: [
      {
        riskId: "risk-1",
        ...SCOPE,
        title: "강풍 주의",
        state: "READY",
        observedAt: "2026-06-09T00:00:00.000Z",
        createdAt: "2026-06-08T22:00:00.000Z",
        diagnosis: "저장되지 않은 확정",
      },
    ],
    photos: [],
    comparisons: [
      createObservablePhotoComparison({
        comparisonId: "comparison-without-photo",
        baselinePhoto: PHOTO_A,
        currentPhoto: PHOTO_B,
        observations: [{ aspect: "AREA", change: "INCREASED" }],
        createdAt: "2026-06-08T04:05:00.000Z",
      }),
    ],
    endedAt: "2026-07-30T00:00:00.000Z",
    generatedAt: "2026-07-30T00:00:01.000Z",
  });

  assert.equal(summary.completedActionCount, 1);
  assert.equal(summary.skippedActionCount, 1);
  assert.equal(summary.photoEvidence.state, "UNAVAILABLE");
  assert.equal(summary.photoEvidence.blocksProduct, false);
  assert.equal(summary.state, "READY");
  assert.deepEqual(summary.limitations, ["PHOTO_HISTORY_ABSENT"]);
  assert.equal("estimatedYieldKg" in summary, false);
  assert.equal("modelSuggestion" in summary.actionTimeline[0], false);
  assert.equal("diagnosis" in summary.riskTimeline[0], false);
});

test("동의를 철회했거나 삭제된 사진은 시즌 회고에 다시 노출하지 않는다", () => {
  const summary = buildSeasonSummary({
    season: {
      ...SCOPE,
      startedAt: "2026-03-01T00:00:00.000Z",
      status: "ACTIVE",
    },
    actions: [],
    risks: [],
    photos: [
      { ...PHOTO_A, consentState: "WITHDRAWN" },
      { ...PHOTO_B, deletedAt: "2026-07-01T00:00:00.000Z" },
    ],
    comparisons: [],
    generatedAt: "2026-07-30T00:00:01.000Z",
  });

  assert.deepEqual(summary.photoTimeline, []);
  assert.deepEqual(summary.comparisonTimeline, []);
  assert.equal(summary.photoEvidence.state, "UNAVAILABLE");
  assert.equal(summary.photoEvidence.blocksProduct, false);
});

test("시즌 회고는 다른 농장이나 작물의 저장 사건을 섞지 않는다", () => {
  assert.throws(
    () =>
      buildSeasonSummary({
        season: {
          ...SCOPE,
          startedAt: "2026-03-01T00:00:00.000Z",
          status: "ACTIVE",
        },
        actions: [
          {
            actionId: "wrong-farm-action",
            ...SCOPE,
            farmId: "farm-2",
            title: "다른 농장 행동",
            status: "DONE",
            completedAt: "2026-06-10T01:00:00.000Z",
            createdAt: "2026-06-09T01:00:00.000Z",
          },
        ],
        risks: [],
        photos: [],
        comparisons: [],
        endedAt: "2026-07-30T00:00:00.000Z",
        generatedAt: "2026-07-30T00:00:01.000Z",
      }),
    (error) => error?.code === "SEASON_EVENT_SCOPE_MISMATCH",
  );
});

test("응용 서비스는 업로드 토큰을 비공개 경로로 확정하고 브라우저 응답에서 경로를 숨긴다", async () => {
  const harness = serviceHarness();

  const result = await harness.service.addPhoto({
    ...SCOPE,
    observedAt: PHOTO_A.observedAt,
    growthStage: PHOTO_A.growthStage,
    note: PHOTO_A.note,
    consentState: "GRANTED",
    uploadToken: "opaque-upload-token",
  });

  assert.deepEqual(harness.calls.commitUpload[0], {
    uploadToken: "opaque-upload-token",
    photoId: "photo-generated",
    ...SCOPE,
  });
  assert.equal(harness.calls.insertPhoto[0].objectPath, PHOTO_A.objectPath);
  assert.equal(result.observedAt, PHOTO_A.observedAt);
  assert.equal(result.createdAt, "2026-07-30T02:00:00.000Z");
  assert.equal("objectPath" in result, false);
  assert.equal("thumbnailPath" in result, false);
});

test("Storage가 유효하지 않은 경로를 반환하면 남은 객체를 정리하고 메타데이터를 저장하지 않는다", async () => {
  const harness = serviceHarness();
  harness.storedUpload = {
    objectPath: "",
    thumbnailPath: PHOTO_A.thumbnailPath,
  };

  await assert.rejects(
    () =>
      harness.service.addPhoto({
        ...SCOPE,
        observedAt: PHOTO_A.observedAt,
        growthStage: PHOTO_A.growthStage,
        note: PHOTO_A.note,
        consentState: "GRANTED",
        uploadToken: "opaque-upload-token",
      }),
    (error) => error?.code === "PHOTO_OBJECT_PATH_REQUIRED",
  );

  assert.deepEqual(harness.calls.deleteObjects[0], {
    objectPaths: [PHOTO_A.thumbnailPath],
  });
  assert.equal(harness.calls.insertPhoto.length, 0);
});

test("응용 서비스는 사진 메타데이터와 관찰 비교를 별도 레코드로 저장한다", async () => {
  const harness = serviceHarness();

  const result = await harness.service.comparePhotos({
    ...SCOPE,
    baselinePhotoId: PHOTO_A.photoId,
    currentPhotoId: PHOTO_B.photoId,
    observations: [{ aspect: "COLOR", change: "DARKER" }],
  });

  assert.equal(harness.calls.insertComparison.length, 1);
  assert.deepEqual(result.observableChanges, [
    { aspect: "COLOR", change: "DARKER", label: "색이 더 어둡게 보임" },
  ]);
  assert.equal("objectPath" in result, false);
  assert.equal(harness.calls.insertPhoto.length, 0);
});

test("삭제는 명시적 확인 뒤 원본 객체와 메타데이터 묶음을 모두 삭제한다", async () => {
  const harness = serviceHarness();

  await assert.rejects(
    () =>
      harness.service.deletePhoto({
        farmId: SCOPE.farmId,
        photoId: PHOTO_A.photoId,
        confirmed: false,
      }),
    (error) => error?.code === "PHOTO_DELETE_CONFIRMATION_REQUIRED",
  );
  assert.equal(harness.calls.deleteObjects.length, 0);
  assert.equal(harness.calls.deletePhotoBundle.length, 0);

  const result = await harness.service.deletePhoto({
    farmId: SCOPE.farmId,
    photoId: PHOTO_A.photoId,
    confirmed: true,
  });

  assert.deepEqual(harness.calls.deleteObjects[0], {
    objectPaths: [PHOTO_A.objectPath, PHOTO_A.thumbnailPath],
  });
  assert.deepEqual(harness.calls.deletePhotoBundle[0], {
    farmId: SCOPE.farmId,
    photoId: PHOTO_A.photoId,
    deletedAt: "2026-07-30T02:00:00.000Z",
  });
  assert.deepEqual(result, {
    photoId: PHOTO_A.photoId,
    deletedAt: "2026-07-30T02:00:00.000Z",
  });
});

test("Storage 삭제 실패 시 사진 메타데이터와 비교 묶음을 먼저 삭제하지 않는다", async () => {
  const harness = serviceHarness();
  harness.failDeleteObjects = true;

  await assert.rejects(
    () =>
      harness.service.deletePhoto({
        farmId: SCOPE.farmId,
        photoId: PHOTO_A.photoId,
        confirmed: true,
      }),
    /storage delete failed/,
  );

  assert.equal(harness.calls.deletePhotoBundle.length, 0);
});

test("시즌 완료는 범위별 저장소만 조회하고 생성한 회고를 함께 저장한다", async () => {
  const harness = serviceHarness();
  harness.rows.actions.push({
    actionId: "action-1",
    ...SCOPE,
    title: "배수로 확인",
    status: "DONE",
    completedAt: "2026-06-10T01:00:00.000Z",
    createdAt: "2026-06-09T01:00:00.000Z",
  });
  harness.rows.photos.push(PHOTO_A);

  const result = await harness.service.completeSeason({
    ...SCOPE,
    confirmed: true,
  });

  assert.equal(result.completedActionCount, 1);
  assert.equal(result.photoTimeline.length, 1);
  assert.equal("objectPath" in result.photoTimeline[0], false);
  for (const call of harness.calls.listBySeason) {
    assert.deepEqual(call, SCOPE);
  }
  assert.equal(harness.calls.completeSeason.length, 1);
  assert.deepEqual(harness.calls.completeSeason[0].scope, SCOPE);
  assert.equal(harness.calls.completeSeason[0].summary.seasonId, SCOPE.seasonId);
});

test("필수 저장소·Storage 포트 계약을 시작 시 검증한다", () => {
  assert.deepEqual(PHOTO_SEASON_PORT_METHODS, {
    photoRepository: [
      "insertPhoto",
      "findPhoto",
      "insertComparison",
      "listPhotosBySeason",
      "listComparisonsBySeason",
      "deletePhotoBundle",
    ],
    seasonRepository: ["findSeason", "completeSeason"],
    actionRepository: ["listActionsBySeason"],
    riskRepository: ["listRisksBySeason"],
    objectStorage: ["commitUpload", "deleteObjects"],
  });

  assert.throws(
    () => createPhotoSeasonService({}),
    (error) => error?.code === "PHOTO_SEASON_PORT_INVALID",
  );
});

function serviceHarness() {
  const calls = {
    commitUpload: [],
    insertPhoto: [],
    deleteObjects: [],
    deletePhotoBundle: [],
    insertComparison: [],
    listBySeason: [],
    completeSeason: [],
  };
  const rows = {
    actions: [],
    risks: [],
    photos: [],
    comparisons: [],
  };
  const photoRepository = {
    async insertPhoto(photo) {
      calls.insertPhoto.push(photo);
    },
    async findPhoto({ farmId, photoId }) {
      if (farmId === PHOTO_A.farmId && photoId === PHOTO_A.photoId) {
        return PHOTO_A;
      }
      if (farmId === PHOTO_B.farmId && photoId === PHOTO_B.photoId) {
        return PHOTO_B;
      }
      return null;
    },
    async insertComparison(comparison) {
      calls.insertComparison.push(comparison);
    },
    async listPhotosBySeason(scope) {
      calls.listBySeason.push(scope);
      return rows.photos;
    },
    async listComparisonsBySeason(scope) {
      calls.listBySeason.push(scope);
      return rows.comparisons;
    },
    async deletePhotoBundle(input) {
      calls.deletePhotoBundle.push(input);
    },
  };
  const seasonRepository = {
    async findSeason(scope) {
      return {
        ...scope,
        startedAt: "2026-03-01T00:00:00.000Z",
        endedAt: null,
        status: "ACTIVE",
      };
    },
    async completeSeason(input) {
      calls.completeSeason.push(input);
    },
  };
  const actionRepository = {
    async listActionsBySeason(scope) {
      calls.listBySeason.push(scope);
      return rows.actions;
    },
  };
  const riskRepository = {
    async listRisksBySeason(scope) {
      calls.listBySeason.push(scope);
      return rows.risks;
    },
  };
  const objectStorage = {
    async commitUpload(input) {
      calls.commitUpload.push(input);
      return harness.storedUpload;
    },
    async deleteObjects(input) {
      calls.deleteObjects.push(input);
      if (harness.failDeleteObjects) {
        throw new Error("storage delete failed");
      }
    },
  };

  const harness = {
    calls,
    rows,
    failDeleteObjects: false,
    storedUpload: {
      objectPath: PHOTO_A.objectPath,
      thumbnailPath: PHOTO_A.thumbnailPath,
    },
    service: createPhotoSeasonService({
      photoRepository,
      seasonRepository,
      actionRepository,
      riskRepository,
      objectStorage,
      clock: { now: () => new Date("2026-07-30T02:00:00.000Z") },
      idGenerator: (kind) =>
        kind === "photo" ? "photo-generated" : "comparison-generated",
    }),
  };
  return harness;
}
