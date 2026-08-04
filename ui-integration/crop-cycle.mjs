const DAY_MS = 86_400_000;

const GROWTH_PROGRESS_RATIOS = Object.freeze({
  early: 0.18,
  middle: 0.5,
  harvest: 0.86,
  unknown: 0.35,
  flowering: 0.05,
  "tuber-bulking": 0.62,
  "flower-differentiation": 0.65,
});

const CROP_CYCLES = Object.freeze({
  apple: cycleDefinition({
    defaultAnchorType: "FLOWERING",
    planningAnchorType: "SEASON_START",
    anchorOptions: [["FLOWERING", "개화 시작일"], ["SEASON_START", "시즌 시작일"]],
    preparationByAnchor: { FLOWERING: [7, 30], SEASON_START: [14, 45] },
    harvestByAnchor: { FLOWERING: [125, 190], SEASON_START: [230, 310] },
  }),
  pear: cycleDefinition({
    defaultAnchorType: "FLOWERING",
    planningAnchorType: "SEASON_START",
    anchorOptions: [["FLOWERING", "개화 시작일"], ["SEASON_START", "시즌 시작일"]],
    preparationByAnchor: { FLOWERING: [7, 30], SEASON_START: [14, 45] },
    harvestByAnchor: { FLOWERING: [145, 185], SEASON_START: [220, 310] },
  }),
  cucumber: cycleDefinition({
    defaultAnchorType: "TRANSPLANTING",
    planningAnchorType: "TRANSPLANTING",
    anchorOptions: [
      ["SOWING", "파종일"],
      ["TRANSPLANTING", "정식일"],
    ],
    preparationByAnchor: { TRANSPLANTING: [14, 35], SOWING: [14, 35] },
    harvestByAnchor: { TRANSPLANTING: [45, 75], SOWING: [65, 95] },
    harvestSeasonByAnchor: { TRANSPLANTING: [45, 240], SOWING: [65, 270] },
  }),
  potato: cycleDefinition({
    defaultAnchorType: "SOWING",
    planningAnchorType: "SOWING",
    anchorOptions: [["SOWING", "파종일"]],
    preparationByAnchor: { SOWING: [20, 35] },
    harvestByAnchor: { SOWING: [70, 140] },
  }),
  lettuce: cycleDefinition({
    defaultAnchorType: "TRANSPLANTING",
    planningAnchorType: "TRANSPLANTING",
    anchorOptions: [
      ["SOWING", "파종일"],
      ["TRANSPLANTING", "정식일"],
    ],
    preparationByAnchor: { TRANSPLANTING: [7, 21], SOWING: [7, 21] },
    harvestByAnchor: { TRANSPLANTING: [27, 70], SOWING: [52, 100] },
  }),
});

function cycleDefinition(value) {
  return Object.freeze({
    ...value,
    anchorOptions: Object.freeze(
      value.anchorOptions.map(([valueKey, label]) => Object.freeze({ value: valueKey, label })),
    ),
    preparationByAnchor: Object.freeze(
      Object.fromEntries(
        Object.entries(value.preparationByAnchor).map(([key, range]) => [
          key,
          Object.freeze([...range]),
        ]),
      ),
    ),
    harvestByAnchor: Object.freeze(
      Object.fromEntries(Object.entries(value.harvestByAnchor).map(([key, range]) => [key, Object.freeze([...range])])),
    ),
    harvestSeasonByAnchor: Object.freeze(
      Object.fromEntries(
        Object.entries(value.harvestSeasonByAnchor ?? value.harvestByAnchor)
          .map(([key, range]) => [key, Object.freeze([...range])]),
      ),
    ),
  });
}

export function cropCycleAnchorOptions(crop, situation = "growing") {
  if (situation === "planning") {
    const definition = definitionFor(crop);
    const anchor = definition.anchorOptions.find(({ value }) => value === definition.planningAnchorType);
    return [{ ...anchor, label: `예정 ${anchor.label}` }];
  }
  return [...definitionFor(crop).anchorOptions];
}

export function createDefaultCropCycleInput({
  crop,
  situation = "growing",
  date = new Date(),
  growth = "unknown",
  seasonId,
}) {
  const definition = definitionFor(crop);
  const cropKey = normalizeCrop(crop);
  const today = dateKey(date);
  const anchorType = situation === "planning"
    ? definition.planningAnchorType
    : definition.defaultAnchorType;
  const harvestRange = definition.harvestByAnchor[anchorType];
  const ratio = GROWTH_PROGRESS_RATIOS[growth] ?? GROWTH_PROGRESS_RATIOS.unknown;
  const expectedElapsedDays = situation === "planning"
    ? 0
    : Math.round(((harvestRange[0] + harvestRange[1]) / 2) * ratio);
  const anchorDate = addDays(dateValue(today), -expectedElapsedDays);
  return {
    seasonId: normalizeSeasonId(
      seasonId ?? `season-${anchorDate.slice(0, 4)}-${cropKey}-${anchorDate.replaceAll("-", "")}`,
    ),
    anchorType,
    anchorDate,
    status: situation === "planning" ? "PLANNING" : "ACTIVE",
  };
}

export function normalizeCropCycleInput(input, { crop, situation } = {}) {
  const definition = definitionFor(crop);
  if (!input || typeof input !== "object") {
    throw new TypeError("재배 기준일을 확인해 주세요.");
  }
  const status = String(input.status ?? "").trim().toUpperCase();
  const allowedStatuses = new Set(["PLANNING", "ACTIVE", "COMPLETED"]);
  if (!allowedStatuses.has(status)) {
    throw new TypeError("재배 상태를 확인해 주세요.");
  }
  if (situation === "planning" && status !== "PLANNING") {
    throw new TypeError("재배 준비 상태를 확인해 주세요.");
  }
  if (situation === "growing" && status === "PLANNING") {
    throw new TypeError("재배 중 상태를 확인해 주세요.");
  }
  const anchorType = String(input.anchorType ?? "").trim().toUpperCase();
  const allowedAnchors = new Set(definition.anchorOptions.map(({ value }) => value));
  if (!allowedAnchors.has(anchorType)) {
    throw new TypeError("파종·정식·개화 중 기준일 종류를 확인해 주세요.");
  }
  const anchorDate = String(input.anchorDate ?? "").trim();
  if (!isDateKey(anchorDate)) {
    throw new TypeError("재배 기준일을 날짜로 입력해 주세요.");
  }
  if (
    situation === "growing" &&
    status !== "COMPLETED" &&
    anchorDate > dateKey(new Date())
  ) {
    throw new TypeError("이미 재배 중인 작물의 기준일은 오늘 이후일 수 없습니다.");
  }
  return {
    seasonId: normalizeSeasonId(input.seasonId),
    anchorType,
    anchorDate,
    status,
  };
}

export function projectLocalCropCycle({
  crop,
  input,
  asOf = new Date(),
  sourceLabel = "입력 기준 예상",
}) {
  const cropKey = normalizeCrop(crop);
  const definition = definitionFor(cropKey);
  const normalized = normalizeCropCycleInput(input, { crop: cropKey });
  const localBase = {
    ...normalized,
    source: "LOCAL_PREVIEW",
    sourceLabel,
    remoteState: "UNAVAILABLE",
    confidence: "LOCAL_ESTIMATE",
    estimated: true,
  };

  if (normalized.status === "COMPLETED") {
    return {
      ...localBase,
      progress: progressValue(100, 100),
      harvestWindow: harvestWindow(definition, normalized),
      harvestSeasonWindow: harvestSeasonWindow(definition, normalized),
      currentMilestone: localMilestone("시즌 종료", normalized.anchorDate),
      nextMilestone: null,
      preparationStartsOn: preparationDate(definition, normalized),
    };
  }

  if (normalized.status === "PLANNING") {
    const plannedDatePassed =
      dateValue(dateKey(asOf)) >= dateValue(normalized.anchorDate);
    return {
      ...localBase,
      progress: progressValue(0, 0),
      harvestWindow: harvestWindow(definition, normalized),
      harvestSeasonWindow: harvestSeasonWindow(definition, normalized),
      currentMilestone: localMilestone(
        plannedDatePassed ? "예정일 지남 · 시작 여부 확인" : "재배 시작 전 준비",
        plannedDatePassed ? normalized.anchorDate : cultivationPreparationDate(normalized),
      ),
      nextMilestone: localMilestone(
        plannedDatePassed ? "재배 시작 상태로 전환" : "재배 시작 예정",
        normalized.anchorDate,
      ),
      preparationStartsOn: preparationDate(definition, normalized),
    };
  }

  const baseDate = baseDateFor(definition, normalized);
  const elapsedDays = Math.floor((dateValue(dateKey(asOf)) - baseDate) / DAY_MS);
  const [harvestStart, harvestEnd] = harvestRangeFor(definition, normalized);
  const progress = progressRange(elapsedDays, harvestStart, harvestEnd);
  const milestones = localMilestones(definition, normalized);
  const currentIndex = lastIndexAtOrBefore(milestones, elapsedDays);
  const currentMilestone = currentIndex < 0
    ? localMilestone("재배 준비", preparationDate(definition, normalized).earliest)
    : localMilestone(
        milestones[currentIndex].label,
        addDays(baseDate, milestones[currentIndex].offset),
        addDays(
          baseDate,
          Math.max(
            milestones[currentIndex].offset,
            (milestones[currentIndex + 1]?.offset ?? harvestEnd) - 1,
          ),
        ),
      );
  const next = milestones[currentIndex + 1] ?? null;
  return {
    ...localBase,
    progress,
    harvestWindow: harvestWindow(definition, normalized),
    harvestSeasonWindow: harvestSeasonWindow(definition, normalized),
    currentMilestone,
    nextMilestone: next
      ? localMilestone(next.label, addDays(baseDate, next.offset))
      : null,
    preparationStartsOn: preparationDate(definition, normalized),
  };
}

export function createCropCycleAdapter({ getCycle, putCycle, now = () => new Date() }) {
  if (typeof getCycle !== "function" || typeof putCycle !== "function") {
    throw new TypeError("crop cycle API adapter functions are required");
  }

  const resolve = async (operation, scope) => {
    const input = normalizeCropCycleInput(scope.input, { crop: scope.crop });
    try {
      let response;
      if (operation === "load") {
        response = await getCycle(scope.farmId, scope.cropId, input.seasonId);
      } else {
        try {
          response = await putCycle(scope.farmId, scope.cropId, {
            ...input,
            userConfirmed: true,
          });
        } catch (error) {
          if (input.status !== "COMPLETED" || error?.code !== "CROP_CYCLE_NOT_FOUND") {
            throw error;
          }
          // 이전 버전에서 로컬에만 있던 시즌은 먼저 활성 기록을 생성한 뒤
          // 같은 seasonId를 완료한다. 완료 확인 규칙은 그대로 유지한다.
          await putCycle(scope.farmId, scope.cropId, {
            ...input,
            status: "ACTIVE",
            userConfirmed: true,
          });
          response = await putCycle(scope.farmId, scope.cropId, {
            ...input,
            userConfirmed: true,
          });
        }
      }
      return normalizeServerProjection(response?.cycle, input);
    } catch (error) {
      if (canUseLocalFallback(error, operation)) {
        return projectLocalCropCycle({ crop: scope.crop, input, asOf: now() });
      }
      throw error;
    }
  };

  return Object.freeze({
    load(scope) { return resolve("load", scope); },
    save(scope) { return resolve("save", scope); },
  });
}

function canUseLocalFallback(error, operation) {
  const status = Number(error?.status ?? 0);
  const code = String(error?.code ?? "");
  if (status >= 500) return true;
  if (operation === "load" && status === 404) return true;
  if (status === 0) {
    return !code || ["NETWORK_ERROR", "REQUEST_TIMEOUT"].includes(code);
  }
  return false;
}

function normalizeServerProjection(cycle, input) {
  if (!cycle || typeof cycle !== "object") throw new TypeError("invalid cycle projection");
  const progress = normalizeProgress(cycle.progress);
  const harvest = cycle.harvestWindow;
  if (!isDateKey(harvest?.earliest) || !isDateKey(harvest?.latest)) {
    throw new TypeError("invalid harvest window");
  }
  const preparationStartsOn = dateRange(cycle.preparationStartsOn);
  const harvestSeason = cycle.harvestSeasonWindow ?? cycle.harvestWindow;
  return {
    ...input,
    farmId: String(cycle.farmId ?? ""),
    cropId: String(cycle.cropId ?? ""),
    userConfirmed: cycle.userConfirmed === true,
    completedOn: cycle.completedOn ?? null,
    revision: Number.isInteger(cycle.revision) ? cycle.revision : null,
    progress,
    harvestWindow: { earliest: harvest.earliest, latest: harvest.latest },
    harvestSeasonWindow: dateRange(harvestSeason),
    currentMilestone: milestoneProjection(cycle.currentMilestone),
    nextMilestone: cycle.nextMilestone == null
      ? null
      : milestoneProjection(cycle.nextMilestone),
    preparationStartsOn,
    confidence: String(cycle.confidence ?? "SERVER"),
    estimated: cycle.estimated === true,
    uncertaintyFactors: Array.isArray(cycle.uncertaintyFactors)
      ? cycle.uncertaintyFactors.map(String)
      : [],
    ruleVersion: cycle.ruleVersion ?? null,
    evidenceVersion: cycle.evidenceVersion ?? null,
    evidenceRefs: Array.isArray(cycle.evidenceRefs)
      ? cycle.evidenceRefs.map(normalizeEvidenceRef).filter(Boolean)
      : [],
    source: "SERVER_PROJECTION",
    sourceLabel: "서버 재배일정 계산",
    remoteState: "READY",
  };
}

function normalizeEvidenceRef(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, 240) : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceId = boundedEvidenceText(value.sourceId, 200);
  const url = safeEvidenceUrl(value.url);
  const supports = Array.isArray(value.supports)
    ? [...new Set(value.supports.map((item) => boundedEvidenceText(item, 120)).filter(Boolean))].slice(0, 20)
    : [];
  if (!sourceId || !url) return null;
  return { sourceId, url, supports };
}

function boundedEvidenceText(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

function safeEvidenceUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeProgress(value) {
  if (Number.isFinite(value)) {
    const percent = clampPercent(value);
    return progressValue(percent, percent);
  }
  const minPercent = clampPercent(value?.minPercent);
  const maxPercent = clampPercent(value?.maxPercent);
  if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) {
    throw new TypeError("invalid progress range");
  }
  if (value?.actualBiologicalScore != null) {
    throw new TypeError("cycle progress cannot contain a biological score");
  }
  return progressValue(
    Math.min(minPercent, maxPercent),
    Math.max(minPercent, maxPercent),
    String(value?.kind ?? "SCHEDULE_RANGE"),
  );
}

function milestoneProjection(value) {
  if (!value || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new TypeError("invalid milestone");
  }
  return {
    certainty: String(value.certainty ?? "ESTIMATED"),
    candidates: value.candidates.map((candidate) => {
      const label = String(candidate?.label ?? "").trim();
      if (!label) throw new TypeError("invalid milestone label");
      return {
        code: String(candidate.code ?? "UNKNOWN"),
        label,
        window: dateRange(candidate.window),
      };
    }),
  };
}

function progressRange(elapsedDays, earliestHarvest, latestHarvest) {
  if (elapsedDays <= 0) return progressValue(0, 0);
  if (elapsedDays >= latestHarvest) return progressValue(100, 100);
  return progressValue(
    clampPercent(Math.floor((elapsedDays / latestHarvest) * 100)),
    clampPercent(Math.ceil((elapsedDays / earliestHarvest) * 100)),
  );
}

function harvestWindow(definition, input) {
  const baseDate = baseDateFor(definition, input);
  const range = harvestRangeFor(definition, input);
  return {
    earliest: addDays(baseDate, range[0]),
    latest: addDays(baseDate, range[1]),
  };
}

function harvestSeasonWindow(definition, input) {
  const baseDate = baseDateFor(definition, input);
  const range = definition.harvestSeasonByAnchor[input.anchorType]
    ?? harvestRangeFor(definition, input);
  return {
    earliest: addDays(baseDate, range[0]),
    latest: addDays(baseDate, range[1]),
  };
}

function preparationDate(definition, input) {
  const baseDate = baseDateFor(definition, input);
  const harvest = harvestRangeFor(definition, input);
  const [preparationMin, preparationMax] =
    definition.preparationByAnchor[input.anchorType];
  return {
    earliest: addDays(baseDate, harvest[0] - preparationMax),
    latest: addDays(baseDate, harvest[1] - preparationMin),
  };
}

function cultivationPreparationDate(input) {
  return addDays(dateValue(input.anchorDate), -14);
}

function progressValue(minPercent, maxPercent, kind = "SCHEDULE_RANGE") {
  return {
    kind,
    minPercent,
    maxPercent,
    actualBiologicalScore: null,
  };
}

function localMilestone(label, earliest, latest = earliest) {
  return {
    certainty: "ESTIMATED",
    candidates: [{
      code: "LOCAL_ESTIMATE",
      label,
      window: { earliest, latest },
    }],
  };
}

function dateRange(value) {
  const earliest = String(value?.earliest ?? "");
  const latest = String(value?.latest ?? "");
  if (!isDateKey(earliest) || !isDateKey(latest)) {
    throw new TypeError("invalid date range");
  }
  return { earliest, latest };
}

function baseDateFor(definition, input) {
  if (!definition.harvestByAnchor[input.anchorType]) {
    throw new TypeError("unsupported cycle anchor");
  }
  return dateValue(input.anchorDate);
}

function harvestRangeFor(definition, input) {
  const range = definition.harvestByAnchor[input.anchorType];
  if (!range) throw new TypeError("unsupported harvest range");
  return range;
}

function localMilestones(definition, input) {
  const [, harvestEnd] = harvestRangeFor(definition, input);
  const anchorLabel = definition.anchorOptions
    .find(({ value }) => value === input.anchorType)?.label ?? "재배 시작일";
  return [
    { offset: 0, label: anchorLabel.replace("일", "") },
    { offset: Math.max(1, Math.round(harvestEnd * 0.35)), label: "재배 중기" },
    { offset: Math.max(2, Math.round(harvestEnd * 0.7)), label: "수확 준비" },
    { offset: harvestRangeFor(definition, input)[0], label: "예상 수확 시작" },
    { offset: harvestEnd, label: "예상 수확 마무리" },
  ].sort((left, right) => left.offset - right.offset);
}

function lastIndexAtOrBefore(milestones, elapsedDays) {
  let match = -1;
  for (let index = 0; index < milestones.length; index += 1) {
    if (milestones[index].offset <= elapsedDays) match = index;
    else break;
  }
  return match;
}

function definitionFor(crop) {
  const key = normalizeCrop(crop);
  const definition = CROP_CYCLES[key];
  if (!definition) throw new TypeError("지원하지 않는 작물입니다.");
  return definition;
}

function normalizeCrop(crop) {
  return String(crop ?? "").trim().toLowerCase();
}

function normalizeSeasonId(value) {
  const seasonId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/u.test(seasonId)) {
    throw new TypeError("재배 시즌 정보를 확인해 주세요.");
  }
  return seasonId;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isDateKey(value)) throw new TypeError("invalid date");
  return new Date(`${value}T00:00:00Z`).getTime();
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid date");
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(baseDateValue, days) {
  return new Date(baseDateValue + days * DAY_MS).toISOString().slice(0, 10);
}
