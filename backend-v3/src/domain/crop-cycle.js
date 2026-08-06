import { domainAssert } from "./errors.js";

export const CROP_CYCLE_RULE_VERSION = "crop-cycle-v2";
export const CROP_CYCLE_EVIDENCE_VERSION =
  "nongsaro-crop-cycle-evidence-2026-08-04.v2";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const STATUSES = new Set([
  "PLANNING",
  "ACTIVE",
  "HARVEST_WINDOW",
  "COMPLETED",
]);

const EVIDENCE = Object.freeze({
  APPLE: Object.freeze({
    sourceId: "NONGSARO_APPLE_MONTHLY_CALENDAR",
    url: "https://www.nongsaro.go.kr/cms_contents/937/100207_MF_ATTACH_01.pdf",
    supports: Object.freeze([
      "FLOWERING_TO_HARVEST_RANGE",
      "MONTHLY_MILESTONES",
    ]),
  }),
  PEAR: Object.freeze({
    sourceId: "NONGSARO_PEAR_HARVEST_TIMING",
    url: "https://www.nongsaro.go.kr/portal/ps/psb/psbo/vodPlay.ps?mvpNo=41",
    supports: Object.freeze(["FLOWERING_TO_HARVEST_RANGE"]),
  }),
  CUCUMBER: Object.freeze({
    sourceId: "NONGSARO_CUCUMBER_CROPPING_SYSTEMS",
    url: "https://www.nongsaro.go.kr/portal/ps/psb/psby/vodPlay.ps?cntntsNo=93088&menuId=PS00069&mvpNo=345",
    supports: Object.freeze(["SOWING_AND_HARVEST_MONTH_RANGES"]),
  }),
  POTATO: Object.freeze({
    sourceId: "NONGSARO_POTATO_WORK_SCHEDULE",
    url: "https://www.nongsaro.go.kr/portal/ps/psb/psbl/workScheduleDtl.ps?cntntsNo=30699&menuId=PS00087&sKidofcomdtySeCode=210005",
    supports: Object.freeze([
      "SOWING_TO_HARVEST_RANGE",
      "EMERGENCE_RANGE",
    ]),
  }),
  LETTUCE: Object.freeze({
    sourceId: "NONGSARO_LETTUCE_GROWING_REFERENCES",
    url: "https://www.nongsaro.go.kr/portal/ps/psz/psza/contentSub.ps?cntntsNo=263079&menuId=PS00077",
    supports: Object.freeze([
      "TRANSPLANTING_TO_HARVEST_RANGE",
      "VARIETY_AND_SEASON_VARIATION",
    ]),
  }),
});

const PROFILE_DEFINITIONS = Object.freeze({
  "APPLE|FLOWERING": profile({
    cropId: "APPLE",
    anchorType: "FLOWERING",
    harvest: [125, 190],
    harvestPreparationLead: [7, 30],
    confidence: "MEDIUM",
    evidence: EVIDENCE.APPLE,
    milestones: [
      ["FLOWERING", "개화", 0, 14],
      ["FRUIT_DEVELOPMENT", "과실 비대", 14, 124],
      ["HARVEST", "수확", 125, 190],
    ],
  }),
  "APPLE|SEASON_START": profile({
    cropId: "APPLE",
    anchorType: "SEASON_START",
    harvest: [230, 310],
    harvestPreparationLead: [14, 45],
    confidence: "LOW",
    evidence: EVIDENCE.APPLE,
    milestones: [
      ["SEASON_START", "재배력 시작", 0, 30],
      ["FLOWERING", "개화", 70, 135],
      ["FRUIT_DEVELOPMENT", "과실 비대", 110, 229],
      ["HARVEST", "수확", 230, 310],
    ],
  }),
  "PEAR|FLOWERING": profile({
    cropId: "PEAR",
    anchorType: "FLOWERING",
    harvest: [145, 185],
    harvestPreparationLead: [7, 30],
    confidence: "MEDIUM",
    evidence: EVIDENCE.PEAR,
    milestones: [
      ["FLOWERING", "개화", 0, 14],
      ["FRUIT_DEVELOPMENT", "과실 비대", 14, 144],
      ["HARVEST", "수확", 145, 185],
    ],
  }),
  "PEAR|SEASON_START": profile({
    cropId: "PEAR",
    anchorType: "SEASON_START",
    harvest: [220, 310],
    harvestPreparationLead: [14, 45],
    confidence: "LOW",
    evidence: EVIDENCE.PEAR,
    milestones: [
      ["SEASON_START", "재배력 시작", 0, 30],
      ["FLOWERING", "개화", 65, 135],
      ["FRUIT_DEVELOPMENT", "과실 비대", 100, 219],
      ["HARVEST", "수확", 220, 310],
    ],
  }),
  "CUCUMBER|TRANSPLANTING": profile({
    cropId: "CUCUMBER",
    anchorType: "TRANSPLANTING",
    // 첫 수확 시점과 장기 수확 종료일을 같은 진행률 분모로 사용하지
    // 않는다. 일정 진행률은 첫 수확 준비도를, harvestSeason은 이후의
    // 연속 수확 가능 기간을 나타낸다.
    harvest: [45, 75],
    harvestSeason: [45, 240],
    harvestPreparationLead: [14, 35],
    confidence: "LOW",
    evidence: EVIDENCE.CUCUMBER,
    milestones: [
      ["TRANSPLANTING", "정식", 0, 14],
      ["ESTABLISHMENT", "활착", 7, 35],
      ["FLOWERING_AND_FRUIT_SET", "개화·착과", 25, 75],
      ["HARVEST", "수확", 45, 240],
    ],
  }),
  "CUCUMBER|SOWING": profile({
    cropId: "CUCUMBER",
    anchorType: "SOWING",
    harvest: [65, 95],
    harvestSeason: [65, 270],
    harvestPreparationLead: [14, 35],
    confidence: "LOW",
    evidence: EVIDENCE.CUCUMBER,
    milestones: [
      ["SOWING", "파종", 0, 10],
      ["TRANSPLANTING", "정식", 20, 45],
      ["FLOWERING_AND_FRUIT_SET", "개화·착과", 45, 95],
      ["HARVEST", "수확", 65, 270],
    ],
  }),
  "POTATO|SOWING": profile({
    cropId: "POTATO",
    anchorType: "SOWING",
    harvest: [70, 140],
    harvestPreparationLead: [20, 35],
    confidence: "MEDIUM",
    evidence: EVIDENCE.POTATO,
    milestones: [
      ["SOWING", "파종", 0, 10],
      ["EMERGENCE", "출현", 20, 30],
      ["TUBER_DEVELOPMENT", "덩이줄기 비대", 40, 110],
      ["HARVEST", "수확", 70, 140],
    ],
  }),
  "LETTUCE|TRANSPLANTING": profile({
    cropId: "LETTUCE",
    anchorType: "TRANSPLANTING",
    harvest: [27, 70],
    harvestPreparationLead: [7, 21],
    confidence: "MEDIUM",
    evidence: EVIDENCE.LETTUCE,
    milestones: [
      ["TRANSPLANTING", "정식", 0, 7],
      ["LEAF_GROWTH", "잎 생장", 7, 45],
      ["HARVEST", "수확", 27, 70],
    ],
  }),
  "LETTUCE|SOWING": profile({
    cropId: "LETTUCE",
    anchorType: "SOWING",
    harvest: [52, 100],
    harvestPreparationLead: [7, 21],
    confidence: "LOW",
    evidence: EVIDENCE.LETTUCE,
    milestones: [
      ["SOWING", "파종", 0, 10],
      ["TRANSPLANTING", "정식", 25, 35],
      ["LEAF_GROWTH", "잎 생장", 32, 70],
      ["HARVEST", "수확", 52, 100],
    ],
  }),
});

const CROP_IDS = new Set(
  Object.values(PROFILE_DEFINITIONS).map(({ cropId }) => cropId),
);

export function createCropCycleRecord(input = {}) {
  const cropId = requiredCrop(input.cropId);
  const anchorType = requiredText(
    input.anchorType,
    "CROP_CYCLE_ANCHOR_INVALID",
    "anchorType",
  );
  const selectedProfile = PROFILE_DEFINITIONS[`${cropId}|${anchorType}`];
  domainAssert(
    selectedProfile,
    "CROP_CYCLE_ANCHOR_INVALID",
    "The anchor type is not supported for this crop.",
  );
  const status = requiredStatus(input.status);
  const userConfirmed = requiredBoolean(input.userConfirmed, "userConfirmed");
  const completedOn = optionalDate(input.completedOn, "completedOn");
  domainAssert(
    status !== "COMPLETED" || userConfirmed,
    "CROP_CYCLE_COMPLETE_CONFIRMATION_REQUIRED",
    "Completing a crop cycle requires explicit confirmation.",
  );
  domainAssert(
    status !== "HARVEST_WINDOW" || userConfirmed,
    "CROP_CYCLE_CONFIRMATION_INVALID",
    "A user-confirmed harvest window requires explicit confirmation.",
  );
  domainAssert(
    (status === "COMPLETED") === (completedOn !== null),
    "CROP_CYCLE_COMPLETION_DATE_INVALID",
    "A completion date is present only for a completed cycle.",
  );

  const anchorDate = requiredDate(input.anchorDate, "anchorDate");
  domainAssert(
    completedOn === null || compareDates(anchorDate, completedOn) <= 0,
    "CROP_CYCLE_COMPLETION_DATE_INVALID",
    "The completion date cannot be before the anchor date.",
  );

  return {
    farmId: requiredIdentifier(input.farmId, "farmId"),
    cropId,
    seasonId: requiredIdentifier(input.seasonId, "seasonId"),
    anchorType,
    anchorDate,
    status,
    userConfirmed,
    completedOn,
    createdAt: requiredTimestamp(input.createdAt, "createdAt"),
    updatedAt: requiredTimestamp(input.updatedAt, "updatedAt"),
    revision: requiredRevision(input.revision),
  };
}

export function updateCropCycleRecord(current = {}, patch = {}) {
  const baseline = createCropCycleRecord(current);
  domainAssert(
    baseline.status !== "COMPLETED",
    "CROP_CYCLE_COMPLETED",
    "A completed crop cycle cannot be changed.",
  );
  return createCropCycleRecord({
    ...baseline,
    anchorType: patch.anchorType ?? baseline.anchorType,
    anchorDate: patch.anchorDate ?? baseline.anchorDate,
    status: patch.status ?? baseline.status,
    userConfirmed: patch.userConfirmed ?? baseline.userConfirmed,
    completedOn:
      patch.completedOn !== undefined
        ? patch.completedOn
        : baseline.completedOn,
    updatedAt: patch.updatedAt,
    revision: baseline.revision + 1,
  });
}

export function projectCropCycle(rawRecord = {}, { asOfDate } = {}) {
  const record = createCropCycleRecord(rawRecord);
  const profileDefinition =
    PROFILE_DEFINITIONS[`${record.cropId}|${record.anchorType}`];
  const today = requiredDate(asOfDate, "asOfDate");
  const harvestWindow = dateWindow(record.anchorDate, profileDefinition.harvest);
  const harvestSeasonWindow = dateWindow(
    record.anchorDate,
    profileDefinition.harvestSeason,
  );
  const preparationStartsOn = {
    earliest: addDays(
      harvestWindow.earliest,
      -profileDefinition.harvestPreparationLead[1],
    ),
    latest: addDays(
      harvestWindow.latest,
      -profileDefinition.harvestPreparationLead[0],
    ),
  };
  const status = projectedStatus(record, today, harvestWindow);
  const milestones = projectedMilestones(record.anchorDate, profileDefinition);
  const milestoneProjection = selectMilestones({
    today,
    status,
    anchorDate: record.anchorDate,
    completedOn: record.completedOn,
    milestones,
  });
  const confidence = record.userConfirmed
    ? profileDefinition.confidence
    : "LOW";
  const uncertaintyFactors = [
    "CULTIVATION_MODE_UNSPECIFIED",
    "VARIETY_UNSPECIFIED",
    "HARVEST_PREPARATION_ESTIMATED",
    ...(record.anchorType === "SEASON_START"
      ? ["ANCHOR_EVENT_BROAD"]
      : []),
    ...(!record.userConfirmed ? ["ANCHOR_DATE_NOT_USER_CONFIRMED"] : []),
    ...(status === "PLANNING" && compareDates(today, record.anchorDate) >= 0
      ? ["PLANNED_ANCHOR_NOT_ACTIVATED"]
      : []),
  ];

  return {
    farmId: record.farmId,
    cropId: record.cropId,
    seasonId: record.seasonId,
    anchorType: record.anchorType,
    anchorDate: record.anchorDate,
    status,
    userConfirmed: record.userConfirmed,
    completedOn: record.completedOn,
    revision: record.revision,
    progress: projectProgress({
      status,
      today,
      anchorDate: record.anchorDate,
      harvest: profileDefinition.harvest,
    }),
    harvestWindow,
    harvestSeasonWindow,
    currentMilestone: milestoneProjection.currentMilestone,
    nextMilestone: milestoneProjection.nextMilestone,
    preparationStartsOn,
    confidence,
    estimated: true,
    uncertaintyFactors,
    ruleVersion: CROP_CYCLE_RULE_VERSION,
    evidenceVersion: CROP_CYCLE_EVIDENCE_VERSION,
    evidenceRefs: [structuredClone(profileDefinition.evidence)],
  };
}

function profile({
  cropId,
  anchorType,
  harvest,
  harvestSeason = harvest,
  harvestPreparationLead,
  confidence,
  evidence,
  milestones,
}) {
  return Object.freeze({
    cropId,
    anchorType,
    harvest: Object.freeze(harvest),
    harvestSeason: Object.freeze(harvestSeason),
    harvestPreparationLead: Object.freeze(harvestPreparationLead),
    confidence,
    evidence,
    milestones: Object.freeze(
      milestones.map(([code, label, earliestDay, latestDay]) =>
        Object.freeze({ code, label, earliestDay, latestDay }),
      ),
    ),
  });
}

function projectedStatus(record, today, harvestWindow) {
  if (record.status === "COMPLETED") return "COMPLETED";
  if (record.status === "PLANNING") return "PLANNING";
  if (record.status === "HARVEST_WINDOW") return "HARVEST_WINDOW";
  return compareDates(today, harvestWindow.earliest) >= 0
    ? "HARVEST_WINDOW"
    : "ACTIVE";
}

function projectProgress({ status, today, anchorDate, harvest }) {
  if (status === "COMPLETED") return progress(100, 100);
  if (status === "PLANNING" || compareDates(today, anchorDate) <= 0) {
    return progress(0, 0);
  }
  const elapsedDays = daysBetween(anchorDate, today);
  return progress(
    clampPercent(Math.floor((elapsedDays / harvest[1]) * 100)),
    clampPercent(Math.ceil((elapsedDays / harvest[0]) * 100)),
  );
}

function progress(minPercent, maxPercent) {
  return {
    kind: "SCHEDULE_ESTIMATE",
    minPercent,
    maxPercent,
    actualBiologicalScore: null,
  };
}

function projectedMilestones(anchorDate, profileDefinition) {
  return profileDefinition.milestones.map(
    ({ code, label, earliestDay, latestDay }) => ({
      code,
      label,
      window: {
        earliest: addDays(anchorDate, earliestDay),
        latest: addDays(anchorDate, latestDay),
      },
    }),
  );
}

function selectMilestones({
  today,
  status,
  anchorDate,
  completedOn,
  milestones,
}) {
  if (status === "COMPLETED") {
    return {
      currentMilestone: milestoneGroup([
        {
          code: "COMPLETED",
          label: "재배 완료",
          window: { earliest: completedOn, latest: completedOn },
        },
      ]),
      nextMilestone: null,
    };
  }

  if (status === "HARVEST_WINDOW") {
    const harvestMilestone = milestones.find(({ code }) => code === "HARVEST");
    return {
      currentMilestone: milestoneGroup([harvestMilestone]),
      nextMilestone: null,
    };
  }

  if (status === "PLANNING" && compareDates(today, anchorDate) < 0) {
    return {
      currentMilestone: milestoneGroup([
        {
          code: "PLANNING",
          label: "재배 계획",
          window: {
            earliest: today,
            latest: addDays(anchorDate, -1),
          },
        },
      ]),
      nextMilestone: milestoneGroup([milestones[0]]),
    };
  }

  if (status === "PLANNING") {
    return {
      currentMilestone: milestoneGroup([
        {
          code: "PLANNING",
          label: "시작 확인 대기",
          window: { earliest: anchorDate, latest: today },
        },
      ]),
      nextMilestone: milestoneGroup([milestones[0]]),
    };
  }

  const containing = milestones.filter(
    ({ window }) =>
      compareDates(window.earliest, today) <= 0 &&
      compareDates(today, window.latest) <= 0,
  );
  let current = containing;
  if (current.length === 0) {
    const past = milestones.filter(
      ({ window }) => compareDates(window.earliest, today) <= 0,
    );
    current = past.length > 0 ? [past.at(-1)] : [milestones[0]];
  }
  const upcoming = milestones.filter(
    ({ window }) => compareDates(window.earliest, today) > 0,
  );
  return {
    currentMilestone: milestoneGroup(current),
    nextMilestone:
      upcoming.length === 0 ? null : milestoneGroup([upcoming[0]]),
  };
}

function milestoneGroup(candidates) {
  return {
    certainty: candidates.length === 1 ? "SINGLE" : "ONE_OF",
    candidates: candidates.map((candidate) => structuredClone(candidate)),
  };
}

function dateWindow(anchorDate, [earliestDay, latestDay]) {
  return {
    earliest: addDays(anchorDate, earliestDay),
    latest: addDays(anchorDate, latestDay),
  };
}

function addDays(date, days) {
  const instant = parseDate(date);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.floor((parseDate(end).getTime() - parseDate(start).getTime()) / DAY_MS);
}

function compareDates(left, right) {
  return Math.sign(parseDate(left).getTime() - parseDate(right).getTime());
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function requiredCrop(value) {
  domainAssert(
    typeof value === "string" && CROP_IDS.has(value),
    "CROP_CYCLE_CROP_INVALID",
    "cropId must be one of the five supported crop codes.",
  );
  return value;
}

function requiredIdentifier(value, field) {
  domainAssert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 180,
    "CROP_CYCLE_SCOPE_INVALID",
    `${field} must be a non-empty identifier.`,
  );
  return value;
}

function requiredText(value, code, field) {
  domainAssert(
    typeof value === "string" && value.trim() === value && value.length > 0,
    code,
    `${field} must be a non-empty string.`,
  );
  return value;
}

function requiredStatus(value) {
  domainAssert(
    STATUSES.has(value),
    "CROP_CYCLE_STATUS_INVALID",
    "The crop-cycle status is invalid.",
  );
  return value;
}

function requiredBoolean(value, field) {
  domainAssert(
    typeof value === "boolean",
    "CROP_CYCLE_CONFIRMATION_INVALID",
    `${field} must be a boolean.`,
  );
  return value;
}

function requiredDate(value, field) {
  domainAssert(
    typeof value === "string" && DATE_ONLY.test(value),
    "CROP_CYCLE_DATE_INVALID",
    `${field} must be an ISO calendar date.`,
  );
  const parsed = parseDate(value);
  domainAssert(
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    "CROP_CYCLE_DATE_INVALID",
    `${field} must be a valid ISO calendar date.`,
  );
  return value;
}

function optionalDate(value, field) {
  return value == null ? null : requiredDate(value, field);
}

function requiredTimestamp(value, field) {
  domainAssert(
    typeof value === "string" &&
      TIMESTAMP_WITH_ZONE.test(value) &&
      Number.isFinite(Date.parse(value)),
    "CROP_CYCLE_TIMESTAMP_INVALID",
    `${field} must be an ISO timestamp with a time zone.`,
  );
  return value;
}

function requiredRevision(value) {
  domainAssert(
    Number.isSafeInteger(value) && value > 0,
    "CROP_CYCLE_REVISION_INVALID",
    "revision must be a positive integer.",
  );
  return value;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}
