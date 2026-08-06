import {
  ALLOWED_CULTIVATION_MODES,
  Crop,
  CultivationMode,
  RAW_WEIGHT_BY_TIER,
} from "../domain/constants.js";
import { DomainError } from "../domain/errors.js";

const SCIENTIFIC_USES = new Set(["DEVIATION", "SINGLE_TARGET", "DISPLAY_ONLY"]);
const FORECAST_METRICS = new Set([
  "minTemperature",
  "maxTemperature",
  "precipitationProbability",
  "precipitationAmount",
  "windSpeed",
]);
const COMPARISON_OPERATORS = new Set(["GT", "GTE", "LT", "LTE", "BETWEEN"]);
const SEVERITIES = new Set(["INFO", "CAUTION", "WARNING"]);

export function validateRuleRegistry(rules) {
  if (!Array.isArray(rules)) {
    return {
      validRules: [],
      invalidRules: [
        {
          ruleId: null,
          code: "INVALID_RULE_REGISTRY",
          errors: ["rule registry must be an array"],
          rule: rules,
        },
      ],
    };
  }

  const validRules = [];
  const invalidRules = [];
  const seenIds = new Set();

  for (const rule of rules) {
    const errors = validateRule(rule);
    const ruleId =
      rule !== null && typeof rule === "object" && typeof rule.ruleId === "string"
        ? rule.ruleId
        : null;
    if (ruleId && seenIds.has(ruleId)) errors.push("ruleId must be unique");
    if (ruleId) seenIds.add(ruleId);

    if (errors.length > 0) {
      invalidRules.push({
        ruleId,
        code: "INVALID_RULE_SCHEMA",
        errors,
        rule,
      });
    } else {
      validRules.push(freezeRule(rule));
    }
  }

  const conflictIndexes = findEvaluationConflicts(validRules);
  const conflictRules = [];
  const conflictFreeRules = validRules.filter((rule, index) => {
    if (!conflictIndexes.has(index)) return true;
    conflictRules.push({
      ruleId: rule.ruleId,
      code: "CONFLICTING_RULE_EVALUATION",
      errors: [
        "rule would double-count an active metric context or mix monthly and season-aggregate evaluation",
      ],
      rule,
    });
    return false;
  });

  return {
    validRules: Object.freeze(conflictFreeRules),
    invalidRules: Object.freeze([...invalidRules, ...conflictRules]),
  };
}

export function createRuleRegistry(rules, options = {}) {
  const validation = validateRuleRegistry(rules);
  if ((options.strict ?? true) && validation.invalidRules.length > 0) {
    throw new DomainError(
      "INVALID_RULE_REGISTRY",
      "one or more rules failed the activation gate",
      {
        status: 500,
        details: validation.invalidRules.map(({ ruleId, code, errors }) => ({
          ruleId,
          code,
          errors,
        })),
      },
    );
  }

  const activeRules = validation.validRules;
  return Object.freeze({
    rules: activeRules,
    invalidRules: validation.invalidRules,
    resolve(request, module = null) {
      return activeRules.filter((rule) => {
        if (module !== null && ruleModule(rule) !== module) return false;
        return ruleMatchesRequestContext(rule, request);
      });
    },
    growthStagesFor(crop, cultivationMode) {
      return [
        ...new Set(
          activeRules
            .filter(
              (rule) =>
                rule.crop === crop &&
                rule.cultivationMode === cultivationMode &&
                rule.stage !== "ANY",
            )
            .map((rule) => rule.stage),
        ),
      ].sort();
    },
    seasonProfilesFor(crop, cultivationMode) {
      if (cultivationMode !== "OPEN_FIELD") return [];
      return [
        ...new Set(
          activeRules
            .filter(
              (rule) =>
                rule.module === "CLIMATE" &&
                rule.use !== "DISPLAY_ONLY" &&
                rule.crop === crop &&
                rule.cultivationMode === cultivationMode,
            )
            .map((rule) => rule.seasonProfileId),
        ),
      ].sort();
    },
    rulesForModule(module) {
      return activeRules.filter((rule) => ruleModule(rule) === module);
    },
  });
}

export function isForecastRiskRule(rule) {
  return (
    rule !== null &&
    typeof rule === "object" &&
    (rule.module === "FORECAST" ||
      rule.use === "FORECAST_RISK" ||
      (rule.evidenceStatus === "RISK_ONLY" &&
        "comparison" in rule &&
        "duration" in rule))
  );
}

export function rawWeightForRule(rule) {
  return RAW_WEIGHT_BY_TIER[rule?.sensitivityTier] ?? null;
}

export function ruleMatchesRequestContext(rule, input = {}) {
  const request = input?.request ?? input;
  const crop = input?.crop ?? request?.crop;
  const cultivationMode =
    input?.cultivationMode ?? request?.cultivationMode;
  const season = input?.season ?? request?.season ?? null;
  const module = ruleModule(rule);

  if (crop && rule?.crop !== crop) return false;
  if (cultivationMode && rule?.cultivationMode !== cultivationMode) {
    return false;
  }
  if (!ruleStageMatchesRequestContext(rule, input)) return false;

  if (module === "CLIMATE") {
    if (cultivationMode && cultivationMode !== "OPEN_FIELD") return false;
    if (season?.kind === "UNKNOWN" || season?.kind === "NOT_APPLICABLE") {
      return false;
    }
    if (
      season?.profileId &&
      rule?.seasonProfileId !== season.profileId
    ) {
      return false;
    }
    if (
      season?.kind === "CUSTOM" &&
      rule?.evaluationPeriod?.grain === "MONTH" &&
      !seasonMonthsForContext(input, request, season).includes(
        rule.evaluationPeriod.month,
      )
    ) {
      return false;
    }
  }

  return true;
}

export function ruleStageMatchesRequestContext(rule, input = {}) {
  const request = input?.request ?? input;
  const growthStage =
    input?.growthStage ?? request?.growthStage ?? "UNSPECIFIED";
  if (rule?.stage === "ANY") return true;
  if (
    ruleModule(rule) === "FORECAST" &&
    growthStage === "UNSPECIFIED"
  ) {
    return false;
  }
  return rule?.stage === growthStage;
}

function validateRule(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
    return ["rule must be an object"];
  }
  return isForecastRiskRule(rule)
    ? validateForecastRule(rule)
    : validateScientificRule(rule);
}

function findEvaluationConflicts(rules) {
  const conflicts = new Set();
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    const left = rules[leftIndex];
    if (isForecastRiskRule(left) || left.use === "DISPLAY_ONLY") continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < rules.length;
      rightIndex += 1
    ) {
      const right = rules[rightIndex];
      if (isForecastRiskRule(right) || right.use === "DISPLAY_ONLY") continue;
      if (!sameEvaluationScope(left, right)) continue;
      if (!stagesCanOverlap(left.stage, right.stage)) continue;
      if (left.module === "SOIL") {
        conflicts.add(leftIndex);
        conflicts.add(rightIndex);
        continue;
      }
      const leftPeriod = left.evaluationPeriod;
      const rightPeriod = right.evaluationPeriod;
      const exactPeriod =
        leftPeriod.grain === rightPeriod.grain &&
        (leftPeriod.grain === "MONTH"
          ? leftPeriod.month === rightPeriod.month
          : leftPeriod.aggregation === rightPeriod.aggregation);
      const mixesMonthlyAndAggregate = leftPeriod.grain !== rightPeriod.grain;
      if (exactPeriod || mixesMonthlyAndAggregate) {
        conflicts.add(leftIndex);
        conflicts.add(rightIndex);
      }
    }
  }
  return conflicts;
}

function sameEvaluationScope(left, right) {
  if (left.module === "SOIL" && right.module === "SOIL") {
    return (
      left.crop === right.crop &&
      left.cultivationMode === right.cultivationMode &&
      left.metric === right.metric
    );
  }
  return (
    left.module === right.module &&
    left.crop === right.crop &&
    left.cultivationMode === right.cultivationMode &&
    left.seasonProfileId === right.seasonProfileId &&
    left.metric === right.metric &&
    left.unit === right.unit
  );
}

function stagesCanOverlap(left, right) {
  return left === right || left === "ANY" || right === "ANY";
}

function validateScientificRule(rule) {
  const errors = [];
  requireText(rule, "ruleId", errors);
  requireEnum(rule, "module", ["CLIMATE", "SOIL"], errors);
  validateCropAndMode(rule, errors);
  if (rule.module === "CLIMATE") {
    requireText(rule, "seasonProfileId", errors);
  } else if (rule.seasonProfileId !== undefined) {
    requireText(rule, "seasonProfileId", errors);
  }
  validateEvaluationPeriod(rule.evaluationPeriod, errors);
  validateStage(rule.stage, errors);
  requireText(rule, "metric", errors);
  requireText(rule, "unit", errors);
  validateProvenance(rule, errors);
  requireEnum(rule, "use", [...SCIENTIFIC_USES], errors);

  if (rule.use === "DEVIATION") {
    requireEnum(rule, "evidenceStatus", ["CONFIRMED_RANGE"], errors);
    validateRange(rule.optimalRange, "optimalRange", errors);
    requireEnum(rule, "sensitivityTier", Object.keys(RAW_WEIGHT_BY_TIER), errors);
    if (typeof rule.critical !== "boolean") errors.push("critical must be boolean");
    if (rule.toleranceRange !== null && rule.toleranceRange !== undefined) {
      validateRange(rule.toleranceRange, "toleranceRange", errors);
      if (
        validRange(rule.toleranceRange) &&
        validRange(rule.optimalRange) &&
        !(
          rule.toleranceRange[0] < rule.optimalRange[0] &&
          rule.optimalRange[1] < rule.toleranceRange[1]
        )
      ) {
        errors.push(
          "toleranceRange must strictly contain optimalRange on both sides",
        );
      }
    }
  } else if (rule.use === "SINGLE_TARGET") {
    requireEnum(rule, "evidenceStatus", ["SINGLE_TARGET"], errors);
    if (!Number.isFinite(rule.target)) errors.push("target must be finite");
    requireEnum(rule, "sensitivityTier", Object.keys(RAW_WEIGHT_BY_TIER), errors);
    if (typeof rule.critical !== "boolean") errors.push("critical must be boolean");
  } else if (rule.use === "DISPLAY_ONLY") {
    requireEnum(rule, "evidenceStatus", ["UNCONFIRMED", "RISK_ONLY"], errors);
    for (const forbidden of [
      "optimalRange",
      "toleranceRange",
      "target",
      "sensitivityTier",
      "critical",
    ]) {
      if (rule[forbidden] !== undefined) {
        errors.push(`DISPLAY_ONLY must not contain ${forbidden}`);
      }
    }
  }

  return errors;
}

function validateForecastRule(rule) {
  const errors = [];
  requireText(rule, "ruleId", errors);
  validateCropAndMode(rule, errors);
  validateStage(rule.stage, errors);
  requireEnum(rule, "metric", [...FORECAST_METRICS], errors);
  requireText(rule, "unit", errors);
  validateProvenance(rule, errors);
  requireEnum(rule, "severity", [...SEVERITIES], errors);
  requireText(rule, "actionId", errors);
  requireEnum(rule, "evidenceStatus", ["RISK_ONLY"], errors);
  validateComparison(rule.comparison, errors);
  validateDuration(rule.duration, errors);
  if (rule.guidance !== undefined) {
    validateGuidance(rule.guidance, errors);
  }
  return errors;
}

function validateGuidance(guidance, errors) {
  if (
    guidance === null ||
    typeof guidance !== "object" ||
    Array.isArray(guidance)
  ) {
    errors.push("guidance must be an object");
    return;
  }
  requireText(guidance, "headline", errors);
  requireText(guidance, "reason", errors);
  if (
    !Array.isArray(guidance.actions) ||
    guidance.actions.length === 0 ||
    guidance.actions.some(
      (action) => typeof action !== "string" || action.trim() === "",
    )
  ) {
    errors.push("guidance.actions must contain non-empty action text");
  }
  requireText(guidance, "sourceTitle", errors);
  requireText(guidance, "sourceUrl", errors);
  if (
    typeof guidance.sourceUrl === "string" &&
    guidance.sourceUrl.trim() !== "" &&
    !isHttpUrl(guidance.sourceUrl)
  ) {
    errors.push("guidance.sourceUrl must be an absolute HTTP(S) URL");
  }
  requireText(guidance, "reviewedAt", errors);
  if (
    typeof guidance.reviewedAt === "string" &&
    guidance.reviewedAt.trim() !== "" &&
    !isIsoDate(guidance.reviewedAt)
  ) {
    errors.push("guidance.reviewedAt must be an ISO calendar date");
  }
}

function validateCropAndMode(rule, errors) {
  requireEnum(rule, "crop", Crop, errors);
  requireEnum(rule, "cultivationMode", CultivationMode, errors);
  if (
    Crop.includes(rule.crop) &&
    CultivationMode.includes(rule.cultivationMode) &&
    !ALLOWED_CULTIVATION_MODES[rule.crop].includes(rule.cultivationMode)
  ) {
    errors.push("crop and cultivationMode combination is not allowed");
  }
}

function validateProvenance(rule, errors) {
  requireText(rule, "sourceTitle", errors);
  requireText(rule, "sourceUrl", errors);
  if (
    typeof rule.sourceUrl === "string" &&
    rule.sourceUrl.trim() !== "" &&
    !isHttpUrl(rule.sourceUrl)
  ) {
    errors.push("sourceUrl must be an absolute HTTP(S) URL");
  }
  requireText(rule, "sourcePageOrTable", errors);
  requireText(rule, "sourceVersion", errors);
  requireText(rule, "reviewedAt", errors);
  if (
    typeof rule.reviewedAt === "string" &&
    rule.reviewedAt.trim() !== "" &&
    !isIsoDate(rule.reviewedAt)
  ) {
    errors.push("reviewedAt must be an ISO calendar date");
  }
  requireText(rule, "ruleVersion", errors);
}

function validateEvaluationPeriod(period, errors) {
  if (period === null || typeof period !== "object" || Array.isArray(period)) {
    errors.push("evaluationPeriod must be an object");
    return;
  }
  if (period.grain === "MONTH") {
    if (!Number.isInteger(period.month) || period.month < 1 || period.month > 12) {
      errors.push("MONTH evaluationPeriod.month must be an integer from 1 to 12");
    }
    return;
  }
  if (period.grain === "SEASON_AGGREGATE") {
    if (!["MEAN", "SUM", "MIN", "MAX"].includes(period.aggregation)) {
      errors.push("SEASON_AGGREGATE requires a supported aggregation");
    }
    return;
  }
  errors.push("evaluationPeriod.grain is unsupported");
}

function validateComparison(comparison, errors) {
  if (
    comparison === null ||
    typeof comparison !== "object" ||
    Array.isArray(comparison)
  ) {
    errors.push("comparison must be an object");
    return;
  }
  if (!COMPARISON_OPERATORS.has(comparison.operator)) {
    errors.push("comparison.operator is unsupported");
    return;
  }
  if (comparison.operator === "BETWEEN") {
    if (
      !Number.isFinite(comparison.lower) ||
      !Number.isFinite(comparison.upper) ||
      comparison.lower >= comparison.upper
    ) {
      errors.push("BETWEEN requires finite lower < upper");
    }
  } else if (!Number.isFinite(comparison.threshold)) {
    errors.push("comparison.threshold must be finite");
  }
}

function validateDuration(duration, errors) {
  if (duration === null || typeof duration !== "object" || Array.isArray(duration)) {
    errors.push("duration must be an object");
    return;
  }
  if (duration.kind === "ANY_DAY") return;
  if (duration.kind === "CONSECUTIVE_DAYS") {
    if (!Number.isInteger(duration.count) || duration.count <= 0) {
      errors.push("CONSECUTIVE_DAYS count must be a positive integer");
    }
    return;
  }
  if (duration.kind === "WINDOW_SUM") {
    if (!Number.isInteger(duration.days) || duration.days <= 0) {
      errors.push("WINDOW_SUM days must be a positive integer");
    }
    return;
  }
  errors.push("duration.kind is unsupported");
}

function validateStage(stage, errors) {
  if (typeof stage !== "string" || stage.trim() === "") {
    errors.push("stage must be a non-empty string or ANY");
  }
}

function validateRange(value, field, errors) {
  if (!validRange(value)) {
    errors.push(`${field} must contain finite lower < upper`);
  }
}

function validRange(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] < value[1]
  );
}

function requireText(object, field, errors) {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    errors.push(`${field} is required`);
  }
}

function requireEnum(object, field, values, errors) {
  if (!values.includes(object[field])) errors.push(`${field} is unsupported`);
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function ruleModule(rule) {
  return isForecastRiskRule(rule) ? "FORECAST" : rule.module;
}

function seasonMonthsForContext(input, request, season) {
  const months =
    input?.seasonMonths ?? request?.seasonMonths ?? season?.months;
  if (Array.isArray(months)) return months;
  if (
    !Number.isInteger(season?.startMonth) ||
    !Number.isInteger(season?.endMonth)
  ) {
    return [];
  }
  if (season.startMonth <= season.endMonth) {
    return Array.from(
      { length: season.endMonth - season.startMonth + 1 },
      (_, index) => season.startMonth + index,
    );
  }
  return [
    ...Array.from(
      { length: 13 - season.startMonth },
      (_, index) => season.startMonth + index,
    ),
    ...Array.from({ length: season.endMonth }, (_, index) => index + 1),
  ];
}

function freezeRule(rule) {
  return deepFreeze(structuredClone(rule));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
