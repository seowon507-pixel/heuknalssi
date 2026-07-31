import { domainAssert } from "./errors.js";

const PHOTO_CONSENT_STATES = new Set(["GRANTED", "DECLINED", "WITHDRAWN"]);
const PHOTO_CHANGE_VALUES = Object.freeze({
  COLOR: new Set([
    "LIGHTER",
    "DARKER",
    "MORE_YELLOW",
    "LESS_YELLOW",
    "NO_VISIBLE_CHANGE",
  ]),
  AREA: new Set(["INCREASED", "DECREASED", "NO_VISIBLE_CHANGE"]),
  SHAPE: new Set([
    "MORE_CURLED",
    "LESS_CURLED",
    "MORE_IRREGULAR",
    "LESS_IRREGULAR",
    "NO_VISIBLE_CHANGE",
  ]),
});

const CHANGE_LABELS = Object.freeze({
  LIGHTER: "색이 더 밝게 보임",
  DARKER: "색이 더 어둡게 보임",
  MORE_YELLOW: "노란색으로 보이는 부분이 늘어남",
  LESS_YELLOW: "노란색으로 보이는 부분이 줄어듦",
  INCREASED: "보이는 면적이 늘어남",
  DECREASED: "보이는 면적이 줄어듦",
  MORE_CURLED: "말려 보이는 형태가 늘어남",
  LESS_CURLED: "말려 보이는 형태가 줄어듦",
  MORE_IRREGULAR: "불규칙하게 보이는 형태가 늘어남",
  LESS_IRREGULAR: "불규칙하게 보이는 형태가 줄어듦",
  NO_VISIBLE_CHANGE: "눈에 보이는 변화 없음",
});

const ACTION_STATUSES = new Set(["OPEN", "DONE", "SKIPPED"]);
const EVIDENCE_STATES = new Set([
  "READY",
  "PARTIAL",
  "HOLD",
  "UNAVAILABLE",
  "UNSUPPORTED",
]);
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function createPhotoMetadata(input = {}) {
  const scope = normalizeScope(input);
  const consentState = requiredEnum(
    input.consentState,
    PHOTO_CONSENT_STATES,
    "PHOTO_CONSENT_INVALID",
    "consentState",
  );
  domainAssert(
    consentState === "GRANTED",
    "PHOTO_CONSENT_REQUIRED",
    "Explicit consent is required before a photo is stored.",
  );

  return {
    photoId: requiredText(input.photoId, "PHOTO_ID_REQUIRED", "photoId"),
    ...scope,
    objectPath: requiredText(
      input.objectPath,
      "PHOTO_OBJECT_PATH_REQUIRED",
      "objectPath",
    ),
    thumbnailPath: optionalText(
      input.thumbnailPath,
      "PHOTO_THUMBNAIL_PATH_INVALID",
      "thumbnailPath",
    ),
    observedAt: requiredIso(input.observedAt, "PHOTO_OBSERVED_AT_INVALID"),
    growthStage: optionalText(
      input.growthStage,
      "PHOTO_GROWTH_STAGE_INVALID",
      "growthStage",
    ),
    note: optionalText(input.note, "PHOTO_NOTE_INVALID", "note"),
    consentState,
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
    createdAt: requiredIso(input.createdAt, "PHOTO_CREATED_AT_INVALID"),
    deletedAt: optionalIso(input.deletedAt, "PHOTO_DELETED_AT_INVALID"),
  };
}

export function createObservablePhotoComparison(input = {}) {
  const baselinePhoto = normalizeComparablePhoto(input.baselinePhoto);
  const currentPhoto = normalizeComparablePhoto(input.currentPhoto);
  const baselineScope = normalizeScope(baselinePhoto);
  const currentScope = normalizeScope(currentPhoto);

  domainAssert(
    sameScope(baselineScope, currentScope),
    "PHOTO_SCOPE_MISMATCH",
    "Photo comparisons require the same farm, crop, and season.",
  );
  domainAssert(
    baselinePhoto.photoId !== currentPhoto.photoId,
    "PHOTO_COMPARISON_REQUIRES_TWO_PHOTOS",
    "A photo cannot be compared with itself.",
  );
  domainAssert(
    Date.parse(baselinePhoto.observedAt) <= Date.parse(currentPhoto.observedAt),
    "PHOTO_COMPARISON_TIME_ORDER_INVALID",
    "The baseline photo must not be observed after the current photo.",
  );

  const observations = Array.isArray(input.observations)
    ? input.observations
    : [];
  domainAssert(
    observations.length > 0,
    "PHOTO_OBSERVATIONS_REQUIRED",
    "At least one structured observation is required.",
  );

  const observableChanges = observations.map((observation, index) => {
    domainAssert(
      isPlainObject(observation) &&
        Object.keys(observation).every((key) =>
          ["aspect", "change"].includes(key),
        ),
      "UNOBSERVABLE_PHOTO_CHANGE",
      "Photo changes must contain only an observable aspect and change.",
      { index },
    );
    const allowedChanges = PHOTO_CHANGE_VALUES[observation.aspect];
    domainAssert(
      allowedChanges?.has(observation.change),
      "UNOBSERVABLE_PHOTO_CHANGE",
      "Only reviewed color, area, or shape changes are allowed.",
      { index },
    );
    return {
      aspect: observation.aspect,
      change: observation.change,
      label: CHANGE_LABELS[observation.change],
    };
  });

  return {
    comparisonId: requiredText(
      input.comparisonId,
      "PHOTO_COMPARISON_ID_REQUIRED",
      "comparisonId",
    ),
    scope: baselineScope,
    baselinePhotoId: baselinePhoto.photoId,
    currentPhotoId: currentPhoto.photoId,
    baselineObservedAt: baselinePhoto.observedAt,
    currentObservedAt: currentPhoto.observedAt,
    observableChanges,
    evidenceRefs: [
      photoEvidenceRef(baselinePhoto),
      photoEvidenceRef(currentPhoto),
    ],
    createdAt: requiredIso(
      input.createdAt,
      "PHOTO_COMPARISON_CREATED_AT_INVALID",
    ),
  };
}

export function buildSeasonSummary(input = {}) {
  const season = input.season ?? {};
  const scope = normalizeScope(season);
  const startedAt = requiredIso(
    season.startedAt,
    "SEASON_STARTED_AT_INVALID",
  );
  const requestedEndedAt = input.endedAt ?? season.endedAt ?? null;
  const status = input.status ?? (requestedEndedAt ? "COMPLETED" : season.status);
  domainAssert(
    status === "ACTIVE" || status === "COMPLETED",
    "SEASON_STATUS_INVALID",
    "Season status must be ACTIVE or COMPLETED.",
  );
  const endedAt = optionalIso(requestedEndedAt, "SEASON_ENDED_AT_INVALID");
  domainAssert(
    status !== "COMPLETED" || endedAt !== null,
    "SEASON_ENDED_AT_REQUIRED",
    "A completed season requires endedAt.",
  );
  domainAssert(
    endedAt === null || Date.parse(startedAt) <= Date.parse(endedAt),
    "SEASON_TIME_ORDER_INVALID",
    "endedAt must not be before startedAt.",
  );

  const actions = normalizedScopedRows(input.actions, scope, "action");
  const risks = normalizedScopedRows(input.risks, scope, "risk");
  const storedPhotos = normalizedScopedRows(input.photos, scope, "photo");
  const comparisons = normalizedComparisonRows(input.comparisons, scope);
  const photos = storedPhotos.filter(
    (photo) => photo.deletedAt == null && photo.consentState === "GRANTED",
  );
  const visiblePhotoIds = new Set(photos.map(({ photoId }) => photoId));
  const visibleComparisons = comparisons.filter(
    ({ baselinePhotoId, currentPhotoId }) =>
      visiblePhotoIds.has(baselinePhotoId) && visiblePhotoIds.has(currentPhotoId),
  );

  const actionTimeline = actions
    .map(projectAction)
    .sort(compareTimelineEntries);
  const riskTimeline = risks.map(projectRisk).sort(compareTimelineEntries);
  const photoTimeline = photos.map(toPublicPhotoRecord).sort(compareTimelineEntries);
  const comparisonTimeline = visibleComparisons
    .map(projectComparison)
    .sort(compareTimelineEntries);
  const photoAbsent = photoTimeline.length === 0;

  return {
    seasonId: scope.seasonId,
    farmId: scope.farmId,
    cropId: scope.cropId,
    startedAt,
    endedAt,
    status,
    state: "READY",
    completedActionCount: actions.filter(({ status: value }) => value === "DONE")
      .length,
    skippedActionCount: actions.filter(
      ({ status: value }) => value === "SKIPPED",
    ).length,
    actionTimeline,
    riskTimeline,
    photoTimeline,
    comparisonTimeline,
    photoEvidence: {
      state: photoAbsent ? "UNAVAILABLE" : "READY",
      blocksProduct: false,
    },
    generatedAt: requiredIso(
      input.generatedAt,
      "SEASON_SUMMARY_GENERATED_AT_INVALID",
    ),
    limitations: photoAbsent ? ["PHOTO_HISTORY_ABSENT"] : [],
  };
}

export function toPublicPhotoRecord(photo = {}) {
  const scope = normalizeScope(photo);
  const consentState = requiredEnum(
    photo.consentState,
    PHOTO_CONSENT_STATES,
    "PHOTO_CONSENT_INVALID",
    "consentState",
  );
  return {
    photoId: requiredText(photo.photoId, "PHOTO_ID_REQUIRED", "photoId"),
    ...scope,
    observedAt: requiredIso(photo.observedAt, "PHOTO_OBSERVED_AT_INVALID"),
    growthStage: optionalText(
      photo.growthStage,
      "PHOTO_GROWTH_STAGE_INVALID",
      "growthStage",
    ),
    note: optionalText(photo.note, "PHOTO_NOTE_INVALID", "note"),
    consentState,
    hasThumbnail: Boolean(photo.thumbnailPath),
    createdAt: requiredIso(photo.createdAt, "PHOTO_CREATED_AT_INVALID"),
    deletedAt: optionalIso(photo.deletedAt, "PHOTO_DELETED_AT_INVALID"),
  };
}

function normalizeComparablePhoto(photo) {
  domainAssert(
    isPlainObject(photo),
    "PHOTO_RECORD_REQUIRED",
    "A stored photo record is required.",
  );
  const consentState = requiredEnum(
    photo.consentState,
    PHOTO_CONSENT_STATES,
    "PHOTO_CONSENT_INVALID",
    "consentState",
  );
  domainAssert(
    consentState === "GRANTED" && photo.deletedAt == null,
    "PHOTO_NOT_COMPARABLE",
    "Withdrawn or deleted photos cannot be compared.",
  );
  return {
    photoId: requiredText(photo.photoId, "PHOTO_ID_REQUIRED", "photoId"),
    ...normalizeScope(photo),
    observedAt: requiredIso(photo.observedAt, "PHOTO_OBSERVED_AT_INVALID"),
    consentState,
    deletedAt: null,
  };
}

function projectAction(action) {
  const status = requiredEnum(
    action.status,
    ACTION_STATUSES,
    "SEASON_ACTION_STATUS_INVALID",
    "status",
  );
  const createdAt = requiredIso(
    action.createdAt,
    "SEASON_ACTION_CREATED_AT_INVALID",
  );
  const completedAt = optionalIso(
    action.completedAt,
    "SEASON_ACTION_COMPLETED_AT_INVALID",
  );
  return {
    actionId: requiredText(
      action.actionId,
      "SEASON_ACTION_ID_REQUIRED",
      "actionId",
    ),
    title: requiredText(
      action.title,
      "SEASON_ACTION_TITLE_REQUIRED",
      "title",
    ),
    status,
    completedAt,
    createdAt,
    occurredAt: completedAt ?? createdAt,
  };
}

function projectRisk(risk) {
  const observedAt = optionalIso(
    risk.observedAt,
    "SEASON_RISK_OBSERVED_AT_INVALID",
  );
  const createdAt = requiredIso(
    risk.createdAt,
    "SEASON_RISK_CREATED_AT_INVALID",
  );
  return {
    riskId: requiredText(risk.riskId, "SEASON_RISK_ID_REQUIRED", "riskId"),
    title: requiredText(risk.title, "SEASON_RISK_TITLE_REQUIRED", "title"),
    state: requiredEnum(
      risk.state,
      EVIDENCE_STATES,
      "SEASON_RISK_STATE_INVALID",
      "state",
    ),
    observedAt,
    createdAt,
    occurredAt: observedAt ?? createdAt,
  };
}

function projectComparison(comparison) {
  const observableChanges = Array.isArray(comparison.observableChanges)
    ? comparison.observableChanges.map((change, index) => {
        const allowed = PHOTO_CHANGE_VALUES[change?.aspect];
        domainAssert(
          allowed?.has(change?.change),
          "UNOBSERVABLE_PHOTO_CHANGE",
          "Stored comparisons must contain only reviewed observable changes.",
          { index },
        );
        return {
          aspect: change.aspect,
          change: change.change,
          label: CHANGE_LABELS[change.change],
        };
      })
    : [];
  const currentObservedAt = requiredIso(
    comparison.currentObservedAt,
    "PHOTO_OBSERVED_AT_INVALID",
  );
  return {
    comparisonId: requiredText(
      comparison.comparisonId,
      "PHOTO_COMPARISON_ID_REQUIRED",
      "comparisonId",
    ),
    baselinePhotoId: requiredText(
      comparison.baselinePhotoId,
      "PHOTO_ID_REQUIRED",
      "baselinePhotoId",
    ),
    currentPhotoId: requiredText(
      comparison.currentPhotoId,
      "PHOTO_ID_REQUIRED",
      "currentPhotoId",
    ),
    baselineObservedAt: requiredIso(
      comparison.baselineObservedAt,
      "PHOTO_OBSERVED_AT_INVALID",
    ),
    currentObservedAt,
    observableChanges,
    createdAt: requiredIso(
      comparison.createdAt,
      "PHOTO_COMPARISON_CREATED_AT_INVALID",
    ),
    occurredAt: currentObservedAt,
  };
}

function normalizedScopedRows(rows, scope, kind) {
  domainAssert(
    rows === undefined || Array.isArray(rows),
    "SEASON_EVENTS_INVALID",
    `Season ${kind} rows must be an array.`,
  );
  return (rows ?? []).map((row, index) => {
    domainAssert(
      isPlainObject(row) && sameScope(normalizeScope(row), scope),
      "SEASON_EVENT_SCOPE_MISMATCH",
      "Season events must belong to the requested farm, crop, and season.",
      { kind, index },
    );
    return row;
  });
}

function normalizedComparisonRows(rows, scope) {
  domainAssert(
    rows === undefined || Array.isArray(rows),
    "SEASON_EVENTS_INVALID",
    "Season comparison rows must be an array.",
  );
  return (rows ?? []).map((row, index) => {
    domainAssert(
      isPlainObject(row) && sameScope(normalizeScope(row.scope), scope),
      "SEASON_EVENT_SCOPE_MISMATCH",
      "Season comparisons must belong to the requested scope.",
      { kind: "comparison", index },
    );
    return row;
  });
}

function normalizeEvidenceRefs(refs) {
  if (refs === undefined) return [];
  domainAssert(
    Array.isArray(refs),
    "PHOTO_EVIDENCE_REFS_INVALID",
    "evidenceRefs must be an array.",
  );
  return structuredClone(refs);
}

function photoEvidenceRef(photo) {
  return {
    sourceKind: "PHOTO",
    sourceId: photo.photoId,
    observedAt: photo.observedAt,
    fetchedAt: null,
    spatialLevel: "FIELD",
    state: "READY",
    limitationCodes: [],
  };
}

function normalizeScope(input = {}) {
  return {
    farmId: requiredText(input.farmId, "FARM_ID_REQUIRED", "farmId"),
    cropId: requiredText(input.cropId, "CROP_ID_REQUIRED", "cropId"),
    seasonId: requiredText(input.seasonId, "SEASON_ID_REQUIRED", "seasonId"),
  };
}

function sameScope(left, right) {
  return (
    left.farmId === right.farmId &&
    left.cropId === right.cropId &&
    left.seasonId === right.seasonId
  );
}

function compareTimelineEntries(left, right) {
  const leftTime = left.occurredAt ?? left.observedAt ?? left.createdAt;
  const rightTime = right.occurredAt ?? right.observedAt ?? right.createdAt;
  const difference = Date.parse(leftTime) - Date.parse(rightTime);
  if (difference !== 0) return difference;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function requiredText(value, code, field) {
  domainAssert(
    typeof value === "string" && value.trim().length > 0,
    code,
    `${field} must be a non-empty string.`,
  );
  return value.trim();
}

function optionalText(value, code, field) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, code, field);
}

function requiredIso(value, code) {
  domainAssert(
    typeof value === "string" &&
      ISO_TIMESTAMP_WITH_ZONE.test(value) &&
      Number.isFinite(Date.parse(value)),
    code,
    "A valid ISO 8601 timestamp is required.",
  );
  return new Date(value).toISOString();
}

function optionalIso(value, code) {
  if (value === undefined || value === null) return null;
  return requiredIso(value, code);
}

function requiredEnum(value, allowed, code, field) {
  domainAssert(allowed.has(value), code, `${field} is invalid.`);
  return value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
