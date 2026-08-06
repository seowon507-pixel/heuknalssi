import { domainAssert } from "./errors.js";

/**
 * 자동 일기 초안. 명세 25번 4절의 계약이다.
 *
 * 이 모듈의 존재 이유는 문장을 예쁘게 만드는 게 아니라, **사용자가 보지 않은
 * 것을 적지 않는 것**이다. 그래서 순서가 이렇다.
 *
 *   1. 허용 목록에 있는 입력만 구조화한다 (4.1)
 *   2. 결정론적 템플릿으로 최소 초안을 만든다 (4.3-2)
 *   3. 만든 문장을 금지 표현 검사에 통과시킨다 (4.2)
 *   4. AI 는 사실을 더하지 않는 범위에서 문장만 다듬는다 (4.3-3)
 *
 * AI 가 실패해도 템플릿 초안으로 흐름이 이어진다. 3번은 AI 결과에도
 * 그대로 적용해서, 모델이 없는 관찰을 끼워 넣으면 초안을 버린다.
 */

export const DIARY_DRAFT_RULE_VERSION = "diary-draft-v2";

export const AuthoringMode = Object.freeze(["MANUAL", "AI_DRAFT_EDITED"]);
export const DraftStatus = Object.freeze(["DRAFT", "SAVED"]);

/** 감정 태그는 사용자의 기분이며 작물 상태가 아니다. */
export const EmotionTag = Object.freeze([
  "GLAD",
  "CALM",
  "TIRED",
  "WORRIED",
]);

const EMOTION_LABEL_KO = Object.freeze({
  GLAD: "기뻐요",
  CALM: "괜찮아요",
  TIRED: "지쳤어요",
  WORRIED: "걱정돼요",
});

const MAX_TITLE_LENGTH = 60;
const MAX_BODY_LENGTH = 5_000;

const CHECKIN_SENTENCE = Object.freeze({
  FIELD_VISIT: "농장에 다녀왔어요.",
  REMOTE_CHECK: "직접 가지는 않고 원격으로 확인했어요.",
});

/**
 * 초안에 절대 나오면 안 되는 표현. 명세 4.2 를 검사 가능한 형태로 옮겼다.
 * 사용자가 직접 쓴 메모에는 적용하지 않는다. 자기 밭을 자기 말로 적는 것은
 * 날조가 아니다.
 */
const FORBIDDEN_CLAIM_PATTERNS = Object.freeze([
  Object.freeze({ pattern: /(잎|열매|줄기|뿌리)[^.]{0,12}(시들|마르|처지|변색|누렇|갈변)/, reason: "UNOBSERVED_PLANT_STATE" }),
  Object.freeze({ pattern: /(병해충|탄저병|흰가루|역병|노균병|반점병)/, reason: "PEST_DIAGNOSIS" }),
  Object.freeze({ pattern: /(감염|발병)(했|된|되었)/, reason: "PEST_DIAGNOSIS" }),
  Object.freeze({ pattern: /(살포|살균제|살충제|농약)[^.]{0,10}(하세요|권장|처방|투입)/, reason: "NEW_PRESCRIPTION" }),
  Object.freeze({ pattern: /(비료|영양제)[^.]{0,10}(kg|g|L|리터|ml)/, reason: "NEW_PRESCRIPTION" }),
  Object.freeze({ pattern: /(관수량|물\s?\d+\s?(L|리터|ml))/, reason: "NEW_PRESCRIPTION" }),
  Object.freeze({ pattern: /(작업|정리|수확)[^.]{0,8}(모두|전부)\s?(끝|완료)/, reason: "ASSUMED_COMPLETION" }),
  Object.freeze({ pattern: /토양\s?(수분|산도|양분)[^.]{0,10}(측정|실측)(값|됨|했)/, reason: "REGIONAL_AS_MEASURED" }),
]);

/**
 * 결정론적 초안을 만든다. 같은 입력이면 같은 문장이 나온다.
 *
 * @param {object} input
 * @param {string} input.farmId
 * @param {string} input.entryDate
 * @param {object|null} input.checkin              오늘 출석 (유형과 시각만)
 * @param {Array}  [input.completedActions]        사용자가 완료한 행동 [{ titleKo, completedAt }]
 * @param {string|null} [input.userNote]           사용자가 직접 쓴 메모
 * @param {Array}  [input.photos]                  [{ takenOn, cropId }]
 * @param {object|null} [input.weatherSnapshot]    검증된 기상 요약 { summaryKo, warningsKo[] }
 * @param {object|null} [input.soilReference]      { kind: REGIONAL|FIELD_TEST, summaryKo }
 * @param {Array}  [input.cropCycleLabels]         [{ cropId, stageLabelKo, estimated }]
 */
export function buildDiaryDraft(input = {}) {
  const {
    farmId,
    entryDate,
    checkin = null,
    completedActions = [],
    userNote = null,
    photos = [],
    weatherSnapshot = null,
    soilReference = null,
    cropCycleLabels = [],
  } = input;

  requireText(farmId, "farmId");
  requireDate(entryDate, "entryDate");

  const usedSources = [];
  const sentences = [];

  // 4.1 출석 유형과 시각
  if (checkin !== null) {
    const sentence = CHECKIN_SENTENCE[checkin.checkinType];
    domainAssert(
      sentence !== undefined,
      "DIARY_CHECKIN_TYPE_INVALID",
      "checkinType must be FIELD_VISIT or REMOTE_CHECK",
      { checkinType: checkin.checkinType },
    );
    sentences.push(sentence);
    usedSources.push(source("CHECKIN", checkin.localDate ?? entryDate));
  }

  // 4.1 저장 시점의 검증된 기상 요약과 경고
  if (weatherSnapshot?.summaryKo) {
    sentences.push(`날씨는 ${weatherSnapshot.summaryKo}였어요.`);
    usedSources.push(source("WEATHER_SNAPSHOT", entryDate));
  }
  const warnings = (weatherSnapshot?.warningsKo ?? []).filter(isNonEmptyText);
  if (warnings.length > 0) {
    sentences.push(`주의 안내가 있었어요: ${warnings.join(", ")}.`);
  }

  // 4.1 사용자가 완료한 행동의 제목
  const actionTitles = completedActions
    .filter((row) => isNonEmptyText(row?.titleKo))
    .map((row) => row.titleKo.trim());
  if (actionTitles.length > 0) {
    sentences.push(`오늘 한 일은 ${actionTitles.join(", ")}이에요.`);
    usedSources.push(source("ACTIONS", entryDate));
  }

  // 4.1 사용자가 선택한 사진의 촬영일과 작물
  const usablePhotos = photos.filter((row) => isDate(row?.takenOn));
  if (usablePhotos.length > 0) {
    sentences.push(`사진 ${usablePhotos.length}장을 남겼어요.`);
    usedSources.push(source("PHOTOS", usablePhotos[0].takenOn));
  }

  // 작물 단계는 라벨을 그대로 옮긴다. 초안이 단계를 새로 판단하지 않는다.
  for (const label of cropCycleLabels) {
    if (!isNonEmptyText(label?.stageLabelKo)) continue;
    const suffix = label.estimated ? " (예상 단계)" : "";
    sentences.push(`${label.stageLabelKo}${suffix}.`);
    usedSources.push(source("CROP_CYCLE", entryDate));
  }

  // 4.1 지역 참고와 필지 검사값을 반드시 구분해 적는다.
  if (isNonEmptyText(soilReference?.summaryKo)) {
    const prefix =
      soilReference.kind === "FIELD_TEST" ? "내 농장 검사값" : "주변 토양 참고";
    sentences.push(`${prefix}: ${soilReference.summaryKo}.`);
    usedSources.push(source("SOIL_REFERENCE", entryDate));
  }

  const generated = sentences.join(" ").trim();
  const audit = auditDraftText(generated);
  domainAssert(
    audit.valid,
    "DIARY_DRAFT_FORBIDDEN_CLAIM",
    "the template produced a claim the user did not observe",
    { problems: audit.problems },
  );

  const note = normalizeNote(userNote);
  const body = [generated, note].filter(isNonEmptyText).join("\n\n").slice(0, MAX_BODY_LENGTH);

  return Object.freeze({
    ruleVersion: DIARY_DRAFT_RULE_VERSION,
    farmId,
    entryDate,
    title: buildTitle(entryDate, checkin),
    body,
    generatedBody: generated,
    userNote: note,
    authoringMode: "MANUAL",
    draftStatus: "DRAFT",
    // 화면에는 `자동으로 정리한 초안` 으로 표시한다 (4.3-5).
    presentationLabelKo: "자동으로 정리한 초안",
    usedSources: Object.freeze(usedSources),
    empty: generated.length === 0 && note === null,
  });
}

/**
 * AI 가 다듬은 문장을 받아들일지 결정한다. 사실을 더했으면 거절하고 템플릿
 * 초안을 그대로 쓴다. 모델이 실패했을 때와 같은 경로다.
 */
export function acceptRefinedDraft(draft, refinedBody, { allowedNumbers = null } = {}) {
  domainAssert(
    draft !== null && typeof draft === "object",
    "DIARY_DRAFT_INVALID",
    "a draft is required",
    {},
  );
  if (!isNonEmptyText(refinedBody)) {
    return Object.freeze({ accepted: false, reason: "EMPTY_REFINEMENT", draft });
  }

  const audit = auditDraftText(refinedBody);
  if (!audit.valid) {
    return Object.freeze({ accepted: false, reason: "FORBIDDEN_CLAIM", problems: audit.problems, draft });
  }

  const introduced = introducedNumbers(
    refinedBody,
    allowedNumbers ?? collectNumbers(`${draft.generatedBody} ${draft.userNote ?? ""}`),
  );
  if (introduced.length > 0) {
    // 없던 숫자가 생겼다는 것은 사실을 더했다는 뜻이다.
    return Object.freeze({ accepted: false, reason: "NEW_NUMBERS", introduced, draft });
  }

  return Object.freeze({
    accepted: true,
    reason: "OK",
    draft: Object.freeze({
      ...draft,
      body: refinedBody.slice(0, MAX_BODY_LENGTH),
      authoringMode: "AI_DRAFT_EDITED",
    }),
  });
}

/** 저장 확정. 사용자가 저장해야 SAVED 가 된다 (4.3-6). */
export function saveDiaryEntry(draft, patch = {}, { now } = {}) {
  domainAssert(
    draft !== null && typeof draft === "object",
    "DIARY_DRAFT_INVALID",
    "a draft is required",
    {},
  );
  const emotionTag = patch.emotionTag ?? null;
  domainAssert(
    emotionTag === null || EmotionTag.includes(emotionTag),
    "DIARY_EMOTION_INVALID",
    "emotionTag is not a known value",
    { emotionTag },
  );
  const body = normalizeBody(patch.body ?? draft.body);
  const audit = auditDraftText(patch.body === undefined ? draft.generatedBody : "");
  domainAssert(audit.valid, "DIARY_DRAFT_FORBIDDEN_CLAIM", "the draft contains a forbidden claim", {
    problems: audit.problems,
  });

  return Object.freeze({
    ...draft,
    title: normalizeTitle(patch.title ?? draft.title),
    body,
    emotionTag,
    emotionLabelKo: emotionTag === null ? null : EMOTION_LABEL_KO[emotionTag],
    visibility: "PRIVATE",
    draftStatus: "SAVED",
    authoringMode: AuthoringMode.includes(patch.authoringMode)
      ? patch.authoringMode
      : draft.authoringMode,
    savedAt: requireTimestamp(now, "now"),
  });
}

/** 금지 표현 검사. 사용자 메모가 아니라 생성된 문장에만 쓴다. */
export function auditDraftText(text) {
  if (!isNonEmptyText(text)) {
    return Object.freeze({ valid: true, problems: Object.freeze([]) });
  }
  const problems = [];
  for (const rule of FORBIDDEN_CLAIM_PATTERNS) {
    const found = rule.pattern.exec(text);
    if (found !== null) {
      problems.push(Object.freeze({ reason: rule.reason, matched: found[0] }));
    }
  }
  return Object.freeze({ valid: problems.length === 0, problems: Object.freeze(problems) });
}

function buildTitle(entryDate, checkin) {
  const [, month, day] = entryDate.split("-");
  const visit = checkin === null ? "기록" : checkin.checkinType === "FIELD_VISIT" ? "현장" : "원격";
  return `${Number(month)}월 ${Number(day)}일 ${visit}`.slice(0, MAX_TITLE_LENGTH);
}

function collectNumbers(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function introducedNumbers(refined, allowed) {
  const allowedSet = new Set(allowed.map(Number));
  return collectNumbers(refined).filter((value) => !allowedSet.has(value));
}

function source(sourceType, capturedOn) {
  return Object.freeze({ sourceType, capturedOn });
}

function normalizeNote(note) {
  if (!isNonEmptyText(note)) return null;
  return note.trim().slice(0, MAX_BODY_LENGTH);
}

function normalizeBody(body) {
  domainAssert(
    typeof body === "string",
    "DIARY_BODY_INVALID",
    "body must be text",
    {},
  );
  return body.slice(0, MAX_BODY_LENGTH);
}

function normalizeTitle(title) {
  domainAssert(isNonEmptyText(title), "DIARY_TITLE_REQUIRED", "title is required", {});
  return title.trim().slice(0, MAX_TITLE_LENGTH);
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireText(value, field) {
  domainAssert(isNonEmptyText(value), "DIARY_FIELD_REQUIRED", `${field} is required`, { field });
}

function requireDate(value, field) {
  domainAssert(isDate(value), "DIARY_DATE_INVALID", `${field} must be YYYY-MM-DD`, { field, value });
}

function requireTimestamp(value, field) {
  domainAssert(
    typeof value === "string" && Number.isFinite(Date.parse(value)),
    "DIARY_TIMESTAMP_INVALID",
    `${field} must be an ISO timestamp`,
    { field },
  );
  return value;
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

export { EMOTION_LABEL_KO, FORBIDDEN_CLAIM_PATTERNS, MAX_BODY_LENGTH, MAX_TITLE_LENGTH };
